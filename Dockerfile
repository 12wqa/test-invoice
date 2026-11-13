# Test Invoice - static PWA served by nginx. Built and published by .github/workflows/build.yml
FROM nginx:1-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/12wqa/test-invoice" \
      org.opencontainers.image.title="Test Invoice" \
      org.opencontainers.image.description="Allied Fire Test Invoice field app (static PWA, talks to n8n)" \
      org.opencontainers.image.version="${VERSION}"
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY app/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
