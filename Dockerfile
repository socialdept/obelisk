# Obelisk — single Bun process (ingester + embed worker + HTTP API).
# The entrypoint migrates on boot (src/index.ts) then serves on :6060.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Runtime deps only — drizzle-kit is a dev/codegen tool; migrations are plain
# SQL applied at boot by drizzle-orm + postgres.js, so it isn't needed at runtime.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS release
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# oven/bun ships a non-root `bun` user — run as it.
USER bun
EXPOSE 6060
CMD ["bun", "run", "src/index.ts"]
