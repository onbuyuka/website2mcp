# Build:  docker build -t site2mcp .
#         docker build -t site2mcp --build-arg WITH_BROWSER=true .   (adds Chromium for JavaScript-rendered sites)
# Run:    docker run --rm -p 3000:3000 site2mcp https://docs.example.com
#         docker run --rm -p 3000:3000 -v "$PWD/dist:/site:ro" site2mcp /site --base-url https://example.com/

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ARG WITH_BROWSER=false
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    SITE2MCP_CACHE_DIR=/cache
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN if [ "$WITH_BROWSER" = "true" ]; then node node_modules/playwright-core/cli.js install --with-deps chromium; fi \
    && mkdir -p /cache && chown node:node /cache
USER node
EXPOSE 3000
ENTRYPOINT ["node", "/app/dist/cli.js", "--http", "--host", "0.0.0.0", "--port", "3000"]
