import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkComposeConfig,
  checkVariables,
  composeProjectName,
  createServiceStacks,
  definitionHash,
  projectNetwork
} from "./workspace-compose.mjs";

const db = "postgres:16";
const cli = "nexus.pdtec.lan:5500/pdtec-tetra-cli:v84004.2.0";
const api = "nexus.pdtec.lan:5500/pdtec-tetra-devapps-api:v84004.2.0";
const shared = {
  managedLabel: "ai.runner.managed",
  managedLabelValue: "true",
  allowedImages: [db, "nexus.pdtec.lan:5500/pdtec-tetra-*"]
};
const allow = shared.allowedImages;
const profile = { allowedSecrets: ["TETRA_ICE_LIC_PATH"] };
const env = { TETRA_ICE_LIC_PATH: "data:text/xml;base64,AAAA", GITLAB_API_TOKEN: "glpat-secret" };
const project = "simple-ng-proj";
const workspace = "simple-ng-proj/issue-21";
const projectName = composeProjectName(project, workspace);

// `docker compose config --format json` of the Tetra dev stack.
const tetra = ({ password = "pdtec" } = {}) => ({
  name: projectName,
  networks: { default: { name: projectNetwork(projectName), ipam: {} } },
  services: {
    "tetra-db": {
      image: db,
      environment: { POSTGRES_PASSWORD: password },
      healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1"] },
      networks: { default: null },
      volumes: [{ type: "volume", source: "data", target: "/var/lib/postgresql/data", volume: {} }]
    },
    "tetra-schema": {
      image: cli,
      command: ["platform-apps", "install"],
      depends_on: { "tetra-db": { condition: "service_healthy", required: true } },
      networks: { default: null }
    },
    "tetra-api": {
      image: api,
      environment: { ICE_LIC_PATH: env.TETRA_ICE_LIC_PATH },
      depends_on: { "tetra-schema": { condition: "service_completed_successfully", required: true } },
      networks: { default: null }
    }
  },
  volumes: { data: { name: `${projectName}_data` } },
  "x-ice": { ICE_DB_SERVICE: "PostgreSQL" }
});

const check = (config) => checkComposeConfig(config, { projectName, allow });
const withService = (name, service) => {
  const config = tetra();
  config.services[name] = { ...config.services[name], ...service };
  return config;
};

test("the Tetra dev stack passes as Compose normalizes it", () => {
  assert.deepEqual(check(tetra()), ["tetra-db", "tetra-schema", "tetra-api"]);
});

test("an image off the allowlist is refused and the allowlist named", () => {
  assert.throws(
    () => check(withService("tetra-db", { image: "mysql:8" })),
    /service tetra-db: image is not on the allowlist: mysql:8\. Approved: postgres:16/
  );
});

test("anything that reaches past the project is refused by name", () => {
  const published = [{ mode: "ingress", target: 5432, published: "5432", protocol: "tcp" }];
  assert.throws(() => check(withService("tetra-db", { ports: published })), /tetra-db may not set ports/);
  assert.throws(
    () => check(withService("tetra-db", { privileged: true, container_name: "db" })),
    /may not set privileged, container_name/
  );
  assert.throws(() => check(withService("tetra-db", { network_mode: "host" })), /may not set network_mode/);
});

test("a bind mount is refused, the socket included", () => {
  const socket = { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", bind: {} };
  assert.throws(
    () => check(withService("tetra-api", { volumes: [socket] })),
    /bind mount \/var\/run\/docker\.sock:\/var\/run\/docker\.sock is not allowed/
  );
});

test("a volume that is not the workspace's own is refused", () => {
  const config = tetra();
  config.volumes.data = { name: "hermes-workspace", external: true };
  assert.throws(() => check(config), /volume data must be a plain volume of the workspace/);
});

test("services may use only the default network", () => {
  const config = tetra();
  config.networks.default.driver = "macvlan";
  assert.throws(() => check(config), /network default: services share the workspace's default network/);
  assert.throws(
    () => check(withService("tetra-api", { networks: { default: null, lan: null } })),
    /tetra-api may join only the default network/
  );
});

test("the runner's own labels are reserved", () => {
  assert.throws(
    () => check(withService("tetra-api", { labels: { "ai.runner.image": cli } })),
    /label ai\.runner\.image is reserved for the runner/
  );
});

test("top-level secrets and configs are refused", () => {
  assert.throws(() => check({ ...tetra(), secrets: { lic: { file: "/etc/shadow" } } }), /top-level secrets/);
});

test("a variable outside allowedSecrets is refused", () => {
  const variables = { GITLAB_API_TOKEN: { Name: "GITLAB_API_TOKEN", DefaultValue: "" } };
  assert.throws(
    () => checkVariables(variables, { allowedSecrets: profile.allowedSecrets, secrets: {} }),
    /uses variable GITLAB_API_TOKEN, which is not in this project's allowedSecrets/
  );
});

test("an allowed secret the runner lacks is refused unless the file gives a default", () => {
  const unset = { TETRA_ICE_LIC_PATH: { Name: "TETRA_ICE_LIC_PATH", DefaultValue: "" } };
  const defaulted = { TETRA_ICE_LIC_PATH: { Name: "TETRA_ICE_LIC_PATH", DefaultValue: "none" } };
  const context = { allowedSecrets: profile.allowedSecrets, secrets: {} };
  assert.throws(() => checkVariables(unset, context), /variable TETRA_ICE_LIC_PATH is not set on the runner/);
  assert.doesNotThrow(() => checkVariables(defaulted, context));
});

test("a definition's hash ignores key order and follows every change", () => {
  const { services, ...rest } = tetra();
  assert.equal(definitionHash({ services, ...rest }), definitionHash(tetra()));
  assert.notEqual(definitionHash(tetra({ password: "other" })), definitionHash(tetra()));
});

// `docker compose` for one host: `config` answers with a fixed normalized file,
// `up` creates a container per service from the runner's override.
function fakeCompose(docker, { config = tetra(), variables = {}, upCode = 0, jobExitCode = 0 } = {}) {
  const calls = [];
  const subcommand = (args) => args.find((arg) => ["config", "up", "down", "stop", "logs"].includes(arg));
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    switch (subcommand(args)) {
      case "config":
        return { code: 0, stdout: JSON.stringify(args.includes("--variables") ? variables : run.config), stderr: "" };
      case "up": {
        const override = JSON.parse(fs.readFileSync(args[args.lastIndexOf("-f") + 1], "utf8"));
        for (const [name, service] of Object.entries(override.services)) {
          const job = name === "tetra-schema";
          docker.addContainer({
            Labels: { ...service.labels, "com.docker.compose.project": projectName },
            State: job ? "exited" : "running",
            Status: job ? `Exited (${jobExitCode}) 1 second ago` : "Up 1 second"
          });
        }
        return upCode === 0
          ? { code: 0, stdout: "", stderr: "" }
          : { code: upCode, stdout: "", stderr: `service "tetra-schema" didn't complete successfully: exit ${jobExitCode}` };
      }
      case "down":
        docker.containers.clear();
        return { code: 0, stdout: "", stderr: "" };
      case "logs":
        return { code: 0, stdout: "cannot install schema\n", stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
  run.config = config;
  run.calls = calls;
  run.ran = (name) => calls.filter((call) => subcommand(call.args) === name);
  return run;
}

// Just enough of dockerode: containers to list by label, and one network.
function fakeDocker() {
  const containers = new Map();
  const events = [];
  let nextId = 1;
  const matches = (labels, filters) =>
    (filters?.label || []).every((entry) => {
      const [key, value] = entry.split("=");
      return labels[key] === value;
    });
  return {
    containers,
    events,
    addContainer(info) {
      const Id = `c${nextId++}`;
      containers.set(Id, { Id, networks: {}, ...info });
      return Id;
    },
    listContainers: async ({ filters }) => [...containers.values()].filter((info) => matches(info.Labels, filters)),
    getContainer: (id) => ({
      inspect: async () => ({ NetworkSettings: { Networks: containers.get(id).networks } })
    }),
    listNetworks: async () => [{ Id: "n1", Name: projectNetwork(projectName) }],
    getNetwork: () => ({
      inspect: async () => ({ Containers: { w1: {} } }),
      disconnect: async ({ Container }) => {
        events.push(`disconnect ${Container}`);
      },
      connect: async ({ Container }) => {
        events.push(`connect ${Container}`);
      }
    })
  };
}

const serviceOptions = () => ({ mem_limit: 1024, dns: ["10.30.28.1"] });

function stacksOn(docker, compose) {
  return createServiceStacks({ compose, docker, shared, serviceOptions, timeouts: { upMs: 1000 } });
}

async function settled(stacks, text = "services: {}\n") {
  const record = await stacks.ensure({ project, workspace, profile, text, env });
  await record.promise;
  return record;
}

test("a compose file becomes one Compose project per workspace, on its own network", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker);
  const record = await settled(stacksOn(docker, compose), "the repository's text\n");

  assert.equal(record.status, "ready");
  assert.equal(record.network, `${projectName}_default`);
  const [up] = compose.ran("up");
  assert.deepEqual(up.args.slice(0, 2), ["-p", projectName]);
  assert.equal(up.args.filter((arg, index) => up.args[index - 1] === "-f").length, 2);
  assert.ok(up.args.includes("--wait"));
  const api = [...docker.containers.values()].find((info) => info.Labels["ai.runner.service"] === "tetra-api");
  assert.equal(api.Labels["ai.runner.workspace"], workspace);
  assert.equal(api.Labels["ai.runner.role"], "service");
});

test("the runner adds its labels, limits and resolver to every service", async () => {
  const docker = fakeDocker();
  let override;
  const compose = fakeCompose(docker);
  const recording = async (args, options) => {
    if (args.includes("up")) override = JSON.parse(fs.readFileSync(args[args.lastIndexOf("-f") + 1], "utf8"));
    return compose(args, options);
  };
  await settled(stacksOn(docker, recording));

  assert.deepEqual(Object.keys(override.services), ["tetra-db", "tetra-schema", "tetra-api"]);
  const dbOverride = override.services["tetra-db"];
  assert.equal(dbOverride.mem_limit, 1024);
  assert.deepEqual(dbOverride.dns, ["10.30.28.1"]);
  assert.equal(dbOverride.restart, "no");
  assert.equal(dbOverride.labels["ai.runner.managed"], "true");
});

test("compose sees only the secrets the profile lists", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker);
  await settled(stacksOn(docker, compose));

  for (const call of compose.calls.filter((item) => item.options.secrets)) {
    assert.deepEqual(call.options.secrets, { TETRA_ICE_LIC_PATH: env.TETRA_ICE_LIC_PATH });
  }
  assert.equal(compose.ran("up")[0].options.secrets.TETRA_ICE_LIC_PATH, env.TETRA_ICE_LIC_PATH);
});

test("a refused file starts nothing", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker, { config: withService("tetra-db", { privileged: true }) });
  await assert.rejects(
    stacksOn(docker, compose).ensure({ project, workspace, profile, text: "x", env }),
    /tetra-db may not set privileged/
  );
  assert.equal(compose.ran("up").length, 0);
});

test("a job that exits non-zero fails the stack with Compose's error and its logs", async () => {
  const docker = fakeDocker();
  const record = await settled(stacksOn(docker, fakeCompose(docker, { upCode: 1, jobExitCode: 3 })));
  assert.equal(record.status, "failed");
  assert.match(record.error, /tetra-schema" didn't complete successfully: exit 3\n--- tetra-schema ---\ncannot install schema/);
});

test("asking again for the same file is the same build", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker);
  const stacks = stacksOn(docker, compose);
  const first = await stacks.ensure({ project, workspace, profile, text: "x", env });
  const second = await stacks.ensure({ project, workspace, profile, text: "x", env });
  await second.promise;
  assert.equal(first, second);
  assert.equal(compose.ran("up").length, 1);
});

test("a stack an earlier runner process left whole is adopted", async () => {
  const docker = fakeDocker();
  await settled(stacksOn(docker, fakeCompose(docker)));

  const compose = fakeCompose(docker);
  const record = await settled(stacksOn(docker, compose));
  assert.equal(record.status, "ready");
  assert.equal(compose.ran("up").length, 0);
  assert.equal(compose.ran("down").length, 0);
});

test("an edited file takes the old stack down before the new one comes up", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker);
  const stacks = stacksOn(docker, compose);
  await settled(stacks);
  compose.config = tetra({ password: "other" });

  const record = await settled(stacks);
  assert.equal(record.status, "ready");
  const order = compose.calls.map((call) => call.args.find((arg) => ["up", "down"].includes(arg))).filter(Boolean);
  assert.deepEqual(order, ["down", "up", "down", "up"]);
  assert.equal(docker.containers.size, 3);
});

test("release with remove disconnects the workers and takes the project down with its volumes", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker);
  const stacks = stacksOn(docker, compose);
  await settled(stacks);
  const downsBefore = compose.ran("down").length;

  await stacks.release(project, workspace, { remove: true });
  const down = compose.ran("down").at(-1);
  assert.equal(compose.ran("down").length, downsBefore + 1);
  assert.deepEqual(down.args.slice(0, 2), ["-p", projectName]);
  assert.ok(down.args.includes("--volumes"));
  assert.ok(docker.events.includes("disconnect w1"));
});

test("release without remove only stops the stack", async () => {
  const docker = fakeDocker();
  const compose = fakeCompose(docker);
  const stacks = stacksOn(docker, compose);
  await settled(stacks);
  const downsBefore = compose.ran("down").length;

  await stacks.release(project, workspace, { remove: false });
  assert.equal(compose.ran("stop").length, 1);
  assert.equal(compose.ran("down").length, downsBefore);
});

test("a worker already on the stack's network is not connected again", async () => {
  const docker = fakeDocker();
  const stacks = stacksOn(docker, fakeCompose(docker));
  const { network } = await settled(stacks);
  const workerId = docker.addContainer({ Labels: {} });
  docker.events.length = 0;

  await stacks.attach(workerId, network);
  docker.containers.get(workerId).networks[network] = {};
  await stacks.attach(workerId, network);
  assert.deepEqual(docker.events, [`connect ${workerId}`]);
});

test("logs are read by service name only", async () => {
  const docker = fakeDocker();
  const stacks = stacksOn(docker, fakeCompose(docker));
  assert.equal(await stacks.logs(project, workspace, "tetra-schema", 10), "cannot install schema\n");
  await assert.rejects(stacks.logs(project, workspace, "--follow", 10), /service must be a service name/);
});
