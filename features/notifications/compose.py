import json
from dataclasses import dataclass

from shared.settings import settings

from features.notifications.dispatch import dispatch_scrub

# 알림 글 만들기 - 제목·본문(앱 안·메일 공통)·푸시 한 줄. 모든 글은 마스킹을 거친다 (Hard rule 6)
# 본문 순서: 무슨 일 -> 왜 -> 어디를 고치나 -> 자동으로 한 일과 결과 -> 앱 링크 (docs/app-web/04-api-spec.md 7장)

TITLE_MAX=200
PUSH_LINE_MAX=120
DETAIL_MAX=120

ACTION_LABELS={'restart': '서비스 다시 시작', 'rollback': '이전 정상 버전으로 되돌림'}
RESULT_LABELS={'running': '진행 중', 'ok': '성공', 'failed': '실패'}


# 한 통의 알림 - 제목, 본문, 푸시 한 줄, 바로가기 링크
@dataclass
class Composed:
    title: str
    body: str
    push_line: str
    link: str


# 앱 링크 - APP_LINK_BASE 뒤에 경로를 붙인다 (base 가 / 로 끝나지 않을 때만 / 를 더한다)
def compose_link(path:str) -> str:
    base=settings.app_link_base
    return f"{base}{path}" if base.endswith("/") else f"{base}/{path}"


# 서비스 이름 - 서비스 이름이 없으면 레포 주소의 마지막 두 마디, 그것도 없으면 번호
def compose_service_name(deploy) -> str:
    if deploy.service_name:
        return dispatch_scrub(deploy.service_name)

    parts=[part for part in (deploy.repo_url or "").replace(".git", "").split("/") if part]
    if len(parts) >= 2:
        return dispatch_scrub("/".join(parts[-2:]))

    return f"배포 #{deploy.d_id}"


# 자동으로 한 일 문단 - 없으면 한 줄로 "없음", 있으면 시도마다 한 줄 (사유는 짧게)
def compose_actions_text(actions:list) -> str:
    if not actions:
        return "자동으로 한 일: 없음"

    lines=["자동으로 한 일:"]
    for action in actions:
        label=ACTION_LABELS.get(action.action, action.action)
        result=RESULT_LABELS.get(action.result, action.result)
        line=f"- {label}: {result}"
        if action.result == 'failed' and action.detail:
            line=f"{line} ({dispatch_scrub(action.detail)[:DETAIL_MAX]})"
        lines.append(line)

    return "\n".join(lines)


# 본문 조립 - 값이 없는 줄은 건너뛰고, 모든 줄을 마스킹한다
def compose_body(lines:list[str|None]) -> str:
    return dispatch_scrub("\n".join(line for line in lines if line))[:20000]


# 복구 제목 - 마지막으로 성공한 자동 동작에 따라 말을 달리한다
def compose_recovered_title(actions:list) -> str:
    done=[action.action for action in actions if action.result == 'ok']

    if 'rollback' in done:
        return "서비스를 되돌려 복구했습니다"
    if 'restart' in done:
        return "서비스를 다시 시작해 복구했습니다"
    return "서비스가 정상으로 돌아왔습니다"


# 인시던트 알림 - detail 은 Incident_Detail (explain 과 복구 시도 목록이 들어 있다)
def compose_incident(kind:str, service:str, detail) -> Composed:
    explain=detail.explain
    summary=(explain.summary if explain else None) or detail.summary or "문제를 확인하고 있습니다"
    link=compose_link(f"incidents/{detail.i_id}")

    if kind == 'incident_recovered':
        title=compose_recovered_title(detail.actions)
        what="문제가 풀려 서비스가 다시 정상으로 응답합니다."
        push_line=f"{service} · {title}"
    elif kind == 'incident_needs_action':
        title="직접 확인이 필요합니다"
        what=summary
        push_line=f"{service} · {summary}"
    else:
        title="서비스에 문제가 생겼습니다"
        what=summary
        push_line=f"{service} · {summary}"

    body=compose_body([
        f"무슨 일: {what}",
        f"왜: {explain.cause}" if explain and explain.cause else None,
        f"어디를 고치나: {explain.fix_where}" if explain and explain.fix_where else None,
        compose_actions_text(detail.actions),
        f"자세히 보기: {link}",
    ])

    return Composed(dispatch_scrub(title)[:TITLE_MAX], body, dispatch_scrub(push_line)[:PUSH_LINE_MAX], link)


# 배포 해설(json) 읽기 - 못 읽으면 None
def compose_deploy_explain(deploy) -> dict | None:
    if not deploy.explain:
        return None

    try:
        value=json.loads(deploy.explain)
    except Exception:
        return None

    return value if isinstance(value, dict) else None


# 예정 시간 글 - 정수면 4시간, 아니면 1.5시간 (소수 둘째 자리까지)
def compose_hours_text(hours:float) -> str:
    value=float(hours)
    if value.is_integer():
        return f"{int(value)}시간"

    return f"{format(round(value, 2), 'f').rstrip('0').rstrip('.')}시간"


# 배포 알림 - 완료/실패/새 커밋/예정 시간 초과. event 는 새 커밋의 sha
def compose_deploy(kind:str, service:str, deploy, event:str|None=None) -> Composed:
    link=compose_link(f"deploys/{deploy.d_id}")

    if kind == 'deploy_succeeded':
        title="배포가 완료되었습니다"
        body=compose_body([
            f"무슨 일: {service} 배포가 끝나 실행 중입니다.",
            f"주소: {deploy.endpoint}" if deploy.endpoint else None,
            f"자세히 보기: {link}",
        ])
        push_line=f"{service} · 실행 중입니다"

    elif kind == 'deploy_failed':
        explain=compose_deploy_explain(deploy) or {}
        summary=explain.get("summary") or f"{deploy.error_step or '배포'} 단계에서 멈췄습니다."
        cause=explain.get("cause") or (deploy.error_msg or "")[:300]
        actions=[action for action in (explain.get("actions") or []) if isinstance(action, str)][:2]

        title="배포가 실패했습니다"
        body=compose_body([
            f"무슨 일: {summary}",
            f"실패한 단계: {deploy.error_step}" if deploy.error_step else None,
            f"왜: {cause}" if cause else None,
            f"어디를 고치나: {' '.join(actions)}" if actions else "어디를 고치나: 배포 상세 화면의 로그와 해설을 확인합니다.",
            f"자세히 보기: {link}",
        ])
        push_line=f"{service} · {summary}"

    elif kind == 'plan_exceeded':
        planned=compose_hours_text(deploy.planned_hours or 0)
        title=f"{service} 가 예정한 사용 시간을 넘었습니다"
        body=compose_body([
            f"무슨 일: {service} 를 {planned} 쓰기로 했는데 그 시간이 지났습니다.",
            "왜: 계속 켜 두면 요금이 나옵니다.",
            "어디를 고치나: 더 쓰지 않으면 멈추거나 삭제하세요. 더 쓸 거라면 예정 시간을 늘립니다.",
            f"자세히 보기: {link}",
        ])
        push_line=f"{service} · 예정한 {planned}이 지났습니다. 멈추거나 삭제하세요"

    else:
        short=(event or deploy.watch_commit_sha or "")[:7]
        title=f"새 커밋이 있습니다 ({short})" if short else "새 커밋이 있습니다"
        body=compose_body([
            f"무슨 일: {service} 의 레포에 새 커밋 {short} 이 올라왔습니다." if short else f"무슨 일: {service} 의 레포에 새 커밋이 올라왔습니다.",
            "왜: 자동 재배포가 꺼져 있어 알리기만 합니다.",
            "어디를 고치나: 반영하려면 앱에서 [다시 배포]를 누릅니다.",
            f"자세히 보기: {link}",
        ])
        push_line=f"{service} · 새 커밋 {short}".strip()

    return Composed(dispatch_scrub(title)[:TITLE_MAX], body, dispatch_scrub(push_line)[:PUSH_LINE_MAX], link)
