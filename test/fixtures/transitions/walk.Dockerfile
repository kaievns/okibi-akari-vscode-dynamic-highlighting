# syntax=docker/dockerfile:1
# A Dockerfile with self, this, async and numbers, each of which paints in a code file.
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine AS self
ENV RETRIES=3 \
    MODE=${MODE:-async} \
    PATH=/app/bin:$PATH
RUN for i in 1 2 3; do echo "this $i of ${RETRIES}"; done && \
    if [ "$MODE" = "async" ]; then echo '{ "self": 1 }'; fi
RUN <<EOF2
set -eu
await=0x1F; echo "${await:-0}"
EOF2
FROM self AS this
COPY --from=self --chown=node:node /app /app
HEALTHCHECK --interval=30s --retries=3 CMD wget -qO- http://localhost:8080 || exit 1
ENTRYPOINT ["node", "server.js", "--self", "this"]
CMD ["--retries", "3"]
