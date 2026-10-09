import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProfileStore } from "./profile-store.mjs";
import { migrateProfiles } from "./migrate-profiles.mjs";

const shared = {
  hostWorkspaceRoot: "/host",
  hermesWorkspaceRoot: "/hermes",
  defaultWorkerWorkspaceRoot: "/workspaces",
  managedLabel: "ai.runner.managed",
  managedLabelValue: "true"
};

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "profile-store-"));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function setup({ legacy, folder } = {}) {
  const root = await tempDir();
  const profilesFile = path.join(root, "profiles.json");
  const profilesDir = path.join(root, "profiles");
  if (legacy) await writeJson(profilesFile, legacy);
  if (folder) {
    await fs.mkdir(profilesDir, { recursive: true });
    for (const [name, value] of Object.entries(folder)) {
      if (typeof value === "string") await fs.writeFile(path.join(profilesDir, name), value);
      else await writeJson(path.join(profilesDir, name), value);
    }
  }
  return { root, profilesFile, profilesDir };
}

function collectWarnings() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

test("legacy profiles.json only", async () => {
  const paths = await setup({ legacy: { shared, profiles: { "a,b": { image: "x" }, c: { image: "y" } } } });
  const store = await loadProfileStore(paths);
  assert.deepEqual(store.shared, shared);
  assert.deepEqual(Object.keys(store.profiles).sort(), ["a", "b", "c"]);
  assert.equal(store.profiles.a, store.profiles.b);
  assert.deepEqual(store.sources, [paths.profilesFile]);
});

test("legacy only, with an empty profiles folder holding .gitkeep", async () => {
  const paths = await setup({ legacy: { shared, profiles: { a: {} } }, folder: { ".gitkeep": "" } });
  const store = await loadProfileStore(paths);
  assert.deepEqual(Object.keys(store.profiles), ["a"]);
  assert.deepEqual(store.sources, [paths.profilesFile]);
});

test("profiles folder only", async () => {
  const paths = await setup({
    folder: { "_shared.json": shared, "proj.json": { image: "x" }, "other.v2.json": { image: "y" } }
  });
  const store = await loadProfileStore(paths);
  assert.deepEqual(store.shared, shared);
  assert.deepEqual(Object.keys(store.profiles).sort(), ["other.v2", "proj"]);
  assert.deepEqual(store.profiles.proj, { image: "x" });
  assert.deepEqual(store.sources, [paths.profilesDir]);
});

test("folder aliases share one object and are stripped", async () => {
  const paths = await setup({ folder: { "_shared.json": shared, "a.json": { aliases: ["b", "c"], image: "x" } } });
  const store = await loadProfileStore(paths);
  assert.deepEqual(Object.keys(store.profiles).sort(), ["a", "b", "c"]);
  assert.equal(store.profiles.a, store.profiles.b);
  assert.equal(store.profiles.a, store.profiles.c);
  assert.deepEqual(store.profiles.a, { image: "x" });
});

test("invalid aliases error", async () => {
  const paths = await setup({ folder: { "_shared.json": shared, "a.json": { aliases: "b" } } });
  await assert.rejects(loadProfileStore(paths), /aliases must be a list/);
});

test("both formats are merged; shared from legacy when the folder has none", async () => {
  const paths = await setup({
    legacy: { shared, profiles: { "old,legacy": { image: "o" } } },
    folder: { "new.json": { aliases: ["fresh"], image: "n" } }
  });
  const { warnings, warn } = collectWarnings();
  const store = await loadProfileStore({ ...paths, warn });
  assert.deepEqual(Object.keys(store.profiles).sort(), ["fresh", "legacy", "new", "old"]);
  assert.deepEqual(store.shared, shared);
  assert.deepEqual(store.sources, [paths.profilesFile, paths.profilesDir]);
  assert.deepEqual(warnings, []);
});

test("identical shared in both formats does not warn", async () => {
  const paths = await setup({
    legacy: { shared: { ...shared }, profiles: { a: {} } },
    folder: { "_shared.json": Object.fromEntries(Object.entries(shared).reverse()), "b.json": {} }
  });
  const { warnings, warn } = collectWarnings();
  await loadProfileStore({ ...paths, warn });
  assert.deepEqual(warnings, []);
});

test("a duplicate name across sources errors", async () => {
  const paths = await setup({ legacy: { shared, profiles: { a: {} } }, folder: { "a.json": {} } });
  await assert.rejects(loadProfileStore(paths), /duplicate profile key: a/);
});

test("a duplicate alias across sources errors", async () => {
  const paths = await setup({ legacy: { shared, profiles: { "x,b": {} } }, folder: { "a.json": { aliases: ["b"] } } });
  await assert.rejects(loadProfileStore(paths), /duplicate profile key: b/);
});

test("a duplicate inside the folder errors", async () => {
  const paths = await setup({ folder: { "_shared.json": shared, "a.json": {}, "b.json": { aliases: ["a"] } } });
  await assert.rejects(loadProfileStore(paths), /duplicate profile key: a/);
});

test("shared mismatch: _shared.json wins and a warning is logged", async () => {
  const paths = await setup({
    legacy: { shared: { ...shared, managedLabel: "legacy" }, profiles: { a: {} } },
    folder: { "_shared.json": { ...shared, managedLabel: "folder" } }
  });
  const { warnings, warn } = collectWarnings();
  const store = await loadProfileStore({ ...paths, warn });
  assert.equal(store.shared.managedLabel, "folder");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /differ/);
});

test("a bad project file name errors", async () => {
  for (const name of ["-bad.json", "has space.json"]) {
    const paths = await setup({ folder: { "_shared.json": shared, [name]: {} } });
    await assert.rejects(loadProfileStore(paths), /file name must match/);
  }
});

test("other _ and . files are ignored", async () => {
  const paths = await setup({
    folder: { "_shared.json": shared, "_notes.json": { x: 1 }, ".hidden.json": {}, ".gitkeep": "", "a.json": {} }
  });
  const store = await loadProfileStore(paths);
  assert.deepEqual(Object.keys(store.profiles), ["a"]);
});

test("missing shared errors", async () => {
  const folderOnly = await setup({ folder: { "a.json": {} } });
  await assert.rejects(loadProfileStore(folderOnly), /must define a shared object/);
  const legacyOnly = await setup({ legacy: { profiles: { a: {} } } });
  await assert.rejects(loadProfileStore(legacyOnly), /must define a shared object/);
});

test("incomplete shared errors", async () => {
  const paths = await setup({ folder: { "_shared.json": { ...shared, managedLabel: 1 }, "a.json": {} } });
  await assert.rejects(loadProfileStore(paths), /shared settings are incomplete/);
});

test("neither format present errors", async () => {
  const paths = await setup();
  await assert.rejects(loadProfileStore(paths), /no profiles found/);
  const emptyFolder = await setup({ folder: { ".gitkeep": "" } });
  await assert.rejects(loadProfileStore(emptyFolder), /no profiles found/);
});

test("no profiles loaded errors", async () => {
  const paths = await setup({ folder: { "_shared.json": shared } });
  await assert.rejects(loadProfileStore(paths), /no profiles loaded/);
});

test("HOST_WORKSPACE_ROOT override applies without touching the source object", async () => {
  const paths = await setup({ folder: { "_shared.json": shared, "a.json": {} } });
  const store = await loadProfileStore({ ...paths, hostWorkspaceRoot: "volume-name" });
  assert.equal(store.shared.hostWorkspaceRoot, "volume-name");
  const again = await loadProfileStore(paths);
  assert.equal(again.shared.hostWorkspaceRoot, "/host");
});

test("migration round-trips and is idempotent", async () => {
  const legacy = { shared, profiles: { "a,b": { image: "x", env: { K: "v" } }, c: { image: "y" } } };
  const paths = await setup({ legacy });
  const before = await fs.readFile(paths.profilesFile, "utf8");
  const expected = await loadProfileStore(paths);

  const first = await migrateProfiles(paths);
  assert.equal(first.written.length, 3);
  assert.deepEqual(first.unchanged, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(paths.profilesDir, "a.json"), "utf8")), {
    aliases: ["b"],
    image: "x",
    env: { K: "v" }
  });
  assert.equal(await fs.readFile(paths.profilesFile, "utf8"), before);

  const folderOnly = await loadProfileStore({ profilesDir: paths.profilesDir });
  assert.deepEqual(folderOnly.shared, expected.shared);
  assert.deepEqual(folderOnly.profiles, expected.profiles);
  assert.equal(folderOnly.profiles.a, folderOnly.profiles.b);

  const second = await migrateProfiles(paths);
  assert.deepEqual(second.written, []);
  assert.equal(second.unchanged.length, 3);
  assert.equal(await fs.readFile(paths.profilesFile, "utf8"), before);
});

test("migration refuses to overwrite a file with different content", async () => {
  const paths = await setup({ legacy: { shared, profiles: { a: { image: "x" }, c: {} } }, folder: { "a.json": { image: "changed" } } });
  await assert.rejects(migrateProfiles(paths), /refusing to overwrite/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(paths.profilesDir, "a.json"), "utf8")), { image: "changed" });
  await assert.rejects(fs.access(path.join(paths.profilesDir, "c.json")));
});
