# deploy-wizard 생성 파일 - Node.js 정식 템플릿
FROM node:{runtime_version}-slim

ENV NODE_ENV=production \
    PORT={port}

WORKDIR /app
{system_packages_block}
COPY . .
RUN {install_command}
{build_block}
EXPOSE {port}

CMD {cmd_json}
