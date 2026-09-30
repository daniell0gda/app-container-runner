// Services a project's repository declares for its issue workspaces.
//
// A worker runs commands; a service runs its image's own entrypoint — a
// database, an API — for as long as the workspace lives. Each workspace gets its
// own Docker network, so its workers reach its services by name and nothing else
// does. A `once` entry is a one-shot job, such as a schema install, that has to
// exit 0 before anything that runs `after` it starts.
//
// The definition comes from the repository, so everything in it is checked
// against what the operator approved in profiles.json: every image against the
// allowlist, every secret against the profile's `allowedSecrets`. A service gets
// no mount, no published port and no host network.

import crypto from "node:crypto";
import { approvedImages, ensureLocalImage, imageAllowed } from "./worker-image.mjs";

const namePattern = /^[a-z][a-z0-9-]{0,30}$/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxServices = 8;
const failureLogLines = 30;
const stackRoles = new Set(["service", "job"]);

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

export function stackNames(project, workspace) {
  const id = crypto.createHash("sha256").update(`${project}:${workspace}`).digest("hex").slice(0, 12);
  return { network: `ai-net-${id}`, container: (service) => `ai-svc-${id}-${service}` };
}

// Validated services in start order: every entry after the ones it names.
export function validateServices(definition, { shared, profile, env }) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw Error("services must be a mapping of service name to service");
  }
  const names = Object.keys(definition);
  if (names.length === 0) throw Error("services is empty");
  if (names.length > maxServices) throw Error(`at most ${maxServices} services per workspace`);
  const context = { allow: approvedImages(shared, profile), profile, env, names };
  return orderByDependencies(names.map((name) => validateService(name, definition[name], context)));
}

function validateService(name, spec, context) {
  if (!namePattern.test(name)) {
    throw Error(`service name ${name} must be lowercase letters, digits and dashes`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw Error(`service ${name} must be a mapping`);
  }
  const image = typeof spec.image === "string" ? spec.image.trim() : "";
  if (!image) throw Error(`service ${name} needs an image`);
  if (!imageAllowed(image, context.allow)) {
    throw Error(
      `service ${name}: image is not on the allowlist: ${image}. Approved: ${context.allow.join(", ")}`
    );
  }
  if (spec.once !== undefined && typeof spec.once !== "boolean") {
    throw Error(`service ${name}: once must be true or false`);
  }
  const after = optionalNames(spec.after, `service ${name}: after`);
  const unknown = after.find((dependency) => dependency === name || !context.names.includes(dependency));
  if (unknown) throw Error(`service ${name}: after names an unknown service ${unknown}`);
  return {
    name,
    image,
    env: resolveEnv(name, spec.env, context),
    cmd: optionalCommand(spec.cmd, `service ${name}: cmd`),
    ready: optionalCommand(spec.ready, `service ${name}: ready`),
    once: spec.once === true,
    after
  };
}

function optionalNames(value, what) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw Error(`${what} must be a list of service names`);
  }
  return value;
}

function optionalCommand(value, what) {
  if (value === undefined) return undefined;
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((token) => typeof token === "string" && token.length > 0 && !token.includes("\0"));
  if (!valid) throw Error(`${what} must be a non-empty list of strings`);
  return value;
}

function resolveEnv(name, env, { profile, env: runnerEnv }) {
  if (env === undefined) return [];
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw Error(`service ${name}: env must be a mapping`);
  }
  const allowedSecrets = Array.isArray(profile.allowedSecrets) ? profile.allowedSecrets : [];
  return Object.entries(env).map(([key, value]) => {
    if (!envKeyPattern.test(key)) throw Error(`service ${name}: invalid env name ${key}`);
    return `${key}=${envValue(name, key, value, allowedSecrets, runnerEnv)}`;
  });
}

// A literal, or `{secret: NAME}` read from the runner's own environment — only for
// names the project's profile lists, so a repository cannot ask for any other.
function envValue(name, key, value, allowedSecrets, runnerEnv) {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  const secret = value?.secret;
  if (typeof secret !== "string") {
    throw Error(`service ${name}: env ${key} must be a value or {secret: NAME}`);
  }
  if (!allowedSecrets.includes(secret)) {
    throw Error(`service ${name}: secret ${secret} is not allowed for this project`);
  }
  if (!runnerEnv[secret]) throw Error(`service ${name}: secret ${secret} is not set on the runner`);
  return runnerEnv[secret];
}

export function orderByDependencies(services) {
  const byName = new Map(services.map((service) => [service.name, service]));
  const state = new Map();
  const ordered = [];
  const visit = (service, trail) => {
    if (state.get(service.name) === "done") return;
    if (state.get(service.name) === "visiting") {
      throw Error(`services depend on each other in a cycle: ${[...trail, service.name].join(" -> ")}`);
    }
    state.set(service.name, "visiting");
    for (const dependency of service.after) visit(byName.get(dependency), [...trail, service.name]);
    state.set(service.name, "done");
    ordered.push(service);
  };
  for (const service of services) visit(service, []);
  return ordered;
}

// Docker multiplexes a non-TTY container's stdout and stderr into frames with an
// 8-byte header whose last four bytes are the payload length.
export function demuxLogs(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

function stopIfCancelled(record) {
  if (record.cancelled) throw Error("the services were replaced or released");
}

function withTimeout(promise, ms, message) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// One stack per workspace, kept in memory and re-adopted from container labels
// after a runner restart. `hostConfig(profile)` supplies the same resource limits
// and resolver the profile's workers get.
export function createServiceStacks({ docker, shared, hostConfig, timeouts }) {
  const records = new Map();
  const queues = new Map();
  const stackKey = (project, workspace) => `${project}\u0000${workspace}`;

  const labels = (project, workspace, extra) => ({
    [shared.managedLabel]: shared.managedLabelValue,
    "ai.runner.project": project,
    "ai.runner.workspace": workspace,
    ...extra
  });

  async function stackContainers(project, workspace) {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [
          `${shared.managedLabel}=${shared.managedLabelValue}`,
          `ai.runner.project=${project}`,
          `ai.runner.workspace=${workspace}`
        ]
      }
    });
    return containers.filter((info) => stackRoles.has(info.Labels?.["ai.runner.role"]));
  }

  async function logTail(container, tail) {
    try {
      const raw = await container.logs({ stdout: true, stderr: true, tail });
      return Buffer.isBuffer(raw) ? demuxLogs(raw) : String(raw);
    } catch (logError) {
      return `(no logs: ${logError.message})`;
    }
  }

  async function execExitCode(container, cmd) {
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise((resolve) => {
      stream.on("data", () => {});
      stream.once("end", resolve);
      stream.once("error", resolve);
    });
    return (await exec.inspect()).ExitCode;
  }

  async function probe(container, cmd) {
    try {
      return (await withTimeout(execExitCode(container, cmd), timeouts.probeMs, "probe timed out")) === 0;
    } catch {
      return false;
    }
  }

  async function awaitReady(container, service) {
    const deadline = Date.now() + timeouts.readyMs;
    for (;;) {
      const { State } = await container.inspect();
      if (!State.Running) {
        throw Error(`${service.name} stopped (exit ${State.ExitCode}):\n${await logTail(container, failureLogLines)}`);
      }
      if (!service.ready || (await probe(container, service.ready))) return;
      if (Date.now() > deadline) {
        throw Error(
          `${service.name} was not ready within ${timeouts.readyMs} ms:\n${await logTail(container, failureLogLines)}`
        );
      }
      await sleep(timeouts.pollMs);
    }
  }

  async function awaitJob(container, service) {
    const result = await withTimeout(
      container.wait(),
      timeouts.jobMs,
      `${service.name} did not finish within ${timeouts.jobMs} ms`
    );
    if (result.StatusCode !== 0) {
      throw Error(`${service.name} exited ${result.StatusCode}:\n${await logTail(container, failureLogLines)}`);
    }
  }

  async function startService(record, context, service) {
    const { project, workspace, profile, hash } = context;
    await ensureLocalImage(docker, service.image, { pullIfMissing: true });
    stopIfCancelled(record);
    const container = await docker.createContainer({
      name: stackNames(project, workspace).container(service.name),
      Image: service.image,
      ...(service.cmd ? { Cmd: service.cmd } : {}),
      Env: service.env,
      Labels: labels(project, workspace, {
        "ai.runner.role": service.once ? "job" : "service",
        "ai.runner.service": service.name,
        "ai.runner.services-hash": hash
      }),
      HostConfig: { ...hostConfig(profile), NetworkMode: record.network },
      NetworkingConfig: { EndpointsConfig: { [record.network]: { Aliases: [service.name] } } }
    });
    await container.start();
    if (service.once) await awaitJob(container, service);
    else await awaitReady(container, service);
  }

  async function findNetwork(name) {
    const networks = await docker.listNetworks({ filters: { name: [name] } });
    return networks.find((network) => network.Name === name);
  }

  async function removeNetwork(name) {
    const found = await findNetwork(name);
    if (!found) return;
    const network = docker.getNetwork(found.Id);
    const { Containers = {} } = await network.inspect();
    for (const containerId of Object.keys(Containers)) {
      await network.disconnect({ Container: containerId, Force: true });
    }
    await network.remove();
  }

  // `v` takes the anonymous volumes an image declares with it — postgres:16 gets a
  // new one for its data on every start, and each would outlive the stack.
  async function teardown(project, workspace) {
    for (const info of await stackContainers(project, workspace)) {
      await docker.getContainer(info.Id).remove({ force: true, v: true });
    }
    await removeNetwork(stackNames(project, workspace).network);
  }

  // A stack a previous runner process finished is reused as long as it is
  // exactly this definition and still whole: every service running, every job
  // exited 0.
  async function adoptable(context, services) {
    const found = await stackContainers(context.project, context.workspace);
    if (found.length !== services.length) return false;
    return services.every((service) => {
      const info = found.find((container) => container.Labels["ai.runner.service"] === service.name);
      if (!info || info.Labels["ai.runner.services-hash"] !== context.hash) return false;
      return service.once ? /^Exited \(0\)/.test(info.Status || "") : info.State === "running";
    });
  }

  async function build(record, context, services) {
    if (await adoptable(context, services)) return;
    await teardown(context.project, context.workspace);
    stopIfCancelled(record);
    await docker.createNetwork({
      Name: record.network,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: labels(context.project, context.workspace, { "ai.runner.role": "network" })
    });
    for (const [index, service] of services.entries()) {
      stopIfCancelled(record);
      record.step = `${service.name} (${index + 1}/${services.length})`;
      await startService(record, context, service);
    }
  }

  // Every build and teardown of one workspace's stack starts only after the
  // previous one has settled, so two never race for the same names.
  function serialized(key, operation) {
    const run = (queues.get(key) ?? Promise.resolve()).then(operation);
    queues.set(key, run.catch(() => {}));
    return run;
  }

  // Stops a build nobody wants any more. Killing its containers makes it fail
  // its current wait at once instead of sitting out a job's timeout, so whatever
  // is queued behind it can start.
  function cancel(record, project, workspace) {
    if (!record) return;
    record.cancelled = true;
    stackContainers(project, workspace)
      .then((found) =>
        Promise.allSettled(
          found.filter((info) => info.State === "running").map((info) => docker.getContainer(info.Id).kill())
        )
      )
      .catch(() => {});
  }

  // Starts the workspace's stack unless this exact definition is already up or
  // on its way. An edited definition replaces the stack.
  function ensure({ project, workspace, profile, definition, env }) {
    const services = validateServices(definition, { shared, profile, env });
    const hash = definitionHash(definition);
    const key = stackKey(project, workspace);
    const current = records.get(key);
    if (current?.hash === hash) return current;
    cancel(current, project, workspace);

    const record = {
      hash,
      network: stackNames(project, workspace).network,
      status: "starting",
      step: "",
      error: null,
      cancelled: false
    };
    records.set(key, record);
    const context = { project, workspace, profile, hash };
    record.promise = serialized(key, () => build(record, context, services)).then(
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
    await Promise.race([record.promise, sleep(ms)]);
    return record;
  }

  async function attach(containerId, network) {
    const info = await docker.getContainer(containerId).inspect();
    if (info.NetworkSettings?.Networks?.[network]) return;
    await docker.getNetwork(network).connect({ Container: containerId });
  }

  async function logs(project, workspace, name, tail) {
    const info = (await stackContainers(project, workspace)).find(
      (container) => container.Labels["ai.runner.service"] === name
    );
    if (!info) throw Error(`no service ${name} in ${workspace}`);
    return logTail(docker.getContainer(info.Id), tail);
  }

  // `remove` false only forgets the stack, leaving the stopped containers to
  // inspect; the next ensure then finds them not running and builds a new one.
  async function release(project, workspace, { remove }) {
    const key = stackKey(project, workspace);
    cancel(records.get(key), project, workspace);
    records.delete(key);
    if (remove) await serialized(key, () => teardown(project, workspace));
  }

  return { ensure, waitFor, attach, logs, release };
}
