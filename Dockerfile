FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# Jalankan sebagai user non-root
RUN addgroup -S gt06 && adduser -S gt06 -G gt06
USER gt06

ENV GT06_PORT=5023 \
    GT06_HOST=0.0.0.0 \
    WEB_PORT=8080 \
    WEB_HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 5023 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node src/healthcheck.js

CMD ["node", "src/server.js"]
