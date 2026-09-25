// Resolver settings for the workers this runner creates.
//
// A container gets the Docker daemon's default resolver, and on a host whose
// /etc/resolv.conf is the systemd-resolved stub that default does not answer:
// every lookup in the worker fails, and npm retries the registry until the
// command times out. Compose fixes its own services with `dns:`, but a worker
// is created here, so it needs the same values handed in. Unset keeps Docker's
// default, which is right wherever that default works.

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function workerDnsOptions(env) {
  const options = {};
  const dns = splitList(env.WORKER_DNS);
  const dnsSearch = splitList(env.WORKER_DNS_SEARCH);
  if (dns.length > 0) options.Dns = dns;
  if (dnsSearch.length > 0) options.DnsSearch = dnsSearch;
  return options;
}
