FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src src
COPY web web
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER node
EXPOSE 8080
CMD ["node", "dist/server/server.js"]
