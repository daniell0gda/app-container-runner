// Services a project's repository declares in a Compose file, for its issue
// workspaces.
//
// A worker runs commands; a service runs its image's own entrypoint — a
// database, an API — for as long as the workspace lives. The repository points
// at a Compose file, and the runner runs it with `docker compose` as one project
// per workspace. The workspace's workers join that project's default network, so
// they reach every service by name and nothing else does. Readiness
// (`healthcheck`), order (`depends_on`) and one-shot jobs
// (`service_completed_successfully`) are Compose's own.
//
// The file comes from the repository, so the runner checks what Compose makes of
// it before anything starts: every variable against the profile's
// `allowedSecrets`, every image against the allowlist, and nothing that reaches
// past the project — no published port, no bind mount, no host namespace, no
// extra privilege, no volume or network that is not the workspace's own.

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvedImages, imageAllowed } from "./worker-image.mjs";

const maxServices = 8;
const failureLogLines = 30;
const composeFile = "compose.yaml";
const overrideFile = "runner.json";
const serviceNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const topLevelKeys = new Set(["name", "services", "networks", "volumes"]);
// Everything a service may carry once Compose has normalized the file. Anything
// else — ports, privileged, cap_add, devices, network_mode, pid, build,
// container_name, deploy, extra_hosts, … — is refused rather than dropped, so a
// repository learns what it cannot have instead of wondering why it has no effect.
const serviceKeys = new Set([
  "command",
  "depends_on",
  "entrypoint",
  "environment",
  "expose",
  "healthcheck",
  "hostname",
  "image",
  "init",
  "labels",
  "networks",
  "restart",
  "shm_size",
  "stop_grace_period",
  "stop_signal",
  "tmpfs",
  "user",
  "volumes",
  "working_dir"
]);
const reservedLabelPrefix = "ai.runner.";

export function definitionHash(definition) {
  return crypto.createHash("sha256").update(canonicalJson(definition)).digest("hex").slice(0, 12);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function composeProjectName(project, workspace) {
  const id = crypto.createHash("sha256").update(`${project}:${workspace}`).digest("hex").slice(0, 12);
  return `ai-ws-${id}`;
}

export const projectNetwork = (projectName) => `${projectName}_default`;

const describesSecrets = (secrets) => Boolean(secrets) && typeof secrets === "object" && !Array.isArray(secrets);

/**
 * The secret names a profile allows. `allowedSecrets` is either a list of names or a
 * map of name to a description of what the secret is for.
 */
export function secretNames(profile) {
  const secrets = profile.allowedSecrets;
  if (Array.isArray(secrets)) return secrets;
  return describesSecrets(secrets) ? Object.keys(secrets) : [];
}

/** The description of each secret a profile describes, by name; empty for a list of names. */
export function secretDescriptions(profile) {
  const secrets = profile.allowedSecrets;
  if (!describesSecrets(secrets)) return {};
  return Object.fromEntries(Object.entries(secrets).filter(([, description]) => typeof description === "string"));
}

// Every variable the file interpolates must be a secret the profile lists, and
// set on the runner unless the file gives it a default. Compose only ever sees
// those secrets, so this is about saying why a value came out empty, not about
// keeping the others from it.
export function checkVariables(variables, { allowedSecrets, secrets }) {
  for (const { Name, DefaultValue } of Object.values(variables)) {
    if (!allowedSecrets.includes(Name)) {
      throw Error(`the compose file uses variable ${Name}, which is not in this project's allowedSecrets`);
    }
    if (!secrets[Name] && !DefaultValue) throw Error(`variable ${Name} is not set on the runner`);
  }
}

// `config` is `docker compose config --format json` of the repository's file.
// Returns the service names.
export function checkComposeConfig(config, { projectName, allow }) {
  const topLevel = Object.keys(config).find((key) => !topLevelKeys.has(key) && !key.startsWith("x-"));
  if (topLevel) throw Error(`the compose file may not declare top-level ${topLevel}`);
  const volumes = checkVolumes(config.volumes ?? {}, projectName);
  checkNetworks(config.networks ?? {}, projectName);
  const names = Object.keys(config.services ?? {});
  if (names.length === 0) throw Error("the compose file declares no services");
  if (names.length > maxServices) throw Error(`at most ${maxServices} services per workspace`);
  for (const name of names) checkService(name, config.services[name], { allow, volumes });
  return names;
}

function checkVolumes(volumes, projectName) {
  for (const [key, volume] of Object.entries(volumes)) {
    const plain = volume?.name === `${projectName}_${key}` && Object.keys(volume).every((field) => field === "name");
    if (!plain) {
      throw Error(`volume ${key} must be a plain volume of the workspace: no name, external, driver or options`);
    }
  }
  return Object.keys(volumes);
}

function checkNetworks(networks, projectName) {
  for (const [key, network] of Object.entries(networks)) {
    const plain =
      key === "default" &&
      network?.name === projectNetwork(projectName) &&
      Object.keys(network).every((field) => field === "name" || field === "ipam") &&
      Object.keys(network.ipam ?? {}).length === 0;
    if (!plain) throw Error(`network ${key}: services share the workspace's default network and may not declare others`);
  }
}

function checkService(name, service, { allow, volumes }) {
  const refused = Object.keys(service).filter((key) => !serviceKeys.has(key));
  if (refused.length > 0) throw Error(`service ${name} may not set ${refused.join(", ")}`);
  if (typeof service.image !== "string" || !service.image) throw Error(`service ${name} needs an image`);
  if (!imageAllowed(service.image, allow)) {
    throw Error(`service ${name}: image is not on the allowlist: ${service.image}. Approved: ${allow.join(", ")}`);
  }
  if (Object.keys(service.networks ?? {}).some((network) => network !== "default")) {
    throw Error(`service ${name} may join only the default network`);
  }
  const reserved = Object.keys(service.labels ?? {}).find((label) => label.startsWith(reservedLabelPrefix));
  if (reserved) throw Error(`service ${name}: label ${reserved} is reserved for the runner`);
  for (const mount of service.volumes ?? []) checkMount(name, mount, volumes);
}

function checkMount(name, mount, volumes) {
  const ownVolume = mount.type === "volume" && (mount.source === undefined || volumes.includes(mount.source));
  if (!ownVolume && mount.type !== "tmpfs") {
    throw Error(
      `service ${name}: ${mount.type} mount ${mount.source ?? ""}:${mount.target} is not allowed; ` +
        "use a volume the file declares"
    );
  }
}

// Services another one waits for to exit 0: they are finished, not broken, once
// they have stopped.
export function jobNames(config) {
  return new Set(
    Object.values(config.services).flatMap((service) =>
      Object.entries(service.depends_on ?? {})
        .filter(([, dependency]) => dependency?.condition === "service_completed_successfully")
        .map(([name]) => name)
    )
  );
}

// What the runner adds to every service, as a second Compose file: its labels,
// and the same limits and resolver the profile's workers get.
export function runnerOverride(names, { labels, options }) {
  return {
    services: Object.fromEntries(
      names.map((name) => [
        name,
        { ...options, restart: "no", labels: { ...labels, "ai.runner.role": "service", "ai.runner.service": name } }
      ])
    )
  };
}

// `docker compose` with nothing of the runner's environment — which holds the
// whole .env, forge tokens included — but what it needs to reach the daemon, plus
// the secrets a caller hands it on purpose.
export function composeCli({ socketPath, env = process.env }) {
  const base = { PATH: env.PATH, HOME: env.HOME, DOCKER_HOST: `unix://${socketPath}` };
  return (args, { cwd, secrets = {}, signal, timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("docker", ["compose", ...args], {
        cwd,
        env: { ...base, ...secrets },
        signal,
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signalName) =>
        resolve({ code: code ?? 1, stdout, stderr: signalName ? `${stderr}stopped by ${signalName}` : stderr })
      );
    });
}

async function withFiles(files, use) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compose-"));
  try {
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
    return await use(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function stopIfCancelled(record) {
  if (record.cancelled) throw Error("the services were replaced or released");
}

// One Compose project per workspace, kept in memory and re-adopted from
// container labels after a runner restart. `serviceOptions(profile)` gives the
// Compose settings every service of that profile gets on top of the file.
export function createServiceStacks({ compose, docker, shared, serviceOptions, timeouts }) {
  const records = new Map();
  const queues = new Map();
  const stackKey = (project, workspace) => `${project}\u0000${workspace}`;

  async function succeeded(running, what) {
    const result = await running;
    if (result.code !== 0) throw Error(`${what}: ${result.stderr.trim()}`);
    return result.stdout;
  }

  const fileArgs = (projectName, dir, files) => [
    "-p",
    projectName,
    "--project-directory",
    dir,
    ...files.flatMap((file) => ["-f", path.join(dir, file)])
  ];

  // Compose finds a project's containers, networks and volumes by its name
  // alone, as long as it finds no compose file of its own: the empty directory
  // makes sure of that.
  const byName = (projectName, args) =>
    withFiles({}, (dir) => compose(["-p", projectName, ...args], { cwd: dir }));

  // What Compose makes of the repository's file, checked against the profile.
  async function load({ project, workspace, profile, text, env }) {
    const projectName = composeProjectName(project, workspace);
    const allowedSecrets = secretNames(profile);
    const secrets = Object.fromEntries(allowedSecrets.filter((name) => env[name]).map((name) => [name, env[name]]));
    const config = await withFiles({ [composeFile]: text }, async (dir) => {
      const configArgs = [...fileArgs(projectName, dir, [composeFile]), "config", "--format", "json"];
      const read = async (extra) =>
        JSON.parse(
          (await succeeded(compose([...configArgs, ...extra], { cwd: dir, secrets }), "the compose file is invalid")) ||
            "{}"
        );
      checkVariables(await read(["--variables"]), { allowedSecrets, secrets });
      return read([]);
    });
    const names = checkComposeConfig(config, { projectName, allow: approvedImages(shared, profile) });
    const options = serviceOptions(profile);
    const hash = definitionHash({ config, options });
    const labels = {
      [shared.managedLabel]: shared.managedLabelValue,
      "ai.runner.project": project,
      "ai.runner.workspace": workspace,
      "ai.runner.compose-hash": hash
    };
    return {
      projectName,
      text,
      secrets,
      names,
      jobs: jobNames(config),
      hash,
      override: runnerOverride(names, { labels, options })
    };
  }

  function projectContainers(projectName) {
    return docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${projectName}`] }
    });
  }

  function serviceLogs(projectName, service, tail) {
    return byName(projectName, ["logs", "--no-color", "--no-log-prefix", "--tail", String(tail), service]);
  }

  // The last lines of every service that exited non-zero or never got healthy.
  async function failedServiceLogs(projectName) {
    const failed = (await projectContainers(projectName)).filter((info) =>
      /\(unhealthy\)|^Exited \((?!0\))/.test(info.Status || "")
    );
    const sections = await Promise.all(
      failed.map(async (info) => {
        const service = info.Labels["ai.runner.service"];
        const { stdout, stderr } = await serviceLogs(projectName, service, failureLogLines);
        return `\n--- ${service} ---\n${stdout || stderr}`;
      })
    );
    return sections.join("");
  }

  // A stack a previous runner process finished is reused as long as it is this
  // exact definition and still whole: every service running, every job exited 0.
  async function adoptable(stack) {
    const found = await projectContainers(stack.projectName);
    return (
      found.length === stack.names.length &&
      stack.names.every((name) => {
        const info = found.find((container) => container.Labels["ai.runner.service"] === name);
        if (!info || info.Labels["ai.runner.compose-hash"] !== stack.hash) return false;
        return stack.jobs.has(name) ? /^Exited \(0\)/.test(info.Status || "") : info.State === "running";
      })
    );
  }

  async function disconnectAll(name) {
    const found = (await docker.listNetworks({ filters: { name: [name] } })).find((network) => network.Name === name);
    if (!found) return;
    const network = docker.getNetwork(found.Id);
    const { Containers = {} } = await network.inspect();
    for (const containerId of Object.keys(Containers)) {
      await network.disconnect({ Container: containerId, Force: true });
    }
  }

  // Workers joined the network from outside the project, and `down` removes it
  // only once nothing is attached. `--volumes` takes the services' data with them.
  async function teardown(projectName) {
    await disconnectAll(projectNetwork(projectName));
    await succeeded(
      byName(projectName, ["--progress", "quiet", "down", "--volumes", "--remove-orphans"]),
      `cannot remove the services of ${projectName}`
    );
  }

  async function build(record, stack) {
    if (await adoptable(stack)) return;
    await teardown(stack.projectName);
    stopIfCancelled(record);
    record.step = "docker compose up";
    await withFiles({ [composeFile]: stack.text, [overrideFile]: JSON.stringify(stack.override) }, async (dir) => {
      const up = await compose(
        [
          ...fileArgs(stack.projectName, dir, [composeFile, overrideFile]),
          "--progress",
          "quiet",
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          String(Math.ceil(timeouts.upMs / 1000))
        ],
        { cwd: dir, secrets: stack.secrets, signal: record.abort.signal, timeoutMs: timeouts.upMs + 60000 }
      );
      stopIfCancelled(record);
      if (up.code !== 0) throw Error(`${up.stderr.trim()}${await failedServiceLogs(stack.projectName)}`);
    });
  }

  // Every build and teardown of one workspace's stack starts only after the
  // previous one has settled, so two never race for the same names.
  function serialized(key, operation) {
    const run = (queues.get(key) ?? Promise.resolve()).then(operation);
    queues.set(key, run.catch(() => {}));
    return run;
  }

  // Stops a build nobody wants any more, so whatever is queued behind it can start.
  function cancel(record) {
    if (!record) return;
    record.cancelled = true;
    record.abort.abort();
  }

  // Starts the workspace's stack unless this exact definition is already up or
  // on its way. An edited file replaces the stack.
  async function ensure({ project, workspace, profile, text, env }) {
    const stack = await load({ project, workspace, profile, text, env });
    const key = stackKey(project, workspace);
    const current = records.get(key);
    if (current?.hash === stack.hash) return current;
    cancel(current);

    const record = {
      hash: stack.hash,
      network: projectNetwork(stack.projectName),
      status: "starting",
      step: "",
      error: null,
      cancelled: false,
      abort: new AbortController()
    };
    records.set(key, record);
    record.promise = serialized(key, () => build(record, stack)).then(
      () => {
        record.status = "ready";
        record.step = "";
      },
      (buildError) => {
        record.status = "failed";
        record.error = buildError.message;
      }
    );
    return record;
  }

  async function waitFor(record, ms) {
    let timer;
    const expiry = new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([record.promise, expiry]).finally(() => clearTimeout(timer));
    return record;
  }

  async function attach(containerId, network) {
    const info = await docker.getContainer(containerId).inspect();
    if (info.NetworkSettings?.Networks?.[network]) return;
    await docker.getNetwork(network).connect({ Container: containerId });
  }

  async function logs(project, workspace, service, tail) {
    if (typeof service !== "string" || !serviceNamePattern.test(service)) {
      throw Error("service must be a service name from the compose file");
    }
    const result = await serviceLogs(composeProjectName(project, workspace), service, tail);
    if (result.code !== 0) throw Error(`no logs for ${service} in ${workspace}: ${result.stderr.trim()}`);
    return result.stdout;
  }

  // `remove` false only stops the stack, leaving its containers to inspect; the
  // next ensure then finds them not running and builds a new one.
  async function release(project, workspace, { remove }) {
    const key = stackKey(project, workspace);
    cancel(records.get(key));
    records.delete(key);
    const projectName = composeProjectName(project, workspace);
    await serialized(key, () =>
      remove
        ? teardown(projectName)
        : succeeded(byName(projectName, ["--progress", "quiet", "stop"]), `cannot stop the services of ${projectName}`)
    );
  }

  return { ensure, waitFor, attach, logs, release };
}
