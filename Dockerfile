# One image, two roles: the API server (default) and the code runner
# (`node bin/preppilot.js runner`, see docker-compose.yml).

FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web
# SQLite lives on a mounted volume at /data, owned by the unprivileged user.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "bin/preppilot.js", "serve", "--host", "0.0.0.0", "--port", "8080"]
