FROM node:22-alpine AS builder

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @scuttledeck/web...

COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm --filter @scuttledeck/web build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
