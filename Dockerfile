FROM node:22-alpine

WORKDIR /app

# pg_dump dipakai untuk backup terjadwal (lihat src/backup.js)
# tzdata dipakai supaya TZ di bawah benar-benar berlaku (Alpine gak punya timezone data bawaan)
RUN apk add --no-cache postgresql16-client tzdata
ENV TZ=Asia/Jakarta

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Jalankan sebagai user non-root
RUN addgroup -S gt06 && adduser -S gt06 -G gt06 \
    && mkdir -p /backups && chown gt06:gt06 /backups
USER gt06

ENV GT06_PORT=5023 \
    GT06_HOST=0.0.0.0 \
    WEB_PORT=8080 \
    WEB_HOST=0.0.0.0 \
    NODE_ENV=production \
    BACKUP=monthly \
    BACKUP_DIR=/backups \
    BACKUP_KEEP=6 \
    RETENTION=90d

EXPOSE 5023 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node src/healthcheck.js

CMD ["node", "src/server.js"]
