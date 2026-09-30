import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createServiceStacks,
  definitionHash,
  demuxLogs,
  stackNames,
  validateServices
} from "./workspace-services.mjs";

const db = "postgres:16";
const api = "nexus.pdtec.lan:5500/pdtec-tetra-devapps-api:v84004.2.0";
const shared = {
  managedLabel: "ai.runner.managed",
  managedLabelValue: "true",
  allowedImages: [db, "nexus.pdtec.lan:5500/pdtec-tetra-*"]
};
const profile = { allowedSecrets: ["TETRA_ICE_LIC_PATH"] };
const env = { TETRA_ICE_LIC_PATH: "data:text/xml;base64,AAAA" };
const project = "simple-ng-proj";
const workspace = "simple-ng-proj/issue-21";

const tetra = () => ({
  api: {
    image: api,
    after: ["schema"],
    env: { ICE_DB_SERVICE: "PostgreSQL", ICE_LIC_PATH: { secret: "TETRA_ICE_LIC_PATH" } }
  },
  schema: { image: "nexus.pdtec.lan:5500/pdtec-tetra-cli:v84004.2.0", once: true, after: ["db"] },
  db: { image: db, env: { POSTGRES_PASSWORD: "pdtec" }, ready: ["pg_isready", "-U", "postgres"] }
});

const validate = (definition) => validateServices(definition, { shared, profile, env });

test("services start after the ones they name", () => {
  assert.deepEqual(
    validate(tetra()).map((service) => service.name),
    ["db", "schema", "api"]
  );
});

test("a secret comes from the runner's environment, a literal as written", () => {
  const apiService = validate(tetra()).find((service) => service.name === "api");
  assert.deepEqual(apiService.env, ["ICE_DB_SERVICE=PostgreSQL", `ICE_LIC_PATH=${env.TETRA_ICE_LIC_PATH}`]);
});

test("an image off the allowlist is refused and the allowlist named", () => {
  assert.throws(
    () => validate({ db: { image: "mysql:8" } }),
    /service db: image is not on the allowlist: mysql:8\. Approved: postgres:16/
  );
});

test("a secret the profile does not list is refused", () => {
  assert.throws(
    () => validate({ db: { image: db, env: { PASSWORD: { secret: "GITLAB_API_TOKEN" } } } }),
    /secret GITLAB_API_TOKEN is not allowed for this project/
  );
});

test("an allowed secret the runner does not have is refused", () => {
  assert.throws(
    () =>
      validateServices(tetra(), { shared, profile, env: {} }),
    /secret TETRA_ICE_LIC_PATH is not set on the runner/
  );
});

test("after may only name another declared service", () => {
  assert.throws(() => validate({ db: { image: db, after: ["cache"] } }), /unknown service cache/);
  assert.throws(() => validate({ db: { image: db, after: ["db"] } }), /unknown service db/);
});

test("services that wait on each other are refused", () => {
  assert.throws(
    () => validate({ a: { image: db, after: ["b"] }, b: { image: db, after: ["a"] } }),
    /cycle: a -> b -> a/
  );
});

test("service names must be usable as host names", () => {
  assert.throws(() => validate({ Tetra_DB: { image: db } }), /lowercase letters, digits and dashes/);
});

test("cmd and ready must be lists of strings", () => {
  assert.throws(() => validate({ db: { image: db, cmd: "postgres -c fsync=off" } }), /cmd must be/);
  assert.throws(() => validate({ db: { image: db, ready: [] } }), /ready must be/);
});

test("a definition's hash ignores key order and follows every change", () => {
  const reordered = { db: tetra().db, schema: tetra().schema, api: tetra().api };
  assert.equal(definitionHash(reordered), definitionHash(tetra()));
  assert.notEqual(definitionHash({ ...tetra(), db: { image: db } }), definitionHash(tetra()));
});

test("demuxed logs are the frames' payloads in order", () => {
  assert.equal(demuxLogs(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")])), "out\nerr\n");
});

function frame(stream, text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// Just enough of dockerode for one host: containers, networks, and an image
// store that already has everything.
function fakeDocker({ jobExitCode = 0, readyAfterProbes = 0 } = {}) {
  const containers = new Map();
  const networks = new Map();
  const events = [];
  let nextId = 1;
  let probes = 0;
  const notFound = () => Object.assign(Error("no such container"), { statusCode: 404 });
  const matches = (labels, filters) =>
    (filters?.label || []).every((entry) => {
      const [key, value] = entry.split("=");
      return labels[key] === value;
    });

  const container = (id) => ({
    inspect: async () => {
      const found = containers.get(id);
      if (!found) throw notFound();
      return {
        State: { Running: found.State === "running", ExitCode: found.exitCode },
        NetworkSettings: { Networks: found.networks }
      };
    },
    start: async () => {
      const found = containers.get(id);
      events.push(`start ${found.name}`);
      const job = found.Labels["ai.runner.role"] === "job";
      found.State = job ? "exited" : "running";
      found.exitCode = job ? jobExitCode : 0;
      found.Status = job ? `Exited (${jobExitCode}) 1 second ago` : "Up 1 second";
    },
    wait: async () => ({ StatusCode: containers.get(id).exitCode }),
    kill: async () => {
      containers.get(id).State = "exited";
    },
    remove: async () => {
      if (!containers.has(id)) throw notFound();
      events.push(`remove ${containers.get(id).name}`);
      containers.delete(id);
    },
    logs: async () => frame(2, "boom\n"),
    exec: async () => ({
      start: async () => Readable.from([]),
      inspect: async () => ({ ExitCode: probes++ >= readyAfterProbes ? 0 : 1 })
    })
  });

  const network = (id) => {
    const entry = () => [...networks.values()].find((item) => item.Id === id);
    return {
      inspect: async () => ({ Containers: {} }),
      disconnect: async () => {},
      remove: async () => {
        events.push(`remove network ${entry().Name}`);
        networks.delete(entry().Name);
      },
      connect: async ({ Container }) => {
        events.push(`connect ${Container}`);
      }
    };
  };

  return {
    containers,
    networks,
    events,
    getImage: () => ({ inspect: async () => ({ Id: "sha256:abc" }) }),
    listContainers: async ({ filters }) =>
      [...containers.values()]
        .filter((info) => matches(info.Labels, filters))
        .map(({ Id, Labels, State, Status }) => ({ Id, Labels, State, Status })),
    createContainer: async (options) => {
      const Id = `c${nextId++}`;
      const name = options.Labels["ai.runner.service"];
      events.push(`create ${name}`);
      containers.set(Id, {
        Id,
        name,
        options,
        Labels: options.Labels,
        State: "created",
        networks: { [options.HostConfig.NetworkMode]: {} }
      });
      return container(Id);
    },
    getContainer: container,
    createNetwork: async (options) => {
      events.push(`network ${options.Name}`);
      networks.set(options.Name, { Id: `n-${options.Name}`, Name: options.Name, Labels: options.Labels });
    },
    listNetworks: async ({ filters }) =>
      [...networks.values()].filter((item) => item.Name.includes(filters.name[0])),
    getNetwork: network
  };
}

const timeouts = { readyMs: 100, jobMs: 100, probeMs: 50, pollMs: 1 };

function stacksOn(docker) {
  return createServiceStacks({ docker, shared, hostConfig: () => ({ Memory: 1 }), timeouts });
}

async function settled(stacks, definition = tetra()) {
  const record = stacks.ensure({ project, workspace, profile, definition, env });
  await record.promise;
  return record;
}

test("a stack gets its own network, then each service in order", async () => {
  const docker = fakeDocker();
  const record = await settled(stacksOn(docker));
  const { network } = stackNames(project, workspace);

  assert.equal(record.status, "ready");
  assert.equal(record.network, network);
  assert.deepEqual(docker.events, [
    `network ${network}`,
    "create db",
    "start db",
    "create schema",
    "start schema",
    "create api",
    "start api"
  ]);
  const apiOptions = [...docker.containers.values()].find((item) => item.name === "api").options;
  assert.equal(apiOptions.HostConfig.NetworkMode, network);
  assert.deepEqual(apiOptions.NetworkingConfig.EndpointsConfig[network].Aliases, ["api"]);
  assert.equal(apiOptions.Labels["ai.runner.image"], undefined);
  assert.equal(apiOptions.HostConfig.Binds, undefined);
});

test("a job that exits non-zero fails the stack with its logs", async () => {
  const record = await settled(stacksOn(fakeDocker({ jobExitCode: 3 })));
  assert.equal(record.status, "failed");
  assert.match(record.error, /schema exited 3:\nboom/);
});

test("a service that never passes its ready check fails the stack", async () => {
  const record = await settled(stacksOn(fakeDocker({ readyAfterProbes: Infinity })));
  assert.equal(record.status, "failed");
  assert.match(record.error, /db was not ready within 100 ms/);
});

test("a service is ready once its ready check passes", async () => {
  const record = await settled(stacksOn(fakeDocker({ readyAfterProbes: 3 })));
  assert.equal(record.status, "ready");
});

test("asking again for the same definition is the same build", async () => {
  const docker = fakeDocker();
  const stacks = stacksOn(docker);
  const first = stacks.ensure({ project, workspace, profile, definition: tetra(), env });
  const second = stacks.ensure({ project, workspace, profile, definition: tetra(), env });
  await second.promise;
  assert.equal(first, second);
  assert.equal(docker.events.filter((event) => event === "create db").length, 1);
});

test("a stack an earlier runner process left whole is adopted", async () => {
  const docker = fakeDocker();
  await settled(stacksOn(docker));
  docker.events.length = 0;

  const record = await settled(stacksOn(docker));
  assert.equal(record.status, "ready");
  assert.deepEqual(docker.events, []);
});

test("an edited definition replaces the stack", async () => {
  const docker = fakeDocker();
  const stacks = stacksOn(docker);
  await settled(stacks);
  const edited = { ...tetra(), db: { ...tetra().db, env: { POSTGRES_PASSWORD: "other" } } };

  const record = await settled(stacks, edited);
  assert.equal(record.status, "ready");
  assert.equal(docker.containers.size, 3);
  const db = [...docker.containers.values()].find((item) => item.name === "db");
  assert.deepEqual(db.options.Env, ["POSTGRES_PASSWORD=other"]);
});

test("release with remove takes the containers and the network", async () => {
  const docker = fakeDocker();
  const stacks = stacksOn(docker);
  await settled(stacks);

  await stacks.release(project, workspace, { remove: true });
  assert.equal(docker.containers.size, 0);
  assert.equal(docker.networks.size, 0);
});

test("a worker already on the stack's network is not connected again", async () => {
  const docker = fakeDocker();
  const stacks = stacksOn(docker);
  const { network } = await settled(stacks);
  await docker.createContainer({ Labels: {}, HostConfig: { NetworkMode: "bridge" } });
  const workerId = [...docker.containers.keys()].at(-1);
  docker.events.length = 0;

  await stacks.attach(workerId, network);
  docker.containers.get(workerId).networks[network] = {};
  await stacks.attach(workerId, network);
  assert.deepEqual(docker.events, [`connect ${workerId}`]);
});
