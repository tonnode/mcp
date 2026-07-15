# Container image for @tonnode/mcp (stdio MCP server by default).
#   docker build -t tonnode-mcp .
#   docker run -i --rm tonnode-mcp                    # stdio mode
#   docker run --rm -p 8808:8808 -e HOST=0.0.0.0 -e TONNODE_KEYS=tn_live_x tonnode-mcp --http

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
