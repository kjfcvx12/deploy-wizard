# deploy-wizard 생성 파일 - Python 정식 템플릿
FROM python:{runtime_version}-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT={port}

WORKDIR /app
{system_packages_block}
COPY . .
RUN {install_command}
{build_block}
EXPOSE {port}

CMD {cmd_json}
