#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-app-containers-runner}"
NAME="${NAME:-runner}"
PORT="${PORT:-8080}"
TOKEN="${RUNNER_TOKEN:-}"
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)

if [[ -z "${TOKEN}" || "${TOKEN}" == "change-me" ]]; then
  echo "RUNNER_TOKEN is not set. Export RUNNER_TOKEN before running this script." >&2
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
  docker rm -f "${NAME}" >/dev/null
fi

exec sudo docker run -d \
  --name "${NAME}" \
  -p "${PORT}:8080" \
  --group-add "$DOCKER_GID" \
  -e RUNNER_TOKEN="${TOKEN}" \
  -e DOCKER_SOCKET="${DOCKER_SOCKET}" \
  -v "${DOCKER_SOCKET}:${DOCKER_SOCKET}" \
  --restart unless-stopped \
  "${IMAGE}"
