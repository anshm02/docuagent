# DocuAgent Worker — Production Dockerfile
# Uses tsx to run TypeScript directly (no tsc build step)

FROM node:22-slim

# Install dependencies for Playwright/Chromium + curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Set Playwright to use system Chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Copy root package files for workspaces
COPY package.json package-lock.json turbo.json tsconfig.base.json ./

# Copy workspace package.json files
COPY apps/worker/package.json apps/worker/tsconfig.json apps/worker/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/

# Install ALL dependencies (tsx is in dependencies, needed at runtime)
RUN npm ci

# Install Playwright browsers (just Chromium)
RUN npx playwright install chromium || true

# Copy source code
COPY packages/shared/ packages/shared/
COPY apps/worker/src/ apps/worker/src/

# Build shared package (needed for @docuagent/shared imports)
RUN cd packages/shared && npx tsc || true

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

# Use npm start which runs: tsx src/index.ts
WORKDIR /app/apps/worker
CMD ["npm", "start"]
