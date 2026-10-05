import test from "node:test";
import assert from "node:assert/strict";
import { commandEnv } from "./command-env.mjs";

const licence = "data:text/xml;base64,AAAA";
const profile = { allowedSecrets: { ICE_LICENSE_8: "The ice.NET 8 licence." } };
const secrets = { ICE_LICENSE_8: licence, GITLAB_API_TOKEN: "glpat-secret" };
const resolve = (env, overrides = {}) => commandEnv(env, { profile, secrets, ...overrides });

test("a request without env adds nothing", () => {
  assert.deepEqual(resolve(undefined), []);
  assert.deepEqual(resolve(null), []);
});

test("a plain value is passed as written", () => {
  assert.deepEqual(resolve({ ICE_DB_SERVICE: "PostgreSQL" }), ["ICE_DB_SERVICE=PostgreSQL"]);
});

test("an allowed secret is filled in under the name the project chose", () => {
  assert.deepEqual(resolve({ ICE_LIC_PATH: "${ICE_LICENSE_8}" }), [`ICE_LIC_PATH=${licence}`]);
});

test("a secret inside a longer value is filled in", () => {
  assert.deepEqual(resolve({ LICENCE: "prefix-${ICE_LICENSE_8}" }), [`LICENCE=prefix-${licence}`]);
});

test("a list of allowed secret names works like a described map", () => {
  assert.deepEqual(
    resolve({ ICE_LIC_PATH: "${ICE_LICENSE_8}" }, { profile: { allowedSecrets: ["ICE_LICENSE_8"] } }),
    [`ICE_LIC_PATH=${licence}`]
  );
});

test("a secret outside allowedSecrets is refused by name, without its value", () => {
  assert.throws(
    () => resolve({ TOKEN: "${GITLAB_API_TOKEN}" }),
    (error) =>
      error.message === "env uses GITLAB_API_TOKEN, which is not in this project's allowedSecrets" &&
      !error.message.includes("glpat-secret")
  );
});

test("a profile without allowedSecrets fills in nothing", () => {
  assert.throws(() => resolve({ ICE_LIC_PATH: "${ICE_LICENSE_8}" }, { profile: {} }), /not in this project's allowedSecrets/);
});

test("an allowed secret the runner lacks is refused", () => {
  assert.throws(
    () => resolve({ ICE_LIC_PATH: "${ICE_LICENSE_8}" }, { secrets: {} }),
    /^Error: ICE_LICENSE_8 is not set on the runner$/
  );
});

test("an invalid variable name is refused", () => {
  assert.throws(() => resolve({ "ICE-LIC": "x" }), /env ICE-LIC is not a valid variable name/);
});

test("a value that is not a string is refused", () => {
  assert.throws(() => resolve({ PORT: 8080 }), /env PORT must be a string/);
});

test("env that is not a map is refused", () => {
  assert.throws(() => resolve(["ICE_LIC_PATH=x"]), /env must be a map/);
  assert.throws(() => resolve("ICE_LIC_PATH=x"), /env must be a map/);
});
