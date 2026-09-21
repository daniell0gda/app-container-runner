# Profile-based worker runner

Hermes and the runner are long-lived. Hermes has no Docker socket. Hermes sends only approved request fields: `project`, relative `workspace`, optional/required `image` (from the worktree `.ai/config.yaml`), and a tokenized `cmd` array. The runner owns profiles, creates one disposable worker per project/workspace, and uses only **pre-existing local** image tags (never pulls).

`/workers/release` stops or removes every managed worker for that issue, not just the exact `project`+`workspace` pair. A close of `godot-td` / `godot-td/issue-window-modals-skip-wood-frame` also clears leftover alias containers such as `ai-worker-poke-defense-godot-poke-defense-godot-issue-window-modals-skip-wood-frame-*`. Matching uses the exact `issue-<slug>` tail (or container name `ai-worker-*-issue-<slug>-<12hex>`). Other known profile keys are left alone.

A profile JSON key may list several names, comma-separated, for example `"godot-td,tower-defense"`. Each name resolves to the same profile. Names are trimmed; empty or duplicate names are rejected at startup.

## Shared path configuration

The profile file has one `shared` section:

- `hostWorkspaceRoot`: host dataset root used by Docker bind mounts (Docker-engine path on the host that runs the runner).
- `hermesWorkspaceRoot`: path where Hermes sees the same dataset (container path, typically `/opt/workspace/git-workspaces`).
- `defaultWorkerWorkspaceRoot`: default path where workers see the dataset (`/workspaces`).
- `managedLabel` and `managedLabelValue`: ownership label used for worker discovery and lifecycle operations.
- `allowedImages` (optional): shared allowlist of image refs. When non-empty (together with per-profile `allowedImages`), request `image` must be listed (profile `image` remains allowed for back-compat).

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

Per-issue worker image source of truth is the worktree file:

```text
<worktree>/.ai/config.yaml   # YAML key: image
```

`caiq-start-issue` requires that file and returns the `image` string. Callers must pass it as HTTP body field **`image`** on `/workers/ensure` and `/run`.

Policy:

1. **Local-tags-only**: the runner `docker inspect`s the tag and never pulls remote images.
2. **Optional allowlist**: if `shared.allowedImages` and/or `profile.allowedImages` is non-empty, the requested image must appear there (or equal `profile.image`).
3. **Fallback**: if request `image` is omitted/empty, the runner uses `profile.image` (legacy). Prefer always sending `.ai/config.yaml` `image` for issue worktrees.
4. If an existing managed worker for that project/workspace was created with a **different** image, ensure recreates it.

Profile `image` remains the default/fallback and an allowlist member; it is no longer the only story for per-issue execution once request `image` is supplied.

Hermes boundary: no Docker socket in Hermes; do not send image names through `run_project_cmd` beyond the approved request fields (`project`, `workspace`, `image`, `cmd`, …).

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

Only the runner gets the Docker socket. Profile mount sources are host paths interpreted by the Docker engine. Build approved local images ahead of time; the runner inspects them and never pulls remote images.

## API

All endpoints except `/health` require `Authorization: Bearer $RUNNER_TOKEN`.

```bash
# ensure — relative workspace + image from .ai/config.yaml
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
```

```bash
curl -G -H "Authorization: Bearer ***" \
  --data-urlencode "project=simple-ng-proj" \
  --data-urlencode "workspace=simple-ng-proj/issue-fix-login-timeout" \
  --data-urlencode "path=.gen/harness/visual_checkpoints/shots/surface_wave_1.png" \
  http://127.0.0.1:8080/artifacts --output surface_wave_1.png
```

`/artifacts` downloads only workspace-relative files from the Hermes-visible root, with traversal, extension, file-type, and size-limit checks. The runner container must mount the workspace dataset at `/workspace/workspaces` (or configure `ARTIFACT_ROOT`).

`/run` returns `success`, `exitCode`, `durationMs`, combined output, project, workspace, and worker. Commands must be non-empty token arrays, first token allowed by the profile, and never shell wrappers such as `bash -lc` or `sh -c`. Workspace must be relative and cannot contain traversal. On timeout, the runner kills the Docker exec PID, stops and force-removes the managed worker, and returns HTTP 504 with `timedOut: true`, `killResult`, and `cleanup` metadata. Ordinary non-zero exits keep the worker available for inspection.

Environment: `RUNNER_TOKEN`, `NETWORK_NAME` (optional), `HERMES_CONTAINER` (optional), `WORKSPACE_ROOT`, `PROFILES_FILE=/app/profiles.json`, `RUNNER_TIMEOUT_MS=900000`, `MAX_OUTPUT_BYTES=1048576`, `ARTIFACT_ROOT`, `ARTIFACT_MAX_BYTES`, `PORT=8080`.
