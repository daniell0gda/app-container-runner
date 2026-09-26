import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import Docker from "dockerode";
import { workerMatchesIssueRelease } from "./worker-match.mjs";
import { workerDnsOptions } from "./worker-dns.mjs";
import { workerNetworkOptions } from "./worker-network.mjs";

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
// Where the workers' /opt/workspace comes from, when it is not the host path in
// profiles.json. On a Windows host that path is a 9p drvfs share and creates
// files at ~95/s against ~4600/s on the VM's own disk, so the local stack backs
// the workspace with a Docker volume instead and names it here.
const hostWorkspaceRoot = process.env.HOST_WORKSPACE_ROOT || null;
const artifactMaxBytes = Number.parseInt(process.env.ARTIFACT_MAX_BYTES || "52428800", 10);
const artifactRoot = process.env.ARTIFACT_ROOT || null;
const workerDns = workerDnsOptions(process.env);
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
      "workspace must be a relative path such as <project>/issue-<slug>"
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

// The image is part of the identity, not just a property: a repository whose
// client and server need different toolchains asks for both within one
// workspace, and without this they would be the same worker — each request
// evicting the other's container and rebuilding it. Workers for different images
// coexist instead; release still takes them all, because it does not filter by
// image.
function workerName(project, identifier, image) {
  const readable = `${project}-${identifier}`
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 90);
  const suffix = crypto
    .createHash("sha256")
    .update(`${project}:${identifier}:${image}`)
    .digest("hex")
    .slice(0, 12);
  return `ai-worker-${readable}-${suffix}`;
}

function managedLabelFilter(project, identifier, image) {
  const labels = [
    `${shared.managedLabel}=${shared.managedLabelValue}`,
    `ai.runner.project=${project}`
  ];
  if (identifier) labels.push(`ai.runner.workspace=${identifier}`);
  if (image) labels.push(`ai.runner.image=${image}`);
  return { label: labels };
}

async function listManagedWorkers(project, identifier, image) {
  const containers = await docker.listContainers({
    all: true,
    filters: managedLabelFilter(project, identifier, image)
  });
  return containers.filter(
    (container) =>
      container.Labels?.[shared.managedLabel] === shared.managedLabelValue
  );
}

async function listAllManagedWorkers() {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`${shared.managedLabel}=${shared.managedLabelValue}`]
    }
  });
  return containers.filter(
    (container) =>
      container.Labels?.[shared.managedLabel] === shared.managedLabelValue
  );
}

function profileAliasesFor(project) {
  const target = profiles[project];
  return Object.keys(profiles).filter((alias) => profiles[alias] === target);
}

function containerDisplayName(info) {
  return info.Names?.[0]?.replace(/^\//, "") || info.Id;
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

// Docker accepts either an absolute host path (a bind) or a volume name on the
// left of a `Binds` entry, and tells them apart by the leading slash. So do we.
// The name pattern admits no slash, which keeps a relative path such as `..`
// from passing as a volume.
function isMountSource(source) {
  return (
    typeof source === "string" &&
    (path.isAbsolute(source) || /^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(source))
  );
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

    if (!isMountSource(source)) {
      throw Error(
        "profile mounts must reference a shared or profile source that is an " +
          "absolute host path or a Docker volume name"
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

function workerResult(info, project, identifier, image) {
  return {
    container: info.Name?.replace(/^\//, "") || info.Id,
    containerId: info.Id,
    project,
    workspace: identifier,
    image,
    status: info.State || info.Status || "unknown"
  };
}

function resolveWorkerImage(profile, requested) {
  const candidate =
    typeof requested === "string" && requested.trim()
      ? requested.trim()
      : profile.image;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw Error(
      "image is required (request body `image` or profile.image fallback)"
    );
  }
  const image = candidate.trim();
  const allow = [
    ...(Array.isArray(shared.allowedImages) ? shared.allowedImages : []),
    ...(Array.isArray(profile.allowedImages) ? profile.allowedImages : [])
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  // Allowlist is optional. When configured, request/profile image must be listed
  // (profile.image is always treated as allowed for back-compat).
  if (allow.length > 0 && !allow.includes(image) && image !== profile.image) {
    // Say where the image came from. A requested image is one the project asked
    // for in its hermes_config.yaml, and the fix is to approve it here or correct
    // it there — not, as has happened, for the agent to guess another tag.
    const source =
      image === candidate && requested
        ? "the project's hermes_config.yaml requested"
        : "profile.image is";
    throw Error(
      `${source} an image that is not on the allowlist: ${image}. ` +
        `Approved: ${allow.join(", ")}`
    );
  }
  return image;
}

async function assertLocalImage(image) {
  try {
    await docker.getImage(image).inspect();
  } catch (error) {
    // Only a 404 means the image really is absent. Every other failure is the
    // daemon being unreachable — most often EACCES on /var/run/docker.sock when
    // the container is not in the socket's group. Reporting those as a missing
    // image sends the caller off pulling an image that is already there.
    if (error?.statusCode === 404) {
      throw Error(`approved local image is not available: ${image}`);
    }
    throw Error(
      `cannot reach the Docker daemon to inspect ${image}: ${error?.message || error}`
    );
  }
}

function containerImageRef(info) {
  return info?.Config?.Image || info?.Image || "";
}

async function ensureWorker(project, identifier, profile, requestedImage) {
  const image = resolveWorkerImage(profile, requestedImage);
  await assertLocalImage(image);

  const found = await listManagedWorkers(project, identifier, image);
  let info = found[0];

  if (info) {
    const container = docker.getContainer(info.Id);
    info = await container.inspect();
    const current = containerImageRef(info);
    if (current && current !== image) {
      // Per-issue image from .ai/config.yaml changed: recreate the worker.
      try {
        if (info.State?.Running) await container.stop({ t: 10 });
      } catch {
        /* best-effort */
      }
      await container.remove({ force: true });
      info = undefined;
    } else if (!info.State.Running) {
      await container.start();
      info = await container.inspect();
    }
  }

  if (!info) {
    const createOptions = {
      name: workerName(project, identifier, image),
      Image: image,
      Cmd: profile.command,
      Entrypoint: profile.entrypoint,
      Env: Object.entries(profile.env || {}).map(
        ([key, value]) => `${key}=${value}`
      ),
      Labels: {
        [shared.managedLabel]: shared.managedLabelValue,
        "ai.runner.project": project,
        "ai.runner.workspace": identifier,
        "ai.runner.image": image
      },
      HostConfig: {
        ...resourceOptions(profile.resources),
        ...workerDns,
        ...workerNetworkOptions(profile.network),
        // docker-init as PID 1 passes SIGTERM on to the profile's command. As PID
        // 1 itself, `sleep infinity` ignores it, so every stop sat out the full
        // 10 s timeout before the kill.
        Init: true,
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
  }

  return workerResult(info, project, identifier, image);
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
  const allowedProjects = profileAliasesFor(project);
  const knownProjects = Object.keys(profiles);
  const found = (await listAllManagedWorkers()).filter((container) =>
    workerMatchesIssueRelease({
      workspaceLabel: container.Labels?.["ai.runner.workspace"],
      containerName: containerDisplayName(container),
      projectLabel: container.Labels?.["ai.runner.project"],
      requestedWorkspace: identifier,
      allowedProjects,
      knownProjects
    })
  );
  if (found.length === 0) {
    return {
      project,
      workspace: identifier,
      status: "not_found",
      removed: false,
      containers: []
    };
  }

  const containers = [];
  const errors = [];
  for (const info of found) {
    const name = containerDisplayName(info);
    try {
      const container = docker.getContainer(info.Id);
      const inspection = await container.inspect();
      if (inspection.State.Running) await container.stop({ t: 10 });
      if (remove) await container.remove();
      containers.push(name);
    } catch (releaseError) {
      errors.push({ container: name, error: releaseError.message });
    }
  }

  if (containers.length === 0) {
    throw Error(
      `failed to release workers: ${errors.map((item) => item.error).join("; ")}`
    );
  }

  return {
    project,
    workspace: identifier,
    status: remove ? "removed" : "stopped",
    container: containers[0],
    containers,
    count: containers.length,
    removed: remove,
    ...(errors.length > 0 ? { errors } : {})
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
  if (hostWorkspaceRoot) document.shared.hostWorkspaceRoot = hostWorkspaceRoot;
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
    const { project, workspace: identifier, image } = req.body || {};
    const profile = getProfile(project);
    resolveWorkspace(profile, identifier);
    return res.json({
      success: true,
      ...(await ensureWorker(project, identifier, profile, image))
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
  let image;
  try {
    ({ project, workspace: identifier, cmd, image } = req.body || {});
    const profile = getProfile(project);
    const resolved = resolveWorkspace(profile, identifier);
    validateCommand(profile, cmd);
    worker = await ensureWorker(project, identifier, profile, image);
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
