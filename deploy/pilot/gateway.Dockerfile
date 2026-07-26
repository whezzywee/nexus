ARG RUST_IMAGE=rust:1.89.0-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim
FROM ${RUST_IMAGE} AS build

WORKDIR /src
COPY . .
RUN cargo build --locked --release -p nexus-gateway

FROM ${RUNTIME_IMAGE}

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 nexus

COPY --from=build /src/target/release/nexus-gateway /usr/local/bin/nexus-gateway

USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/nexus-gateway"]
