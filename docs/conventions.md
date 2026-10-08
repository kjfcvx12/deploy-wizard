# 컨벤션

코드는 기존 코드처럼 읽혀야 한다. 아래는 이 프로젝트가 따르는 스타일이다 (출처: `middle_project_4`의 `kjfcvx12` 백엔드).

## 파이썬

### 네이밍

| 대상 | 규칙 | 예 |
|------|------|-----|
| 클래스 | Pascal_Snake | `Deploy_Service`, `Deploy_Crud`, `Deploy_Log` |
| 스키마 | `<도메인>_Base/_Create/_Update/_In_DB/_Read` | `Deploy_Create`, `Deploy_Read` |
| 함수 | `<계층>_<도메인>_<동작>` | `router_deploy_create`, `services_deploy_create`, `crud_deploy_get_by_d_id` |
| PK / FK | 테이블 약어 + `_id` | `d_id`, `d_l_id` |
| 변수 | `db_<도메인>`, `new_…`, `update_…`, `result` | `db_deploy`, `new_deploy` |
| 파일 | 계층 이름 | `models.py`, `scheme.py`, `crud.py`, `services.py`, `router.py` |

Pydantic 폴더·파일 이름은 `schemas`가 아니라 **`scheme`**.

### 형태

```python
class Deploy_Service:

    # 배포 생성 - 기록을 만들고 파이프라인을 띄운다
    @staticmethod
    async def services_deploy_create(db:AsyncSession, deploy:Deploy_Create):
        try:
            new_deploy=await Deploy_Crud.crud_deploy_create(db, deploy)

            await db.commit()
            await db.refresh(new_deploy)
            return new_deploy

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"배포 등록 실패 :{e}")
```

- Service·Crud는 클래스 + 전부 `@staticmethod`. 인스턴스를 만들지 않는다.
- 첫 인자: DB를 쓰면 `db: AsyncSession`, AWS를 쓰면 `session`.
- **CRUD는 `flush()`까지만.** `commit` / `refresh` / `rollback`은 Service에서.
- Service의 예외 처리는 위 형태로 고정: `except HTTPException: raise` → `except Exception as e: rollback + HTTPException(detail=f"… 실패 :{e}")`.
- 없으면 Service에서 `HTTPException(status.HTTP_404_NOT_FOUND, detail='한국어 메시지')`.
- 모델은 SQLAlchemy 2.0 `Mapped` / `mapped_column`. 허용 값은 컬럼 아래 주석으로 (`# queued|cloning|…`).
- 쿼리는 괄호 체이닝, `result.scalars().first()` / `.all()`.
- 라우터: `router=APIRouter(prefix='/api/deploys',tags=['Deploy'])`, `response_model=` 지정.
- 설정: `Field(기본값, alias="ENV_NAME")` + `@property` 파생값 + 모듈 끝 전역 `settings=Settings()`.

### 표기

- 모든 함수 위에 **한 줄 한국어 주석**. docstring은 쓰지 않는다. 단계는 `# 1. 클론`.
- 설계 근거는 `(기획서 NN장)`으로 남긴다.
- 사용자에게 보이는 메시지는 전부 한국어.
- 타입힌트: `int | None`, `list[Deploy]`, 반환 타입 표기.
- 절대 임포트(`from features.deploys.crud import Deploy_Crud`), 임포트 묶음 사이 빈 줄, 함수 사이 빈 줄 2개.
- `=` 주변 공백은 기존 파일을 따른다. 포매터로 일괄 정리하지 않는다.

### 이 프로젝트에서 추가된 규칙

- AWS 함수는 `session`을 주입받는다. 전역 클라이언트 금지.
- 외부 명령은 `shared.proc.proc_run(인자 리스트)`. `shell=True`, `os.system` 금지.
- LLM 호출은 `LLM_Client.llm_parse(system, prompt, 스키마)`만. `LLM_Unavailable`을 잡아 규칙 기반으로 넘어간다.
- DB·LLM·로그로 나가는 문자열은 `mask_text`를 거친다.

## 화면 (React)

- 위치: `features/<기능>/ui/`. 컴포넌트는 `PascalCase.jsx`, 그 외는 `camelCase.js`.
- 서버 호출은 기능마다 `ui/api.js` 한 파일. 라우터와 1:1로 맞춘다.
- 서버 필드 이름은 그대로 쓴다 (`d_id`, `repo_url`). 화면에서 camelCase로 바꾸지 않는다.
- 색·간격은 `shared/ui/styles.css`의 CSS 변수만 쓴다. 컴포넌트에 색을 하드코딩하지 않는다.
- 상태값 문자열은 `features/deploys/ui/constants.js`에서만 정의한다.
- 폴링은 `useEffect` 안에서 `alive` 플래그와 `clearTimeout`으로 정리한다.

## Git

- 브랜치: `{type}/{기능}-{설명}` — `feat/deploys-redeploy`, `fix/express-wait-timeout`
- 커밋: Conventional Commits, 본문은 한국어 — `feat(deploys): 실패 시 한국어 해설 저장`
- `.env`, `data/`, `dist/`, `node_modules/`는 커밋하지 않는다.
- API를 바꾸면 `docs/api-spec.md`를 같은 커밋에서 고친다.

## 테스트

- `tests/test_<대상>.py`, 함수는 `test_<도메인>_<무엇>`.
- 실제 AWS·LLM·Docker를 부르지 않는다. 경계는 `monkeypatch`로 막는다.
- 보안 규칙(주소 검증, 제외 필터, 템플릿 주입 차단, 마스킹)에는 반드시 테스트를 둔다.
