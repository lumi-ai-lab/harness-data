# syntax=docker/dockerfile:1

ARG GO_VERSION=1.26

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY go.work ./
COPY go.work.sum ./
COPY cli/go.mod ./cli/
WORKDIR /src/cli
RUN go mod download

WORKDIR /src
COPY cli ./cli
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-$(go env GOARCH)} \
    go build -trimpath -ldflags="-s -w" -o /out/data-harness-cli ./cli/cmd/data-harness-cli

FROM alpine:3.22

LABEL org.opencontainers.image.source="https://github.com/lumi-ai-lab/harness-data" \
      org.opencontainers.image.description="Data Harness CLI for QDM runtime context"

COPY --from=build /out/data-harness-cli /usr/local/bin/data-harness-cli

ENTRYPOINT ["data-harness-cli"]
