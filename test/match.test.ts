import assert from "node:assert/strict";
import { test } from "node:test";
import { allows, cleanRule } from "../src/net/match.ts";
import { isLocalAddress } from "../src/net/proxy.ts";

test("exact hosts, subdomains, ports and the wildcard", () => {
  const rules = ["github.com", "*.anthropic.com", "example.com:8443"];
  assert.ok(allows(rules, "github.com", 443));
  assert.ok(allows(rules, "GitHub.com.", 80));
  assert.ok(!allows(rules, "gist.github.com", 443));
  assert.ok(allows(rules, "api.anthropic.com", 443));
  assert.ok(!allows(rules, "anthropic.com", 443));
  assert.ok(!allows(rules, "evilanthropic.com", 443));
  assert.ok(!allows(rules, "github.com", 22));
  assert.ok(allows(rules, "example.com", 8443));
  assert.ok(!allows(rules, "example.com", 443));
  assert.ok(allows(["*"], "anything.at.all", 9999));
});

test("cleaning what you type into the allow box", () => {
  assert.equal(cleanRule(" https://Example.com/path "), "example.com");
  assert.equal(cleanRule("*.npmjs.org"), "*.npmjs.org");
  assert.equal(cleanRule("host:8080"), "host:8080");
  assert.equal(cleanRule("not a domain"), null);
  assert.equal(cleanRule(""), null);
});

test("this machine and link-local are never reachable through the proxy", () => {
  for (const ip of ["127.0.0.1", "127.8.8.8", "0.0.0.0", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fe80::1"]) assert.ok(isLocalAddress(ip), ip);
  for (const ip of ["140.82.112.3", "10.0.0.5", "2606:4700::1111"]) assert.ok(!isLocalAddress(ip), ip);
});
