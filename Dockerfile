FROM node:22-alpine

WORKDIR /app

# Tidak ada dependency eksternal saat ini (hanya Node.js built-ins),
# tapi tetap disiapkan agar npm install otomatis jalan kalau nanti ditambah.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY src ./src
COPY public ./public

# Jalankan sebagai user non-root
RUN addgroup -S gt06 && adduser -S gt06 -G gt06
USER gt06

ENV GT06_PORT=5023 \
    GT06_HOST=0.0.0.0 \
    WEB_PORT=8083 \
    WEB_HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 5023 8083

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node src/healthcheck.js

CMD ["node", "src/server.js"]
