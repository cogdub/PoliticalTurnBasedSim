# Statecraft 2026 — single container: game server + built web client.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY apps/cli/package.json apps/cli/
COPY packages/schemas/package.json packages/schemas/
COPY packages/engine/package.json packages/engine/
COPY packages/llm/package.json packages/llm/
COPY packages/agents/package.json packages/agents/
COPY packages/persistence/package.json packages/persistence/
COPY packages/scenario/package.json packages/scenario/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV HOST=0.0.0.0 \
    PORT=8787 \
    GS_SAVES_DIR=/data/saves \
    NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "apps/server/src/main.ts"]
