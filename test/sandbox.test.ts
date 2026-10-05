import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { herdrHome } from "../src/paths.ts";
import { makePolicy, penEnv } from "../src/policy.ts";
import { loadProfile, parseProfile } from "../src/profile.ts";
import { bwrapArgs } from "../src/sandbox/linux.ts";
import { parseDenial } from "../src/sandbox/maclog.ts";
import { seatbeltProfile } from "../src/sandbox/macos.ts";

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fence-pen-")));
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
};

test("the built-in profiles load and extend each other", () => {
  const strict = loadProfile("strict");
  const standard = loadProfile("standard");
  const open = loadProfile("open");
  assert.ok(standard.net.allow.includes("api.anthropic.com"), "standard gets strict's domains");
  assert.ok(standard.net.allow.includes("registry.npmjs.org"));
  assert.ok(!strict.net.allow.includes("github.com"));
  assert.ok(open.net.allow.includes("*"));
  assert.ok(open.files.hide.some((h) => h.includes(".ssh")));
});

test("herdr's socket and config are hidden whatever the profile says", () => {
  const empty = parseProfile("empty", "", "user", "/dev/null");
  const policy = makePolicy(empty, { dir: project() });
  assert.ok(policy.hide.includes(realpathSync(herdrHome)) || policy.hide.includes(herdrHome));
});

test("secrets are dropped from the environment, the agent's own keys kept", () => {
  const env = penEnv({ GITHUB_TOKEN: "x", AWS_PROFILE: "y", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "o", SSH_AUTH_SOCK: "/s", PATH: "/bin" }, loadProfile("strict"), { FENCE_ACTIVE: "1" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DO_NOT_TRACK", "FENCE_ACTIVE", "OPENAI_API_KEY", "PATH"]);
});

test("bubblewrap: read-only root, private /tmp and /run, the pen writable, hooks read-only, secrets covered", () => {
  const dir = project();
  const policy = makePolicy(loadProfile("strict"), { dir });
  const args = bwrapArgs(policy, { proxySocket: "/x/p.sock", gateSocket: "/x/g.sock" }, dir).join(" ");
  assert.match(args, /--ro-bind \/ \//);
  assert.match(args, /--unshare-net/);
  assert.match(args, /--tmpfs \/tmp/);
  assert.match(args, /--tmpfs \/run/);
  assert.ok(args.includes(`--bind ${dir} ${dir}`));
  assert.ok(args.includes(`--ro-bind ${join(dir, ".git", "hooks")} ${join(dir, ".git", "hooks")}`));
  assert.ok(args.indexOf(`--bind ${dir} `) < args.indexOf(`--ro-bind ${join(dir, ".git", "hooks")}`), "read-only comes after writable");
  assert.ok(args.endsWith(`--bind /x/g.sock /run/fence/herdr.sock --chdir ${dir}`));
});

test("parsing a macOS sandbox denial", () => {
  assert.deepEqual(parseDenial("Sandbox: zsh(123) deny(1) file-write-create /Users/me/.zshrc\nfence:abc:w1_p1;"), {
    process: "zsh",
    pid: 123,
    operation: "file-write-create",
    target: "/Users/me/.zshrc",
  });
  assert.equal(parseDenial("Sandbox: 2.1.289(9) deny(1) network-outbound remote:*:443")?.process, "2.1.289");
});

test("macOS: the generated profile really fences a shell", { skip: process.platform !== "darwin" }, () => {
  const dir = project();
  const policy = makePolicy(parseProfile("t", `[files]\nwrite = ["{pen}"]\nprotect = ["{pen}/.git/hooks"]\nhide = ["{pen}/secret"]`, "user", "-"), { dir });
  writeFileSync(join(dir, "secret"), "shh");
  const profile = seatbeltProfile(policy, { proxyPort: 1, gateSocket: "/nonexistent" });
  const sh = (script: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], { cwd: dir, encoding: "utf8" });
  assert.equal(sh("echo ok > inside.txt").status, 0, "writes the pen");
  assert.notEqual(sh(`echo x > ${join(homedir(), ".fence-test-escape")}`).status, 0, "can't write home");
  assert.notEqual(sh("echo x > .git/hooks/pre-commit").status, 0, "can't plant a git hook");
  assert.notEqual(sh("cat secret").status, 0, "can't read hidden files");
  assert.notEqual(sh("/usr/bin/curl -s -m 3 --noproxy '*' https://example.com").status, 0, "no direct network");
  assert.notEqual(sh(`kill -0 ${process.pid}`).status, 0, "can't signal a process outside the pen");
  assert.equal(sh("sleep 5 & kill $!").status, 0, "can signal its own");
});
