# Profile-based worker runner

Hermes and the runner are long-lived. Hermes has no Docker socket and sends only an approved `project`, relative `workspace`, and tokenized `cmd` array. The runner owns profiles, creates one disposable worker per project/workspace, and uses only pre-existing local image tags.

## Shared path configuration

The profile file has one `shared` section:

- `hostWorkspaceRoot`: host dataset root used by Docker bind mounts.
- `hermesWorkspaceRoot`: path where Hermes sees the same dataset.
- `defaultWorkerWorkspaceRoot`: default path where workers see the dataset.
- `managedLabel` and `managedLabelValue`: ownership label used for worker discovery and lifecycle operations.

A profile mount refers to a shared path by key, for example `sourceFromShared: "hostWorkspaceRoot"`. The runner resolves that to the host path before calling Docker. Profiles do not duplicate these shared paths.

## Build/run

```bash
docker build -t profile-worker-runner:local runner
docker run --rm --name profile-worker-runner \
  -p 127.0.0.1:8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock:rw \
  -v /path/to/profiles.json:/app/profiles.json:ro \
  -e RUNNER_TOKEN='TrueNAS-secret' profile-worker-runner:local
```

Only the runner gets the Docker socket. Profile mount sources are host paths interpreted by the TrueNAS Docker engine. Build approved local images with `scripts/build-local-images.sh`; the runner inspects them and never pulls remote images.

## API

All endpoints except `/health` require `Authorization: Bearer $RUNNER_TOKEN`.

```bash
curl -X POST http://127.0.0.1:8080/workers/ensure -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' -d '{"project":"piwotworki","workspace":"issue-182/piwotworki"}'
curl -X POST http://127.0.0.1:8080/run -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' -d '{"project":"piwotworki","workspace":"issue-182/piwotworki","cmd":["npm","run","build"]}'
curl -X POST http://127.0.0.1:8080/workers/release -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' -d '{"project":"piwotworki","workspace":"issue-182/piwotworki","remove":true}'
curl -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:8080/workers
```

The runner resolves `issue-182/piwotworki` as `/workspaces/issue-182/piwotworki` inside the worker. With the example shared settings, that corresponds to `/mnt/nas_ssd/quick_access_for_pc/hermes/workspaces/issue-182/piwotworki` on the host and `/workspace/workspaces/issue-182/piwotworki` in Hermes.

`/run` returns `success`, `exitCode`, `durationMs`, combined output, project, workspace, and worker. Commands must be non-empty token arrays, first token allowed by the profile, and never shell wrappers such as `bash -lc` or `sh -c`. Workspace must be relative and cannot contain traversal.

Environment: `RUNNER_TOKEN`, `PROFILES_FILE=/app/profiles.json`, `RUNNER_TIMEOUT_MS=900000`, `MAX_OUTPUT_BYTES=1048576`, `PORT=8080`.
