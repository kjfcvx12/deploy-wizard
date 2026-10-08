import asyncio
import threading

from shared.settings import settings
from shared.database import AsyncSessionLocal
from shared.masking import mask_text
from shared.proc import Proc_Error
from shared.llm import LLM_Unavailable

from features.deploys.crud import Deploy_Crud

from features.repos.services import Repo_Service
from features.repos.scheme import Repo_App
from features.dockerfiles.services import Dockerfile_Service
from features.dockerfiles.scheme import Dockerfile_Result
from features.builds.services import Build_Service
from features.express.services import Express_Service
from features.explains.services import Explain_Service
from features.accounts.services import Aws_Account_Service, Github_Service

# 배포 파이프라인 (M3)
# 클론 -> 언어 판별(규칙) -> Dockerfile 생성(템플릿+LLM) -> 빌드 -> 푸시 -> 배포
# 자동으로 하는 것은 되돌리기 하나. 실패하면 멈추고, 원인을 설명하고, 묻는다 (기획서 03장)

PROGRESS_STATUSES=['queued', 'cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying', 'deleting']
# 이어하기에서 실패 지점 앞뒤를 가르는 순서 (다시 배포는 처음부터가 아니라 여기서부터)
STEP_ORDER=['cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying']
STEP_LABELS={'cloning': '클론', 'analyzing': '판별', 'generating': 'Dockerfile', 'building': '빌드', 'pushing': '푸시', 'deploying': '배포'}


# 로그 버퍼 - git·docker 출력은 작업 스레드에서 오므로 모아 두었다가 비동기로 DB에 쓴다
class Deploy_Log_Buffer:

    def __init__(self, d_id:int):
        self.d_id=d_id
        self.step='queued'
        self.lines:list[dict]=[]
        self.lock=threading.Lock()
        self.stopped=False

    # 로그 한 줄 추가 (스레드 안전)
    def buffer_add(self, message:str, level:str='info') -> None:
        message=mask_text(message)[:2000]
        if not message:
            return
        with self.lock:
            self.lines.append({"d_id": self.d_id, "step": self.step, "level": level, "message": message})

    # 모인 로그를 DB에 쓴다
    async def buffer_flush(self) -> None:
        with self.lock:
            lines, self.lines=self.lines, []

        if not lines:
            return

        async with AsyncSessionLocal() as db:
            await Deploy_Crud.crud_deploy_log_create_many(db, lines)
            await db.commit()

    # 1초마다 비운다
    async def buffer_flush_loop(self) -> None:
        while not self.stopped:
            await self.buffer_flush()
            await asyncio.sleep(1)
        await self.buffer_flush()


class Deploy_Pipeline:
    # 실행 중인 작업 - 참조를 잡고 있어야 중간에 사라지지 않는다
    tasks:dict[int, asyncio.Task]={}


    # 파이프라인 시작 - 같은 배포를 두 번 돌리지 않는다. start_step 을 주면 그 단계부터 (멈춘 배포를 다시 켤 때 'deploying')
    @staticmethod
    def pipeline_start(d_id:int, start_step:str|None=None) -> bool:
        running=Deploy_Pipeline.tasks.get(d_id)
        if running and not running.done():
            return False

        task=asyncio.create_task(Deploy_Pipeline.pipeline_run(d_id, start_step))
        Deploy_Pipeline.tasks[d_id]=task
        task.add_done_callback(lambda _: Deploy_Pipeline.tasks.pop(d_id, None))
        return True


    # 상태·필드 저장 - 단계마다 짧은 세션을 따로 연다
    @staticmethod
    async def pipeline_update(d_id:int, **update_data) -> None:
        async with AsyncSessionLocal() as db:
            await Deploy_Crud.crud_deploy_update(db, d_id, update_data)
            await db.commit()


    # AWS 세션 준비 (M6) - 연결된 계정 있으면 위임 세션, 없으면 기존 개발 세션 (M1~M5 그대로 동작)
    @staticmethod
    async def pipeline_get_aws_session(aws_account_id:int|None):
        async with AsyncSessionLocal() as db:
            return await Aws_Account_Service.services_aws_account_build_session(db, aws_account_id)


    # GitHub 설치 토큰 (M6) - 배포에 저장된 것은 우리 g_id 다. GitHub 의 installation_id 로 바꿔서 토큰을 받는다. 연결 없으면 None (public 클론)
    @staticmethod
    async def pipeline_get_github_token(github_installation_id:int|None):
        if not github_installation_id:
            return None

        async with AsyncSessionLocal() as db:
            return await Github_Service.services_github_token_by_g_id(db, github_installation_id)


    # ECS 역할 ARN (M6) - 연결된 계정이면 그 계정의 역할, 없으면 None 이라 .env 값을 쓴다
    @staticmethod
    async def pipeline_get_role_arns(aws_account_id:int|None):
        async with AsyncSessionLocal() as db:
            return await Aws_Account_Service.services_aws_account_role_arns(db, aws_account_id)


    # 단계 전환
    @staticmethod
    async def pipeline_step(buffer:Deploy_Log_Buffer, status:str, message:str) -> None:
        buffer.step=status
        buffer.buffer_add(message, 'cmd')
        await Deploy_Pipeline.pipeline_update(buffer.d_id, status=status)


    # 파이프라인 실행
    @staticmethod
    async def pipeline_run(d_id:int, start_step:str|None=None) -> None:
        buffer=Deploy_Log_Buffer(d_id)
        flusher=asyncio.create_task(buffer.buffer_flush_loop())

        try:
            await Deploy_Pipeline.pipeline_steps(d_id, buffer, start_step)

        except Exception as e:
            await Deploy_Pipeline.pipeline_fail(d_id, buffer, e)

        finally:
            buffer.stopped=True
            await flusher


    # 이어서 시작할 단계 - 실패 지점 앞 단계는 저장된 값이 남아 있으면 다시 하지 않는다
    @staticmethod
    async def pipeline_resume_from(d_id:int, deploy) -> str:
        if deploy.error_step not in STEP_ORDER:
            return 'cloning'
        if not deploy.commit_sha:
            return 'cloning'
        if deploy.error_step == 'analyzing':
            return 'analyzing'
        if not (deploy.language and deploy.support_level):
            return 'analyzing'
        if deploy.error_step == 'generating':
            return 'generating'
        if not deploy.dockerfile:
            return 'generating'
        if deploy.error_step == 'building':
            return 'building'

        if deploy.error_step == 'pushing' or not deploy.image_uri:
            # 빌드까지는 끝났던 경우, 또는 올려 둔 이미지를 작업 종료 때 지운 경우 - 로컬에 이미지가 남아 있으면 빌드도 건너뛴다
            image_tag=f"deploy-wizard-{d_id}:{deploy.commit_sha[:7]}"
            exists=await asyncio.to_thread(Build_Service.services_build_image_exists, image_tag)
            return 'pushing' if exists else 'building'

        return 'deploying'


    # 단계들
    @staticmethod
    async def pipeline_steps(d_id:int, buffer:Deploy_Log_Buffer, start_step:str|None=None) -> None:
        async with AsyncSessionLocal() as db:
            deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

        if not deploy:
            return

        repo_url, branch=deploy.repo_url, deploy.branch
        service_arn=deploy.service_arn
        slug=Repo_Service.services_repo_slug(repo_url)
        repo_path=settings.work_path / f"deploy_{d_id}"

        resume=start_step or await Deploy_Pipeline.pipeline_resume_from(d_id, deploy)
        resume_index=STEP_ORDER.index(resume)

        await Deploy_Pipeline.pipeline_update(d_id, error_step=None, error_msg=None, explain=None)

        if resume != 'cloning':
            buffer.step=resume
            buffer.buffer_add(f"{STEP_LABELS[resume]} 단계부터 이어서 진행합니다 (커밋 {deploy.commit_sha[:7]})", 'cmd')

        # 1. 클론 - GitHub 설치가 연결돼 있으면 그 설치의 토큰으로 (private 레포도 가능)
        if resume_index <= 0:
            await Deploy_Pipeline.pipeline_step(buffer, 'cloning', f"레포를 가져옵니다 :{repo_url}" + (f" ({branch})" if branch else ""))
            token=await Deploy_Pipeline.pipeline_get_github_token(deploy.github_installation_id)
            commit_sha=await asyncio.to_thread(Repo_Service.services_repo_clone, repo_url, branch, repo_path, buffer.buffer_add, token)
            buffer.buffer_add(f"커밋 {commit_sha[:7]}")
            await Deploy_Pipeline.pipeline_update(d_id, commit_sha=commit_sha)
        else:
            commit_sha=deploy.commit_sha

        # 2. 언어 판별 (규칙)
        if resume_index <= 1:
            await Deploy_Pipeline.pipeline_step(buffer, 'analyzing', "매니페스트로 언어를 판별합니다")
            detect=await asyncio.to_thread(Repo_Service.services_repo_detect, repo_path)
            app_path=repo_path if detect.app_dir == "." else repo_path / detect.app_dir

            level_label="정식 지원" if detect.support_level == "official" else "실험 지원"
            buffer.buffer_add(f"{detect.language} ({level_label}) · {detect.app_dir}/{detect.manifest}")
            for other in detect.other_apps:
                buffer.buffer_add(f"다른 앱도 발견했습니다 :{other.app_dir} ({other.language}) - 지금은 하나만 배포합니다", 'warn')

            for note in await asyncio.to_thread(Repo_Service.services_repo_normalize, app_path):
                buffer.buffer_add(note, 'warn')

            await Deploy_Pipeline.pipeline_update(d_id, language=detect.language, support_level=detect.support_level,
                                                  app_dir=detect.app_dir)
        else:
            detect=Repo_App(language=deploy.language, support_level=deploy.support_level,
                            app_dir=deploy.app_dir or ".", manifest="")
            app_path=repo_path if detect.app_dir == "." else repo_path / detect.app_dir

        # 3. Dockerfile 생성 (템플릿 + LLM)
        if resume_index <= 2:
            await Deploy_Pipeline.pipeline_step(buffer, 'generating', "Dockerfile을 준비합니다")
            result=await Dockerfile_Service.services_dockerfile_generate(app_path, detect, repo_url, commit_sha)
            await asyncio.to_thread(Dockerfile_Service.services_dockerfile_write, app_path, result)

            buffer.buffer_add(f"출처 {result.source}" + (" (캐시)" if result.cached else "") + f" · 포트 {result.port}")
            if result.reason:
                buffer.buffer_add(result.reason, 'warn' if result.source == 'template_rule' else 'info')

            await Deploy_Pipeline.pipeline_update(d_id, dockerfile=result.dockerfile, dockerfile_source=result.source,
                                                  port=result.port, health_check_path=result.health_check_path, fix_count=0)
        else:
            result=Dockerfile_Result(dockerfile=deploy.dockerfile, port=deploy.port,
                                     health_check_path=deploy.health_check_path or "/", source=deploy.dockerfile_source)
            await asyncio.to_thread(Dockerfile_Service.services_dockerfile_write, app_path, result)

        # 4. 빌드 - 실패하면 Dockerfile만 자가수정 (정식 2회, 실험 1회)
        image_tag=f"deploy-wizard-{d_id}:{commit_sha[:7]}"
        fix_limit=settings.fix_limit_official if detect.support_level == "official" else settings.fix_limit_experimental
        fix_count=deploy.fix_count if resume_index == 3 else 0

        if resume_index <= 3:
            await Deploy_Pipeline.pipeline_step(buffer, 'building', "이미지를 빌드합니다 (linux/amd64)")

            while True:
                try:
                    await asyncio.to_thread(Build_Service.services_build_image, app_path, image_tag,
                                            detect.support_level, buffer.buffer_add)
                    break

                except Proc_Error as e:
                    # 레포에 원래 있던 Dockerfile은 사용자 코드다. 고치지 않는다
                    if result.source == 'repo' or fix_count >= fix_limit:
                        raise

                    try:
                        result=await Dockerfile_Service.services_dockerfile_fix(result, e.output, detect)
                    except (LLM_Unavailable, ValueError) as fix_error:
                        buffer.buffer_add(f"자가수정을 할 수 없습니다 :{fix_error}", 'warn')
                        raise e

                    fix_count+=1
                    buffer.buffer_add(f"빌드 실패 -> Dockerfile 자가수정 {fix_count}/{fix_limit} :{result.reason}", 'warn')
                    await asyncio.to_thread(Dockerfile_Service.services_dockerfile_write, app_path, result)
                    await Deploy_Pipeline.pipeline_update(d_id, dockerfile=result.dockerfile, dockerfile_source=result.source,
                                                          port=result.port, health_check_path=result.health_check_path,
                                                          fix_count=fix_count)
        else:
            buffer.buffer_add(f"이미 빌드된 이미지를 그대로 씁니다 :{image_tag}")

        # 5. ECR 푸시
        session=await Deploy_Pipeline.pipeline_get_aws_session(deploy.aws_account_id)

        if resume_index <= 4:
            await Deploy_Pipeline.pipeline_step(buffer, 'pushing', "ECR에 이미지를 올립니다")
            repository_name=f"deploy-wizard/{slug}-{d_id}"
            image_uri=await asyncio.to_thread(Build_Service.services_build_push, session, image_tag, repository_name,
                                              commit_sha[:7], buffer.buffer_add)
            buffer.buffer_add(image_uri)
            await Deploy_Pipeline.pipeline_update(d_id, image_uri=image_uri, repository_name=repository_name)
        else:
            image_uri, repository_name=deploy.image_uri, deploy.repository_name
            buffer.buffer_add(f"이미 올린 이미지를 그대로 씁니다 :{image_uri}")

        # 6. Express Mode 배포 - 이미 서비스가 있으면 새 이미지로 갈아끼운다
        if service_arn:
            await Deploy_Pipeline.pipeline_step(buffer, 'deploying', "기존 서비스에 새 버전을 배포합니다")
            await asyncio.to_thread(Express_Service.services_express_update, session, service_arn, image_uri,
                                    result.port, result.health_check_path)
        else:
            await Deploy_Pipeline.pipeline_step(buffer, 'deploying', "ECS Express Mode 서비스를 만듭니다")
            service_name=f"dw-{slug}-{d_id}"
            role_arns=await Deploy_Pipeline.pipeline_get_role_arns(deploy.aws_account_id)
            created=await asyncio.to_thread(Express_Service.services_express_create, session, service_name, image_uri,
                                            result.port, result.health_check_path, role_arns=role_arns)
            service_arn=created.service_arn
            # arn은 받자마자 저장한다. 이후에 실패해도 정리할 수 있어야 한다
            await Deploy_Pipeline.pipeline_update(d_id, service_name=created.service_name or service_name,
                                                  service_arn=service_arn)

        status=await asyncio.to_thread(Express_Service.services_express_wait, session, service_arn, buffer.buffer_add)

        buffer.step='running'
        buffer.buffer_add(f"배포 완료 :{status.endpoint}", 'cmd')
        await Deploy_Pipeline.pipeline_update(d_id, status='running', endpoint=status.endpoint)

        await asyncio.to_thread(Build_Service.services_build_remove_local, [image_tag, image_uri])


    # 실패 처리 - 멈추고, 원인을 한국어로 설명한다. 리소스는 지우지 않는다
    @staticmethod
    async def pipeline_fail(d_id:int, buffer:Deploy_Log_Buffer, error:Exception) -> None:
        error_step=buffer.step
        error_msg=mask_text(str(error))[:4000]
        buffer.buffer_add(f"실패 :{error_msg}", 'error')

        log_tail=mask_text(getattr(error, "output", "") or "")[-6000:]

        try:
            explain=await Explain_Service.services_explain_error(error_step, error_msg, log_tail)
            explain_json=explain.model_dump_json()
            buffer.buffer_add(f"해설 출처 {explain.source}" + (" (캐시)" if explain.cached else ""))
        except Exception:
            explain_json=None

        await Deploy_Pipeline.pipeline_update(d_id, status='failed', error_step=error_step,
                                              error_msg=error_msg, explain=explain_json)
        await Deploy_Pipeline.pipeline_record_issue(d_id, error_step, error_msg, explain_json)


    # 문제 이력 남기기 - 다시 배포해도 지난 실패를 모아서 볼 수 있게
    @staticmethod
    async def pipeline_record_issue(d_id:int, step:str, error_msg:str, explain_json:str|None) -> None:
        async with AsyncSessionLocal() as db:
            await Deploy_Crud.crud_deploy_issue_create(db, d_id, step, error_msg, explain_json)
            await db.commit()


    # 서버가 꺼지면서 끊긴 배포 정리 - 시작할 때 한 번
    @staticmethod
    async def pipeline_recover() -> int:
        error_msg="서버가 재시작되어 작업이 중단되었습니다. [다시 배포]로 이어서 할 수 있습니다."

        async with AsyncSessionLocal() as db:
            stuck=await Deploy_Crud.crud_deploy_get_by_status(db, PROGRESS_STATUSES)

            for deploy in stuck:
                step=deploy.status
                await Deploy_Crud.crud_deploy_update(db, deploy.d_id, {
                    "error_step": step,
                    "error_msg": error_msg,
                    "status": "failed",
                })
                await Deploy_Crud.crud_deploy_issue_create(db, deploy.d_id, step, error_msg, None)

            await db.commit()
            return len(stuck)
