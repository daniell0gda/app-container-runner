import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import Docker from "dockerode";

const app = express();
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock"
});
const port = Number.parseInt(process.env.PORT || "8080", 10);
const token = process.env.RUNNER_TOKEN;
const timeoutMs = Number.parseInt(process.env.RUNNER_TIMEOUT_MS || "900000", 10);
const maxOutputBytes = Number.parseInt(
  process.env.MAX_OUTPUT_BYTES || "1048576",
  10
);
const profilesFile = process.env.PROFILES_FILE || "/app/profiles.json";
const artifactMaxBytes = Number.parseInt(process.env.ARTIFACT_MAX_BYTES || "52428800", 10);
const artifactRoot = process.env.ARTIFACT_ROOT || null;
const allowedArtifactExtensions = new Set([".json", ".jpg", ".jpeg", ".log", ".png", ".txt", ".webm"]);
const workspacePattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const shellWrappers = new Set(["sh", "bash", "dash", "zsh"]);
let shared;
let profiles;

const jsonError = (res, status, message) =>
  res.status(status).json({ success: false, error: message });

function isAuthorized(req) {
  if (!token) return false;
  const [scheme, value] = (req.get("authorization") || "").split(" ", 2);
  const provided = Buffer.from(value || "");
  const expected = Buffer.from(token);
  return (
    scheme === "Bearer" &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
  );
}

function profileAliases(key) {
  return String(key)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function indexProfiles(rawProfiles) {
  const indexed = {};
  for (const [key, profile] of Object.entries(rawProfiles)) {
    const aliases = profileAliases(key);
    if (aliases.length === 0) {
      throw Error("profile key must contain at least one name");
    }
    for (const alias of aliases) {
      if (Object.hasOwn(indexed, alias)) {
        throw Error(`duplicate profile key: ${alias}`);
      }
      indexed[alias] = profile;
    }
  }
  return indexed;
}

function getProfile(project) {
  if (typeof project !== "string" || !Object.hasOwn(profiles, project)) {
    throw Error("project must be an approved profile key");
  }
  return profiles[project];
}

function workerWorkspaceRoot(profile) {
  return profile.workspaceRoot || shared.defaultWorkerWorkspaceRoot;
}

function resolveWorkspace(profile, identifier) {
  if (
    typeof identifier !== "string" ||
    !workspacePattern.test(identifier) ||
    identifier.includes("..")
  ) {
    throw Error(
      "workspace must be a relative path such as issue-182/piwotworki"
    );
  }

  const root = path.resolve(workerWorkspaceRoot(profile));
  const resolved = path.resolve(root, identifier);
  const relative = path.relative(root, resolved);

  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw Error("workspace is outside the profile workspace root");
  }

  return { id: identifier, path: resolved };
}

async function resolveArtifactPath(profile, identifier, artifact) {
  if (typeof artifact !== "string" || artifact.length === 0 || path.isAbsolute(artifact) || artifact.includes("\\0")) {
    throw Error("artifact path must be relative to the workspace");
  }
  const workspace = resolveWorkspace(profile, identifier);
  const root = path.resolve(artifactRoot || shared.hermesWorkspaceRoot);
  const workspacePath = path.resolve(root, identifier);
  const resolved = path.resolve(workspacePath, artifact);
  const relative = path.relative(workspacePath, resolved);
  const extension = path.extname(resolved).toLowerCase();
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !allowedArtifactExtensions.has(extension)) {
    throw Error("artifact path is outside the workspace or has an unsupported type");
  }
  const realWorkspace = await fs.realpath(workspacePath);
  const realPath = await fs.realpath(resolved);
  const realRelative = path.relative(realWorkspace, realPath);
  if (!realRelative || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative)) {
    throw Error("artifact path is outside the workspace");
  }
  return { workspace, path: realPath };
}

function workerName(project, identifier) {
  const readable = `${project}-${identifier}`
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 90);
  const suffix = crypto
    .createHash("sha256")
    .update(`${project}:${identifier}`)
    .digest("hex")
    .slice(0, 12);
  return `ai-worker-${readable}-${suffix}`;
}

function managedLabelFilter(project, identifier) {
  const labels = [
    `${shared.managedLabel}=${shared.managedLabelValue}`,
    `ai.runner.project=${project}`
  ];
  if (identifier) labels.push(`ai.runner.workspace=${identifier}`);
  return { label: labels };
}

async function listManagedWorkers(project, identifier) {
  const containers = await docker.listContainers({
    all: true,
    filters: managedLabelFilter(project, identifier)
  });
  return containers.filter(
    (container) =>
      container.Labels?.[shared.managedLabel] === shared.managedLabelValue
  );
}

function parseMemory(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const match = String(value || "")
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)(k|ki|kib|m|mi|mib|g|gi|gib|t|ti|tib)$/);
  if (!match) throw Error("invalid profile memory");
  const units = {
    k: 1024,
    ki: 1024,
    kib: 1024,
    m: 2 ** 20,
    mi: 2 ** 20,
    mib: 2 ** 20,
    g: 2 ** 30,
    gi: 2 ** 30,
    gib: 2 ** 30,
    t: 2 ** 40,
    ti: 2 ** 40,
    tib: 2 ** 40
  };
  return Math.round(Number(match[1]) * units[match[2]]);
}

function profileMounts(profile) {
  if (!Array.isArray(profile.mounts) || profile.mounts.length === 0) {
    throw Error("profile must define mounts");
  }

  return profile.mounts.map((mount) => {
    if (!mount || typeof mount.target !== "string" || !path.isAbsolute(mount.target)) {
      throw Error("profile mounts must define an absolute target");
    }

    let source;
    if (typeof mount.sourceFromShared === "string") {
      source = shared[mount.sourceFromShared];
    } else if (typeof mount.sourceFromProfile === "string") {
      source = profile[mount.sourceFromProfile];
    }

    if (typeof source !== "string" || !path.isAbsolute(source)) {
      throw Error(
        "profile mounts must reference an absolute shared or profile source"
      );
    }

    return `${source}:${mount.target}${mount.readOnly ? ":ro" : ":rw"}`;
  });
}

function resourceOptions(resources = {}) {
  const HostConfig = { RestartPolicy: { Name: "no" } };
  if (resources.memory) HostConfig.Memory = parseMemory(resources.memory);
  if (resources.cpus) {
    HostConfig.NanoCpus = Math.round(Number(resources.cpus) * 1e9);
  }
  return HostConfig;
}

function workerResult(info, profile, project, identifier) {
  return {
    container: info.Name?.replace(/^\//, "") || info.Id,
    containerId: info.Id,
    project,
    workspace: identifier,
    image: profile.image,
    status: info.State || info.Status || "unknown"
  };
}

async function ensureWorker(project, identifier, profile) {
  const found = await listManagedWorkers(project, identifier);
  let info = found[0];

  if (!info) {
    const image = docker.getImage(profile.image);
    try {
      await image.inspect();
    } catch {
      throw Error(`approved local image is not available: ${profile.image}`);
    }

    const createOptions = {
      name: workerName(project, identifier),
      Image: profile.image,
      Cmd: profile.command,
      Entrypoint: profile.entrypoint,
      Env: Object.entries(profile.env || {}).map(
        ([key, value]) => `${key}=${value}`
      ),
      Labels: {
        [shared.managedLabel]: shared.managedLabelValue,
        "ai.runner.project": project,
        "ai.runner.workspace": identifier
      },
      HostConfig: {
        ...resourceOptions(profile.resources),
        Binds: profileMounts(profile)
      }
    };
    // Prefer profile.user (e.g. "950:950") so workers match Hermes UID/GID.
    // Falls back to the image USER when omitted.
    if (typeof profile.user === "string" && profile.user.trim()) {
      createOptions.User = profile.user.trim();
    }
    const container = await docker.createContainer(createOptions);

    await container.start();
    info = await container.inspect();
  } else {
    const container = docker.getContainer(info.Id);
    info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
      info = await container.inspect();
    }
  }

  return workerResult(info, profile, project, identifier);
}

function validateCommand(profile, cmd) {
  if (
    !Array.isArray(cmd) ||
    cmd.length === 0 ||
    cmd.some((token) => typeof token !== "string" || token.length === 0)
  ) {
    throw Error("cmd must be a non-empty array of strings");
  }
  if (!profile.allowedExecutables?.includes(cmd[0])) {
    throw Error("cmd executable is not allowed by the project profile");
  }
  if (shellWrappers.has(cmd[0])) {
    throw Error("shell wrapper commands are not allowed");
  }
  if (cmd.some((token) => token.includes("\0"))) {
    throw Error("cmd contains an invalid null character");
  }
}

async function forceKillExec(container, execInstance) {
  // Best-effort: kill the process started by docker exec so a timed-out
  // godot/npm does not keep running and poison later commands.
  try {
    const info = await execInstance.inspect();
    const pid = Number(info?.Pid || 0);
    if (!Number.isFinite(pid) || pid <= 1) {
      return { killed: false, reason: "no-pid" };
    }
    const killer = await container.exec({
      // Bypass profile allowlist: this is an internal cleanup path.
      Cmd: ["kill", "-9", String(pid)],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false
    });
    const killStream = await killer.start({ hijack: true, stdin: false });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      killStream.once("end", () => {
        clearTimeout(timer);
        resolve();
      });
      killStream.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
      killStream.on("data", () => {});
    });
    return { killed: true, pid };
  } catch (killError) {
    return { killed: false, reason: killError.message };
  }
}

async function executeCommand(worker, workingDirectory, cmd) {
  const container = docker.getContainer(worker.containerId);
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: workingDirectory,
    Env: [
      "GIT_CONFIG_COUNT=1",
      "GIT_CONFIG_KEY_0=safe.directory",
      `GIT_CONFIG_VALUE_0=${workingDirectory}`
    ],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  let output = "";
  let outputBytes = 0;
  const started = Date.now();
  let timedOut = false;
  let killResult = null;
  const append = (chunk) => {
    if (outputBytes >= maxOutputBytes) return;
    const text = chunk.toString(
      "utf8",
      0,
      maxOutputBytes - outputBytes
    );
    output += text;
    outputBytes += Buffer.byteLength(text);
  };

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        timedOut = true;
        try {
          killResult = await forceKillExec(container, exec);
        } catch (killError) {
          killResult = { killed: false, reason: killError.message };
        }
        try {
          stream.destroy();
        } catch {
          // ignore
        }
        reject(Error(`command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      stream.once("end", () => {
        clearTimeout(timer);
        resolve();
      });
      stream.once("error", (streamError) => {
        clearTimeout(timer);
        reject(streamError);
      });
      docker.modem.demuxStream(stream, { write: append }, { write: append });
    });
  } catch (runError) {
    if (timedOut || String(runError.message || "").startsWith("command timed out")) {
      const suffix = killResult?.killed
        ? ` (killed pid ${killResult.pid})`
        : killResult?.reason
          ? ` (kill failed: ${killResult.reason})`
          : "";
      const err = Error(`command timed out after ${timeoutMs}ms${suffix}`);
      err.timedOut = true;
      err.partialOutput = output;
      err.killResult = killResult;
      throw err;
    }
    throw runError;
  }

  const result = await exec.inspect();
  return {
    success: result.ExitCode === 0,
    exitCode: result.ExitCode,
    durationMs: Date.now() - started,
    timedOut: false,
    output:
      outputBytes >= maxOutputBytes
        ? `${output}\n[output truncated]`
        : output
  };
}

async function releaseWorker(project, identifier, remove) {
  const found = await listManagedWorkers(project, identifier);
  if (found.length === 0) {
    return {
      project,
      workspace: identifier,
      status: "not_found",
      removed: false
    };
  }

  const info = found[0];
  const container = docker.getContainer(info.Id);
  const inspection = await container.inspect();
  if (inspection.State.Running) await container.stop({ t: 10 });
  if (remove) await container.remove();

  return {
    project,
    workspace: identifier,
    status: remove ? "removed" : "stopped",
    container: info.Names?.[0]?.replace(/^\//, "") || info.Id,
    removed: remove
  };
}

async function clearTimedOutWorker(project, identifier, worker) {
  const cleanup = {
    attempted: true,
    stopped: false,
    removed: false,
    error: null
  };
  try {
    const container = docker.getContainer(worker.containerId);
    const inspection = await container.inspect();
    if (inspection.State.Running) {
      await container.stop({ t: 10 });
      cleanup.stopped = true;
    }
    await container.remove({ force: true });
    cleanup.removed = true;
  } catch (cleanupError) {
    cleanup.error = cleanupError.message;
    console.error(
      `failed to clear timed-out worker ${project}/${identifier}: ${cleanupError.message}`
    );
  }
  return cleanup;
}

async function loadProfiles() {
  const document = JSON.parse(await fs.readFile(profilesFile, "utf8"));
  if (!document?.shared || typeof document.shared !== "object") {
    throw Error("profiles file must contain a shared object");
  }
  if (
    typeof document.shared.hostWorkspaceRoot !== "string" ||
    typeof document.shared.hermesWorkspaceRoot !== "string" ||
    typeof document.shared.defaultWorkerWorkspaceRoot !== "string" ||
    typeof document.shared.managedLabel !== "string" ||
    typeof document.shared.managedLabelValue !== "string"
  ) {
    throw Error("profiles shared settings are incomplete");
  }
  if (!document.profiles || typeof document.profiles !== "object") {
    throw Error("profiles file must contain profiles");
  }
  shared = document.shared;
  profiles = indexProfiles(document.profiles);
}

app.use(express.json({ limit: "32kb" }));
app.post("/health", (_req, res) =>
  res.json({ success: true, status: "ok" })
);
app.use((req, res, next) =>
  isAuthorized(req)
    ? next()
    : jsonError(res, 401, "missing or invalid bearer token")
);

app.post("/workers/ensure", async (req, res) => {
  try {
    const { project, workspace: identifier } = req.body || {};
    const profile = getProfile(project);
    resolveWorkspace(profile, identifier);
    return res.json({
      success: true,
      ...(await ensureWorker(project, identifier, profile))
    });
  } catch (requestError) {
    return jsonError(res, 400, requestError.message);
  }
});

app.post("/workers/release", async (req, res) => {
  try {
    const {
      project,
      workspace: identifier,
      remove = false
    } = req.body || {};
    const profile = getProfile(project);
    resolveWorkspace(profile, identifier);
    if (typeof remove !== "boolean") throw Error("remove must be boolean");
    return res.json({
      success: true,
      ...(await releaseWorker(project, identifier, remove))
    });
  } catch (requestError) {
    return jsonError(res, 400, requestError.message);
  }
});

app.post("/run", async (req, res) => {
  let worker;
  let project;
  let identifier;
  let cmd;
  try {
    ({ project, workspace: identifier, cmd } = req.body || {});
    const profile = getProfile(project);
    const resolved = resolveWorkspace(profile, identifier);
    validateCommand(profile, cmd);
    worker = await ensureWorker(project, identifier, profile);
    const result = await executeCommand(worker, resolved.path, cmd);
    return res.status(result.success ? 200 : 422).json({
      success: result.success,
      ...result,
      project,
      workspace: identifier,
      worker: worker.container
    });
  } catch (requestError) {
    const timedOut =
      requestError.timedOut ||
      String(requestError.message || "").startsWith("command timed out");
    const cleanup = timedOut && worker
      ? await clearTimedOutWorker(project, identifier, worker)
      : undefined;
    return res.status(timedOut ? 504 : 400).json({
      success: false,
      error: requestError.message,
      timedOut: Boolean(timedOut),
      output: requestError.partialOutput || undefined,
      killResult: requestError.killResult || undefined,
      cleanup
    });
  }
});

app.get("/artifacts", async (req, res) => {
  try {
    const { project, workspace: identifier, path: artifact } = req.query;
    const profile = getProfile(project);
    const resolved = await resolveArtifactPath(profile, identifier, artifact);
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) throw Error("artifact is not a file");
    if (stat.size > artifactMaxBytes) throw Error(`artifact exceeds the ${artifactMaxBytes}-byte limit`);
    return res.sendFile(resolved.path);
  } catch (requestError) {
    return jsonError(res, 404, requestError.message);
  }
});

app.get("/workers", async (_req, res) => {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${shared.managedLabel}=${shared.managedLabelValue}`]
      }
    });
    return res.json({
      success: true,
      workers: containers
        .filter(
          (container) =>
            container.Labels?.[shared.managedLabel] ===
            shared.managedLabelValue
        )
        .map((container) => ({
          container:
            container.Names?.[0]?.replace(/^\//, "") || container.Id,
          containerId: container.Id,
          project: container.Labels["ai.runner.project"],
          workspace: container.Labels["ai.runner.workspace"],
          image: container.Image,
          status: container.State
        }))
    });
  } catch (requestError) {
    return jsonError(res, 503, requestError.message);
  }
});

try {
  await loadProfiles();
  app.listen(port, "0.0.0.0", () =>
    console.log(`profile worker runner listening on ${port}`)
  );
} catch (startupError) {
  console.error(`failed to load profiles: ${startupError.message}`);
  process.exitCode = 1;
}
