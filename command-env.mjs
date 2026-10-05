import { secretNames } from "./workspace-compose.mjs";

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const secretReference = /\$\{([^}]*)\}/g;

/**
 * The environment a project's commands run with, as `NAME=value` entries for a
 * Docker exec. The project declares it under `env:` in its hermes_config.yaml. A
 * value may name a secret of the runner as `${NAME}`, the way a Compose file does,
 * but only one the profile lists in `allowedSecrets`. So a repository chooses
 * which licence its commands get without ever holding it.
 *
 * @param {unknown} env the request's `env`: a map of variable name to string value, or absent
 * @param {{ profile: object, secrets: Record<string, string | undefined> }} context
 *   the project's profile and the runner's own environment
 * @returns {string[]} the variables, secrets filled in
 */
export function commandEnv(env, { profile, secrets }) {
  if (env === undefined || env === null) return [];
  if (typeof env !== "object" || Array.isArray(env)) {
    throw Error("env must be a map of variable name to value");
  }
  const allowed = secretNames(profile);
  return Object.entries(env).map(([name, value]) => {
    if (!variableName.test(name)) throw Error(`env ${name} is not a valid variable name`);
    if (typeof value !== "string") throw Error(`env ${name} must be a string`);
    return `${name}=${value.replace(secretReference, (_, secret) => secretValue(secret, allowed, secrets))}`;
  });
}

function secretValue(name, allowed, secrets) {
  if (!allowed.includes(name)) {
    throw Error(`env uses ${name}, which is not in this project's allowedSecrets`);
  }
  if (!secrets[name]) throw Error(`${name} is not set on the runner`);
  return secrets[name];
}
