FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/*.ts web/*.css web/*.html web/build.mjs web/tsconfig.json ./
COPY web/assets/ ./assets/
RUN npm run check && npm run build

FROM python:3.13-alpine
LABEL org.opencontainers.image.title="Network RB5009" \
      org.opencontainers.image.source="https://github.com/haoranxu1989/network-rb5009" \
      org.opencontainers.image.licenses="MIT"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NETWORK_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt \
    && addgroup -S network && adduser -S -G network network \
    && mkdir /data && chown network:network /data
COPY network/*.py network/
COPY LICENSE NOTICES.md ./
COPY --from=frontend /build/index.html ./index.html
COPY --chmod=0755 docker-entrypoint.py /usr/local/bin/network-entrypoint
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/network-entrypoint"]
HEALTHCHECK --interval=30s --timeout=4s CMD ["/usr/local/bin/network-entrypoint", "python", "-c", "from http.client import HTTPConnection; from network.http import listen_port; c = HTTPConnection('127.0.0.1', listen_port(), timeout=3); c.request('GET', '/healthz'); raise SystemExit(c.getresponse().status != 200)"]
CMD ["python", "-m", "network"]
