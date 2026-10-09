#!/usr/bin/env node
// Splits a legacy profiles.json into a profiles/ folder: _shared.json plus one
// <project>.json per profile. A key "a,b" becomes a.json with "aliases": ["b"].
// Idempotent: files that already hold the same JSON are left as they are. It
// refuses (and writes nothing) if any target file exists with different
// content. The source file is never modified; remove or rename it yourself
// once the folder is in place, or the runner will reject the duplicate names.
//
//   node migrate-profiles.mjs [profiles.json] [profiles/]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_NAME_PATTERN, SHARED_FILE, profileAliases, sameJson } from "./profile-store.mjs";

export function planMigration(document) {
  if (!document || typeof document !== "object" || typeof document.shared !== "object" || typeof document.profiles !== "object") {
    throw Error("source must contain shared and profiles objects");
  }
  const files = [{ name: SHARED_FILE, content: document.shared }];
  const seen = new Set();
  for (const [key, profile] of Object.entries(document.profiles)) {
    const [stem, ...aliases] = profileAliases(key);
    for (const name of [stem, ...aliases]) {
      if (!name || !PROJECT_NAME_PATTERN.test(name)) throw Error(`profile key "${key}": name "${name}" must match ${PROJECT_NAME_PATTERN}`);
      if (seen.has(name)) throw Error(`duplicate profile key: ${name}`);
      seen.add(name);
    }
    if (Object.hasOwn(profile, "aliases")) throw Error(`profile "${key}" already has an aliases field`);
    const content = aliases.length > 0 ? { aliases, ...profile } : profile;
    files.push({ name: `${stem}.json`, content });
  }
  return files;
}

export async function migrateProfiles({ profilesFile, profilesDir }) {
  const document = JSON.parse(await fs.readFile(profilesFile, "utf8"));
  const files = planMigration(document);
  const written = [];
  const unchanged = [];
  const conflicts = [];
  for (const file of files) {
    const target = path.join(profilesDir, file.name);
    let existing;
    try {
      existing = await fs.readFile(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing === undefined) continue;
    let same = false;
    try {
      same = sameJson(JSON.parse(existing), file.content);
    } catch {}
    if (same) unchanged.push(target);
    else conflicts.push(target);
  }
  if (conflicts.length > 0) {
    throw Error(`refusing to overwrite files with different content: ${conflicts.join(", ")}`);
  }
  await fs.mkdir(profilesDir, { recursive: true });
  for (const file of files) {
    const target = path.join(profilesDir, file.name);
    if (unchanged.includes(target)) continue;
    await fs.writeFile(target, `${JSON.stringify(file.content, null, 2)}\n`, { flag: "wx" });
    written.push(target);
  }
  return { written, unchanged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profilesFile = process.argv[2] || "profiles.json";
  const profilesDir = process.argv[3] || "profiles";
  try {
    const { written, unchanged } = await migrateProfiles({ profilesFile, profilesDir });
    for (const file of written) console.log(`wrote ${file}`);
    for (const file of unchanged) console.log(`unchanged ${file}`);
    console.log(`${profilesFile} was left untouched. Remove or rename it before starting the runner, or every profile is defined twice.`);
  } catch (error) {
    console.error(`migrate-profiles: ${error.message}`);
    process.exitCode = 1;
  }
}
