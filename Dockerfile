# DockLite Lightweight Container Image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY target/release/docklite /usr/local/bin/docklite

ENV PORT=3000
ENV HOST=0.0.0.0
ENV RUST_LOG=docklite=info

EXPOSE 3000

CMD ["docklite"]
