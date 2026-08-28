# syntax=docker/dockerfile:1

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/lumi-ai-lab/harness-data" \
      org.opencontainers.image.description="Data Harness CLI for QDM runtime constraint data"

WORKDIR /opt/harness-data
COPY packages/data-harness-cli ./packages/data-harness-cli
COPY bin/data-harness-cli ./bin/data-harness-cli
COPY bin/data-harness-cli.cmd ./bin/data-harness-cli.cmd
RUN chmod 755 bin/data-harness-cli \
 && ln -s /opt/harness-data/bin/data-harness-cli /usr/local/bin/data-harness-cli

ENTRYPOINT ["data-harness-cli"]
