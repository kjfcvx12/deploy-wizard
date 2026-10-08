import re

# 보관 원칙 (기획서 03장) - 토큰이 로그·예외 메시지에 섞여 나가지 않게
# 로그를 DB에 넣기 전, LLM에 보내기 전에 반드시 거친다

MASK="****"

MASK_PATTERNS=[
    # GitHub 토큰
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    # AWS 액세스 키 id
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    # Anthropic 키
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),
    # url 안의 user:password@
    re.compile(r"(?<=://)[^/\s:@]+:[^/\s@]+(?=@)"),
    # JWT
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
]

# KEY=value 형태 (secret, token, password, key 가 이름에 들어간 것)
MASK_ASSIGN=re.compile(
    r"(?i)\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)(\s*[=:]\s*)(\S+)"
)


def mask_text(text:str|None) -> str:
    if not text:
        return ""

    for pattern in MASK_PATTERNS:
        text=pattern.sub(MASK, text)

    text=MASK_ASSIGN.sub(lambda m: f"{m.group(1)}{m.group(2)}{MASK}", text)

    return text
