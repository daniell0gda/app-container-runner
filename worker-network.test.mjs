import test from "node:test";
import assert from "node:assert/strict";
import { workerNetworkOptions } from "./worker-network.mjs";

test("unset leaves the worker on Docker's default bridge", () => {
  assert.deepEqual(workerNetworkOptions(undefined), {});
});

test("puts the worker on the profile's network", () => {
  assert.deepEqual(workerNetworkOptions("tetra"), { NetworkMode: "tetra" });
});

test("refuses the host's network namespace", () => {
  assert.throws(() => workerNetworkOptions("host"), /other than host/);
});

test("refuses another container's network namespace", () => {
  assert.throws(() => workerNetworkOptions("container:tetra-server"), /other than host/);
});
