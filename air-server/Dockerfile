# air MCP server (onprem-mcp-data). On-prem, no external API at runtime.
# DB (PostgreSQL+pgvector) and the model runtime (Ollama: qwen2.5:7b + bge-m3)
# run as sibling services; this image is just the air MCP server.
FROM node:20-slim

WORKDIR /app

# install deps first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
# DATABASE_URL / OLLAMA_HOST / EMBEDDER are injected by docker-compose.
CMD ["node", "dist/index.js"]
