import test from "node:test";
import assert from "node:assert/strict";
import { ensureLocalImage, imageAllowed } from "./worker-image.mjs";

const nodeLts = "nexus.pdtec.lan:5500/linux-nodejs:lts";

test("an exact entry approves only that image", () => {
  assert.equal(imageAllowed(nodeLts, [nodeLts]), true);
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-nodejs:24", [nodeLts]), false);
});

test("a star approves any tag of the repository", () => {
  const patterns = ["nexus.pdtec.lan:5500/linux-dotnet-sdk-nodejs:*"];
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-dotnet-sdk-nodejs:8.0-lts", patterns), true);
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-dotnet-sdk:8.0", patterns), false);
});

test("a star approves repositories by prefix", () => {
  const patterns = ["nexus.pdtec.lan:5500/linux-*"];
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-cypress:15-snapshot-mr-79", patterns), true);
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/windows-dotnet-sdk:8", patterns), false);
});

test("a star does not cross a slash", () => {
  const patterns = ["nexus.pdtec.lan:5500/linux-*"];
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-x/nested:1", patterns), false);
  assert.equal(imageAllowed("docker.io/library/linux-nodejs:lts", ["*/linux-nodejs:lts"]), false);
});

test("a question mark stands for exactly one character", () => {
  const patterns = ["nexus.pdtec.lan:5500/linux-nodejs:2?"];
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-nodejs:24", patterns), true);
  assert.equal(imageAllowed("nexus.pdtec.lan:5500/linux-nodejs:lts", patterns), false);
});

test("dots and other regex characters in an entry match literally", () => {
  assert.equal(imageAllowed("nexusXpdtecXlan:5500/linux-nodejs:lts", ["nexus.pdtec.lan:5500/*"]), false);
});

function fakeDocker({ present = false, inspectError, pullError, events = [], appearsAfterPull = true } = {}) {
  const calls = { inspect: 0, pull: [] };
  let available = present;
  return {
    calls,
    getImage: () => ({
      inspect: async () => {
        calls.inspect += 1;
        if (inspectError) throw inspectError;
        if (!available) throw Object.assign(Error("no such image"), { statusCode: 404 });
        return { Id: "sha256:abc" };
      }
    }),
    pull: async (image) => {
      calls.pull.push(image);
      if (pullError) throw pullError;
      return "stream";
    },
    modem: {
      followProgress: (_stream, onFinished) => {
        if (appearsAfterPull) available = true;
        onFinished(null, events);
      }
    }
  };
}

test("uses an image already on the host without pulling", async () => {
  const docker = fakeDocker({ present: true });
  assert.deepEqual(await ensureLocalImage(docker, nodeLts, { pullIfMissing: true }), { pulled: false });
  assert.deepEqual(docker.calls.pull, []);
});

test("pulls an approved image the host lacks", async () => {
  const docker = fakeDocker();
  assert.deepEqual(await ensureLocalImage(docker, nodeLts, { pullIfMissing: true }), { pulled: true });
  assert.deepEqual(docker.calls.pull, [nodeLts]);
});

test("never pulls an image nobody approved", async () => {
  const docker = fakeDocker();
  await assert.rejects(
    ensureLocalImage(docker, nodeLts, { pullIfMissing: false }),
    /approved local image is not available/
  );
  assert.deepEqual(docker.calls.pull, []);
});

test("an unreachable daemon is not reported as a missing image", async () => {
  const docker = fakeDocker({ inspectError: Error("connect EACCES /var/run/docker.sock") });
  await assert.rejects(
    ensureLocalImage(docker, nodeLts, { pullIfMissing: true }),
    /cannot reach the Docker daemon.*EACCES/
  );
  assert.deepEqual(docker.calls.pull, []);
});

test("a refused pull names the image and the cause", async () => {
  const docker = fakeDocker({ pullError: Error("manifest unknown") });
  await assert.rejects(
    ensureLocalImage(docker, nodeLts, { pullIfMissing: true }),
    /cannot pull nexus\.pdtec\.lan:5500\/linux-nodejs:lts: manifest unknown/
  );
});

test("a registry error inside the progress stream fails the pull", async () => {
  const docker = fakeDocker({ events: [{ status: "Pulling" }, { error: "unauthorized" }] });
  await assert.rejects(
    ensureLocalImage(docker, nodeLts, { pullIfMissing: true }),
    /cannot pull .*: unauthorized/
  );
});

test("a pull that leaves no image behind is an error", async () => {
  const docker = fakeDocker({ appearsAfterPull: false });
  await assert.rejects(
    ensureLocalImage(docker, nodeLts, { pullIfMissing: true }),
    /still does not have it/
  );
});
