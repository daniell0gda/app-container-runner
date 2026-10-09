FROM docker:29.8.1-cli AS docker-cli

FROM nexus.pdtec.lan:5500/linux-nodejs:lts
# `docker compose` runs the services a repository declares. Both binaries are
# static; they reach the daemon only through the mounted socket.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY --chown=node:node .npmrc ./
COPY --chown=node:node package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node server.mjs worker-match.mjs worker-dns.mjs worker-network.mjs worker-image.mjs workspace-compose.mjs command-env.mjs profile-store.mjs migrate-profiles.mjs ./
# Profiles ship as the profiles/ folder. PROFILES_FILE stays set as an optional
# legacy path: the loader skips it when it is missing, so a profiles.json can
# still be mounted at /app/profiles.json (alone or next to the folder).
COPY --chown=node:node profiles/ ./profiles/

ENV NODE_ENV=production PORT=8080 PROFILES_FILE=/app/profiles.json PROFILES_DIR=/app/profiles RUNNER_TIMEOUT_MS=900000 MAX_OUTPUT_BYTES=1048576 ARTIFACT_MAX_BYTES=52428800 ARTIFACT_ROOT=/workspace/workspaces
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
