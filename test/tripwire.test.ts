import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, parseTripwire } from "../src/tripwire.ts";

test("a key tripwire changes when that key changes anywhere in the file, not otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-trip-"));
  const file = join(dir, "c.json");
  const wire = parseTripwire(`${file}#mcpServers`);
  writeFileSync(file, JSON.stringify({ numStartups: 1, projects: { "/a": { mcpServers: {} } } }));
  const before = fingerprint(wire);
  writeFileSync(file, JSON.stringify({ numStartups: 2, projects: { "/a": { mcpServers: {} } } }));
  assert.equal(fingerprint(wire), before);
  writeFileSync(file, JSON.stringify({ numStartups: 2, projects: { "/a": { mcpServers: { evil: { command: "sh" } } } } }));
  assert.notEqual(fingerprint(wire), before);
});
