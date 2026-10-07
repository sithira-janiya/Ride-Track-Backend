FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY scripts ./scripts

# run as the unprivileged "node" user that ships with the image
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1

# apply the schema (idempotent), then start the API
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
