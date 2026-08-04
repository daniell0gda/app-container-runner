FROM node:24.18.0-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node server.mjs ./
COPY --chown=node:node profiles.json ./

ENV NODE_ENV=production PORT=8080 PROFILES_FILE=/app/profiles.json RUNNER_TIMEOUT_MS=900000 MAX_OUTPUT_BYTES=1048576
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
