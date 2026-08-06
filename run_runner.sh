#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-app-containers-runner}"
NAME="${NAME:-profile-worker-runner}"
PORT="${PORT:-8080}"
TOKEN="${RUNNER_TOKEN:-}"
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
HERMES_CONTAINER="${HERMES_CONTAINER:-ix-hermes-agent-hermes-agent-1}"
NETWORK_NAME="${NETWORK_NAME:-}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/mnt/nas_ssd/quick_access_for_pc/hermes/git-workspaces}"
DOCKER_GID=$(stat -c '%g' "${DOCKER_SOCKET}")

if [[ -z "${TOKEN}" || "${TOKEN}" == "change-me" ]]; then
  echo "RUNNER_TOKEN is not set. Export RUNNER_TOKEN before running this script." >&2
  exit 1
fi

if [[ ! -d "${WORKSPACE_ROOT}" ]]; then
  echo "Workspace root does not exist: ${WORKSPACE_ROOT}" >&2
  exit 1
fi

if sudo docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
  sudo docker rm -f "${NAME}" >/dev/null
fi

sudo docker build -t "${IMAGE}" .

sudo docker run -d \
  --name "${NAME}" \
  -p "${PORT}:8080" \
  --group-add "$DOCKER_GID" \
  -e RUNNER_TOKEN="${TOKEN}" \
  -e DOCKER_SOCKET="${DOCKER_SOCKET}" \
  -e ARTIFACT_ROOT=/workspace/workspaces \
  -v "${DOCKER_SOCKET}:${DOCKER_SOCKET}" \
  -v "${WORKSPACE_ROOT}:/workspace/workspaces:ro" \
  --restart unless-stopped \
  "${IMAGE}"

if [[ -z "${NETWORK_NAME}" ]]; then
  NETWORK_NAME=$(sudo docker inspect "${HERMES_CONTAINER}" \
    --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' \
    | head -n 1)
fi

if [[ -z "${NETWORK_NAME}" ]]; then
  echo "Could not determine Hermes Docker network for ${HERMES_CONTAINER}. Set NETWORK_NAME explicitly or verify the Hermes container is running." >&2
  exit 1
fi

sudo docker network connect "${NETWORK_NAME}" "${NAME}"
printf 'runner=%s network=%s workspace=%s\n' "${NAME}" "${NETWORK_NAME}" "${WORKSPACE_ROOT}"
