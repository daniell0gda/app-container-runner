// Network for the workers of one profile.
//
// A worker is created on Docker's default bridge, where containers cannot reach
// each other by name. A project whose client has to talk to a server running as
// its own container names that server's network in its profile, and the worker
// joins it. Unset keeps the default bridge.
//
// Only a plain network name is accepted: "host" would hand the worker the host's
// network namespace, and with it every port bound to 127.0.0.1 there, and
// "container:<id>" would share another container's.

const networkNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function workerNetworkOptions(network) {
  if (network === undefined) return {};
  if (typeof network !== "string" || !networkNamePattern.test(network) || network === "host") {
    throw Error("profile network must be a Docker network name other than host");
  }
  return { NetworkMode: network };
}
