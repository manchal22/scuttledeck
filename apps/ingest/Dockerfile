FROM node:22-alpine

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/ingest/package.json apps/ingest/

RUN pnpm install --frozen-lockfile --filter @scuttledeck/ingest...

COPY packages ./packages
COPY apps/ingest ./apps/ingest

ENV NODE_ENV=production
EXPOSE 8787

CMD ["pnpm", "--filter", "@scuttledeck/ingest", "start"]
