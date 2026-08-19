FROM node:20-alpine

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

ENV ALLOW_INSECURE_DB=true

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source and startup scripts
COPY server.js ./server.js
COPY migrate-db.js ./migrate-db.js
COPY src ./src

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodeuser -u 1001
USER nodeuser

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["sh", "-c", "node migrate-db.js && node server.js"]