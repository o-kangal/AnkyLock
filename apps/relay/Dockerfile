# The relay as a small container. Build from the repository root (the Cargo workspace):
#   docker build -f apps/relay/Dockerfile -t ankylock-relay .
FROM rust:1.99-slim-trixie AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p ankylock-relay

FROM debian:trixie-slim
LABEL org.opencontainers.image.source="https://github.com/o-kangal/AnkyLock" \
      org.opencontainers.image.description="AnkyLock relay: forwards encrypted sync packets between your devices" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
# reqwest uses the system's OpenSSL and CA roots to fetch Google's signing keys.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3t64 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/ankylock-relay /usr/local/bin/ankylock-relay
USER 65534:65534
EXPOSE 8787
# The relay shuts down gracefully on Ctrl+C (SIGINT); `docker stop` sends it too.
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/ankylock-relay"]
