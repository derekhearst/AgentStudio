# ---------- base ----------
FROM oven/bun:1 AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
	chromium \
	fonts-liberation \
	fonts-noto-color-emoji \
	libatk-bridge2.0-0 \
	libatk1.0-0 \
	libcups2 \
	libdrm2 \
	libgbm1 \
	libnss3 \
	libxcomposite1 \
	libxdamage1 \
	libxrandr2 \
	libxss1 \
	libxtst6 \
	git \
	curl \
	wget \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV SANDBOX_WORKSPACE=/workspace

# ---------- deps ----------
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY . .
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" bun run build

# ---------- production ----------
FROM base AS production
WORKDIR /app

RUN git config --global user.name "AGENTSTUDIO" \
	&& git config --global user.email "AGENTSTUDIO@local" \
	&& git config --global init.defaultBranch main

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./
COPY --from=build /app/drizzle ./drizzle

RUN mkdir -p /workspace && chown bun:bun /workspace
VOLUME /workspace

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
USER bun
CMD ["bun", "build/index.js"]
