# Profile-based worker runner

Hermes and the runner are long-lived. Hermes has no Docker socket. Hermes sends only approved request fields: `project`, relative `workspace`, optional/required `image` (from worktree `.hermes/hermes_config.yaml`, else `.agents/...`), and a tokenized `cmd` array. The runner owns profiles, creates one disposable worker per project/workspace, and pulls an image only when an operator approved it and the host lacks it.

`/workers/release` stops or removes every managed worker for that issue, not just the exact `project`+`workspace` pair. A close of `godot-td` / `godot-td/issue-window-modals-skip-wood-frame` also clears leftover alias containers such as `ai-worker-poke-defense-godot-poke-defense-godot-issue-window-modals-skip-wood-frame-*`. Matching uses the exact `issue-<slug>` tail (or container name `ai-worker-*-issue-<slug>-<12hex>`). Other known profile keys are left alone.

A profile JSON key may list several names, comma-separated, for example `"godot-td,tower-defense"`. Each name resolves to the same profile. Names are trimmed; empty or duplicate names are rejected at startup.

## Shared path configuration

The profile file has one `shared` section:

- `hostWorkspaceRoot`: host dataset root used by Docker bind mounts (Docker-engine path on the host that runs the runner).
- `hermesWorkspaceRoot`: path where Hermes sees the same dataset (container path, typically `/opt/workspace/git-workspaces`).
- `defaultWorkerWorkspaceRoot`: default path where workers see the dataset (`/workspaces`).
- `managedLabel` and `managedLabelValue`: ownership label used for worker discovery and lifecycle operations.
- `allowedImages` (optional): shared allowlist of image refs or globs. When non-empty (together with per-profile `allowedImages`), request `image` must match an entry (profile `image` remains allowed for back-compat). In a glob, `*` stands for any run of characters and `?` for one, neither crossing a `/`: `nexus.pdtec.lan:5500/linux-*` approves every tag of every top-level `linux-*` repository on that registry, but not a nested path or another registry.

A profile mount may refer to a shared path by key, for example `sourceFromShared: "hostWorkspaceRoot"`, or to a path owned by the selected profile, for example `sourceFromProfile: "hostRepoRoot"`. The runner resolves the selected source to the host path before calling Docker.

These three roots describe the **same** git-workspaces dataset from three viewpoints:

| Root | Who sees it | Typical value |
|---|---|---|
| `hostWorkspaceRoot` | Docker engine / bind mount source | deployment-specific host path |
| `hermesWorkspaceRoot` | Hermes container | `/opt/workspace/git-workspaces` |
| `defaultWorkerWorkspaceRoot` | Worker containers | `/workspaces` |

## Workspace request contract

Request field `workspace` **must be relative** under that shared root. Preferred shape (align with `caiq-start-issue`):

```text
<project>/issue-<slug>
```

Examples:

- `simple-ng-proj/issue-fix-login-timeout`
- `godot-td/issue-window-modals-skip-wood-frame`

Do **not** pass absolute paths such as `${GIT_WORKSPACES_ROOT}/...`, `/opt/workspace/git-workspaces/...`, or host drive paths. Absolute / traversal values are rejected by design.

Inside the worker the path resolves as:

```text
${defaultWorkerWorkspaceRoot}/<project>/issue-<slug>
→ /workspaces/<project>/issue-<slug>
```

With matching shared settings, that is the same tree as `${hermesWorkspaceRoot}/<project>/issue-<slug>` for Hermes and `${hostWorkspaceRoot}/<project>/issue-<slug>` on the Docker host.

Outdated examples such as `issue-182/piwotworki` (slug/project reversed) are **not** the preferred contract.

## Image request contract

Per-issue worker image source of truth is hermes_config.yaml in the worktree:

```text
1. <worktree>/.hermes/hermes_config.yaml   # preferred
2. <worktree>/.agents/hermes_config.yaml   # else
```

YAML key: `image`. `caiq-start-issue` requires one of these and returns the `image` string. Callers must pass it as HTTP body field **`image`** on `/workers/ensure` and `/run`.

Policy:

1. **Pull only what is approved, only when missing**: the runner `docker inspect`s the image and pulls it when the host lacks it and it is `profile.image` or matches the allowlist. An image already on the host is never re-pulled, so a moved tag is not picked up until the local copy is removed. With no allowlist, a requested image must already be on the host.
2. **Optional allowlist**: if `shared.allowedImages` and/or `profile.allowedImages` is non-empty, the requested image must match an entry there (or equal `profile.image`).
3. **Fallback**: if request `image` is omitted/empty, the runner uses `profile.image` (legacy). Prefer always sending hermes_config `image` (`.hermes` then `.agents`) for issue worktrees.
4. If an existing managed worker for that project/workspace was created with a **different** image, ensure recreates it.

Profile `image` remains the default/fallback and an allowlist member; it is no longer the only story for per-issue execution once request `image` is supplied.

Hermes boundary: no Docker socket in Hermes; do not send image names through `run_project_cmd` beyond the approved request fields (`project`, `workspace`, `image`, `cmd`, …).

## Services

A worker only runs commands. What those commands talk to — a database, an API — the repository declares in a Compose file that its hermes_config.yaml points at, and callers pass the file's text as body field **`compose`** on `/workers/ensure` and `/run`:

```yaml
services:
  tetra-db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: pdtec }
    healthcheck:
      test: [CMD, pg_isready, -U, postgres, -h, 127.0.0.1]
      interval: 2s
      retries: 60
  tetra-apps:                       # a one-shot job: tetra-api waits for it to exit 0
    image: nexus.pdtec.lan:5500/pdtec-tetra-cli:v84004.2.0
    command: [platform-apps, install]
    depends_on: { tetra-db: { condition: service_healthy } }
  tetra-api:
    image: nexus.pdtec.lan:5500/pdtec-tetra-devapps-api:v84004.2.0
    depends_on: { tetra-apps: { condition: service_completed_successfully } }
    environment:
      ICE_LIC_PATH: ${TETRA_ICE_LIC_PATH}   # from the runner's environment
```

Each workspace is one Compose project, `ai-ws-<hash>`, run with `docker compose up --detach --wait`. Its services are reachable on the project's network `ai-ws-<hash>_default` under their names, and the workspace's worker is connected to that network. So `http://tetra-api:8080` works from the worker and from nowhere else. Readiness, start order and jobs are Compose's own `healthcheck` and `depends_on`. A one-shot job must be one another service waits for with `condition: service_completed_successfully`: `up --wait` counts any other container that stops, even with exit 0, as a failure. The stack lives until `/workers/release` for that workspace; `remove: true` runs `docker compose down --volumes`, which also deletes the network and the services' volumes.

The runner checks what `docker compose config` makes of the file before anything starts:

- Every variable the file interpolates must be in `profile.allowedSecrets`, and set in the runner's environment unless the file gives a default. Compose runs with those secrets and nothing else of the runner's environment. `allowedSecrets` is a list of names, or a map of name to a one-line description of what the secret is for and how a service uses it; `/profiles/<project>` returns the descriptions as `secretDescriptions`, so a caller learns what a secret is without seeing it.
- Every service `image` must match the allowlist (`shared.allowedImages` plus `profile.allowedImages`). Unlike a worker image, it is pulled when missing.
- A service may set only `image`, `command`, `entrypoint`, `environment`, `healthcheck`, `depends_on`, `networks`, `volumes`, `tmpfs`, `working_dir`, `user`, `labels`, `expose`, `hostname`, `init`, `restart`, `shm_size`, `stop_grace_period` and `stop_signal`. Anything else — `ports`, `privileged`, `cap_add`, `devices`, `network_mode`, `build`, `container_name`, `deploy`, … — refuses the file and names the key.
- Volumes are the file's own, declared plain (no `name`, `external`, `driver`), or anonymous, or `tmpfs`. A bind mount is refused.
- Services use only the project's default network, and no top-level `secrets` or `configs`. Labels starting with `ai.runner.` are the runner's.

On top of the file the runner gives every service its labels, `restart: "no"`, and the profile's `resources` and worker resolver.

The first call builds the stack in the background and waits up to `SERVICES_WAIT_MS` (60 s). A stack not ready by then answers HTTP 503 with `services: "starting"`; the build carries on and the next call picks it up. `up` may take `SERVICES_UP_TIMEOUT_MS` (20 min), pulls included. A failed stack answers HTTP 500 with `services: "failed"`, Compose's error and the last log lines of each service that exited non-zero or turned unhealthy, and stays failed until the file changes or the workspace is released. An unchanged file is reused, also after a runner restart, as long as every service is still running and every job exited 0; a changed one takes the stack down and brings it up again. A file that fails the checks answers HTTP 400 and starts nothing.

## Build/run

```bash
docker build -t profile-worker-runner:local .
docker run --rm --name profile-worker-runner \
  -p 127.0.0.1:8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock:rw \
  -v /path/to/git-workspaces:/workspace/workspaces:ro \
  -v /path/to/profiles.json:/app/profiles.json:ro \
  -e RUNNER_TOKEN='secret' profile-worker-runner:local
```

`run_runner.sh` starts the container first, then runs `docker inspect ix-hermes-agent-hermes-agent-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'`, assigns the first network name to `NETWORK_NAME`, and executes `docker network connect "$NETWORK_NAME" profile-worker-runner`.

Only the runner gets the Docker socket. Profile mount sources are host paths interpreted by the Docker engine. The Docker daemon does the pulling, so it needs to reach the registry and trust it; the runner passes no registry credentials. A pull happens inside the `/workers/ensure` or `/run` call that needs the image, so the first call for a large image can outlast a caller's own timeout — the pull still completes and the next call finds the image.

## API

All endpoints except `/health` require `Authorization: Bearer $RUNNER_TOKEN`.

```bash
# ensure — relative workspace + image from .hermes (else .agents) hermes_config.yaml
curl -X POST http://127.0.0.1:8080/workers/ensure \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"project":"simple-ng-proj","workspace":"simple-ng-proj/issue-fix-login-timeout","image":"nexus.pdtec.lan:5500/linux-nodejs:lts"}'

# run — same fields + tokenized cmd
curl -X POST http://127.0.0.1:8080/run \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"project":"simple-ng-proj","workspace":"simple-ng-proj/issue-fix-login-timeout","image":"nexus.pdtec.lan:5500/linux-nodejs:lts","cmd":["npm","run","build"]}'

curl -X POST http://127.0.0.1:8080/workers/release \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"project":"simple-ng-proj","workspace":"simple-ng-proj/issue-fix-login-timeout","remove":true}'

curl -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:8080/workers

# what a project may run: its default image, approved images, allowed executables, allowed secrets and their descriptions
curl -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:8080/profiles/simple-ng-proj

# the last lines of one service's log
curl -G -H "Authorization: Bearer $RUNNER_TOKEN" \
  --data-urlencode "project=simple-ng-proj" \
  --data-urlencode "workspace=simple-ng-proj/issue-fix-login-timeout" \
  --data-urlencode "service=tetra-api" --data-urlencode "tail=200" \
  http://127.0.0.1:8080/services/logs
```

`/profiles/<project>` answers from the profiles loaded at startup, which is what `/run` enforces. After an edit to `profiles.json` it keeps answering the old values until the runner restarts.

```bash
curl -G -H "Authorization: Bearer ***" \
  --data-urlencode "project=simple-ng-proj" \
  --data-urlencode "workspace=simple-ng-proj/issue-fix-login-timeout" \
  --data-urlencode "path=.gen/harness/visual_checkpoints/shots/surface_wave_1.png" \
  http://127.0.0.1:8080/artifacts --output surface_wave_1.png
```

`/artifacts` downloads only workspace-relative files from the Hermes-visible root, with traversal, extension, file-type, and size-limit checks. The runner container must mount the workspace dataset at `/workspace/workspaces` (or configure `ARTIFACT_ROOT`).

`/run` returns `success`, `exitCode`, `durationMs`, combined output, project, workspace, and worker. Commands must be non-empty token arrays, first token allowed by the profile, and never shell wrappers such as `bash -lc` or `sh -c`. Workspace must be relative and cannot contain traversal. On timeout, the runner kills the Docker exec PID, stops and force-removes the managed worker, and returns HTTP 504 with `timedOut: true`, `killResult`, and `cleanup` metadata. Ordinary non-zero exits keep the worker available for inspection.

Environment: `RUNNER_TOKEN`, `NETWORK_NAME` (optional), `HERMES_CONTAINER` (optional), `WORKSPACE_ROOT`, `PROFILES_FILE=/app/profiles.json`, `RUNNER_TIMEOUT_MS=900000`, `MAX_OUTPUT_BYTES=1048576`, `ARTIFACT_ROOT`, `ARTIFACT_MAX_BYTES`, `PORT=8080`, `SERVICES_WAIT_MS=60000`, `SERVICES_UP_TIMEOUT_MS=1200000`, and every secret a profile lists in `allowedSecrets`.
