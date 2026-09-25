import test from "node:test";
import assert from "node:assert/strict";
import { workerDnsOptions } from "./worker-dns.mjs";

test("unset leaves Docker's default resolver", () => {
  assert.deepEqual(workerDnsOptions({}), {});
});

test("passes the resolver and search domain to the worker", () => {
  assert.deepEqual(
    workerDnsOptions({ WORKER_DNS: "10.30.28.1", WORKER_DNS_SEARCH: "pdtec.lan" }),
    { Dns: ["10.30.28.1"], DnsSearch: ["pdtec.lan"] }
  );
});

test("accepts comma-separated lists and ignores blanks", () => {
  assert.deepEqual(workerDnsOptions({ WORKER_DNS: " 10.30.28.1, ,10.30.28.2 ", WORKER_DNS_SEARCH: "" }), {
    Dns: ["10.30.28.1", "10.30.28.2"]
  });
});
