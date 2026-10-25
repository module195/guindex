# Multi-stage build for production
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Sem package-lock no repo: npm ci falharia, então usamos npm install
RUN npm install --no-audit --no-fund

COPY . .
RUN mkdir -p public
RUN npm run build

# ── Production ─────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 7000

# Healthcheck usa a própria instância local
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

CMD ["npm", "start"]
