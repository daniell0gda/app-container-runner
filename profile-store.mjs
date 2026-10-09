// Loads the runner's profiles from either or both supported formats:
//   - the legacy single file (PROFILES_FILE, default /app/profiles.json)
//     shaped {shared, profiles}, where a key "a,b" names one profile twice;
//   - a folder (PROFILES_DIR, default /app/profiles) holding _shared.json (the
//     shared object) and one <project>.json per project. The file stem is the
//     project name; an optional "aliases": [...] field adds more names for the
//     same profile object and is stripped before indexing.
// Both formats are first-class. When both exist they are merged: a name or
// alias defined twice anywhere is an error, and if both define shared settings
// that differ, _shared.json wins and a warning is logged.
// The module does no work at import time; server.mjs calls it once at startup.
import fs from "node:fs/promises";
import path from "node:path";

export const SHARED_FILE = "_shared.json";
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_SHARED_STRINGS = [
  "hostWorkspaceRoot",
  "hermesWorkspaceRoot",
  "defaultWorkerWorkspaceRoot",
  "managedLabel",
  "managedLabelValue"
];

export function profileAliases(key) {
  return String(key)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// Each alias points at the same object; profileAliasesFor in server.mjs relies
// on that identity.
function addProfile(indexed, origins, names, profile, source) {
  if (names.length === 0) {
    throw Error(`profile key must contain at least one name (${source})`);
  }
  for (const alias of names) {
    if (Object.hasOwn(indexed, alias)) {
      throw Error(`duplicate profile key: ${alias} (${origins[alias]} and ${source})`);
    }
    indexed[alias] = profile;
    origins[alias] = source;
  }
}

export function indexProfiles(rawProfiles, indexed = {}, origins = {}, source = "profiles") {
  for (const [key, profile] of Object.entries(rawProfiles)) {
    addProfile(indexed, origins, profileAliases(key), profile, source);
  }
  return indexed;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

export function sameJson(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Error(`${file} is not valid JSON: ${error.message}`);
  }
}

async function readLegacy(file) {
  const document = await readJson(file);
  if (document === undefined) return undefined;
  if (!isPlainObject(document)) throw Error(`${file} must contain a JSON object`);
  if (document.shared !== undefined && !isPlainObject(document.shared)) {
    throw Error(`${file}: shared must be an object`);
  }
  if (document.profiles !== undefined && !isPlainObject(document.profiles)) {
    throw Error(`${file}: profiles must be an object`);
  }
  return { shared: document.shared, profiles: document.profiles || {} };
}

// Returns undefined when the folder does not exist.
async function readFolder(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const result = { shared: undefined, projects: [] };
  const names = entries.map((entry) => entry.name).sort();
  for (const name of names) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (name === SHARED_FILE) {
      const shared = await readJson(path.join(dir, name));
      if (!isPlainObject(shared)) throw Error(`${path.join(dir, name)} must contain a JSON object`);
      result.shared = shared;
      continue;
    }
    // .gitkeep, _notes.json, editor files and the like are not projects.
    if (name.startsWith("_") || name.startsWith(".")) continue;
    if (!entry.isFile() || !name.toLowerCase().endsWith(".json")) continue;
    const stem = name.slice(0, -".json".length);
    const file = path.join(dir, name);
    if (!PROJECT_NAME_PATTERN.test(stem)) {
      throw Error(`${file}: project file name must match ${PROJECT_NAME_PATTERN}`);
    }
    const document = await readJson(file);
    if (!isPlainObject(document)) throw Error(`${file} must contain a JSON object`);
    const { aliases = [], ...profile } = document;
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || !PROJECT_NAME_PATTERN.test(alias))) {
      throw Error(`${file}: aliases must be a list of names matching ${PROJECT_NAME_PATTERN}`);
    }
    result.projects.push({ names: [stem, ...aliases], profile, source: file });
  }
  return result;
}

export function validateShared(shared) {
  if (!isPlainObject(shared)) {
    throw Error("profiles must define a shared object (profiles.json shared or profiles/_shared.json)");
  }
  if (REQUIRED_SHARED_STRINGS.some((field) => typeof shared[field] !== "string")) {
    throw Error("profiles shared settings are incomplete");
  }
}

export async function loadProfileStore({
  profilesFile,
  profilesDir,
  hostWorkspaceRoot = null,
  warn = console.warn
} = {}) {
  const legacy = profilesFile ? await readLegacy(profilesFile) : undefined;
  const folder = profilesDir ? await readFolder(profilesDir) : undefined;
  const folderUsed = folder && (folder.shared !== undefined || folder.projects.length > 0);
  if (!legacy && !folderUsed) {
    throw Error(`no profiles found: neither ${profilesFile} nor ${profilesDir} (with ${SHARED_FILE} or project files) exists`);
  }

  let shared = folder?.shared ?? legacy?.shared;
  if (folder?.shared !== undefined && legacy?.shared !== undefined && !sameJson(folder.shared, legacy.shared)) {
    warn(`profiles: shared settings in ${path.join(profilesDir, SHARED_FILE)} differ from ${profilesFile}; using ${SHARED_FILE}`);
  }
  validateShared(shared);
  shared = structuredClone(shared);
  if (hostWorkspaceRoot) shared.hostWorkspaceRoot = hostWorkspaceRoot;

  const profiles = {};
  const origins = {};
  if (legacy) indexProfiles(legacy.profiles, profiles, origins, profilesFile);
  for (const project of folder?.projects || []) {
    addProfile(profiles, origins, project.names, project.profile, project.source);
  }
  if (Object.keys(profiles).length === 0) throw Error("no profiles loaded");

  const sources = [];
  if (legacy) sources.push(profilesFile);
  if (folderUsed) sources.push(profilesDir);
  return { shared, profiles, sources };
}
