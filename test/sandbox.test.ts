import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { herdrHome } from "../src/paths.ts";
import { makePolicy, penEnv, rulesStamp } from "../src/policy.ts";
import { loadProfile, parseProfile } from "../src/profile.ts";
import { bwrapArgs } from "../src/sandbox/linux.ts";
import { expandGlob, matches } from "../src/glob.ts";
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
  assert.ok(policy.always.includes(realpathSync(herdrHome)) || policy.always.includes(herdrHome));
  const shown = makePolicy(parseProfile("s", `[files]\nshow = ["~/.config/herdr"]`, "user", "-"), { dir: project() });
  assert.ok(seatbeltProfile(shown, { proxyPort: 1, gateSocket: "/x" }).includes(`(subpath "${shown.always[0]}")`), "show can't unhide it");
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

test("patterns: * stays in one name, ** crosses folders, a plain path covers what's under it", () => {
  assert.ok(matches("/p/.env", "/p/**/.env*"));
  assert.ok(matches("/p/apps/api/.env.local", "/p/**/.env*"));
  assert.ok(!matches("/p/apps/api/env.ts", "/p/**/.env*"));
  assert.ok(matches("/p/.git/hooks/pre-commit", "/p/.git"));
  assert.ok(!matches("/p/.github/x", "/p/.git"));
  assert.ok(matches("/p/.claude/settings.local.json", "/p/.claude/settings*.json"));
  assert.ok(!matches("/p/a/b.key", "/p/*.key"));
});

test("patterns expand to the files that are there, skipping node_modules", () => {
  const dir = project();
  mkdirSync(join(dir, "apps", "api"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  for (const f of [".env", "apps/api/.env.local", "apps/api/.env.example", "node_modules/x/.env", "apps/api/server.key"]) writeFileSync(join(dir, f), "x");
  assert.deepEqual(expandGlob(join(dir, "**", ".env*")).map((p) => p.slice(dir.length + 1)).sort(), [".env", "apps/api/.env.example", "apps/api/.env.local"]);
});

test("sealed: the pen's secrets are hidden, templates shown, .git read-only", () => {
  const sealed = loadProfile("sealed");
  assert.ok(sealed.net.allow.includes("api.anthropic.com") && !sealed.net.allow.includes("github.com"), "strict's network");
  const dir = project();
  mkdirSync(join(dir, "apps", "api"), { recursive: true });
  for (const f of [".env", "apps/api/.env.local", "apps/api/.env.example"]) writeFileSync(join(dir, f), "SECRET=1");
  const policy = makePolicy(sealed, { dir, pen: { id: "t", name: "t", workspaceId: "w", dir, profile: "sealed", allow: [], createdAt: "", hide: ["notes/private.md"], show: [] } });
  assert.ok(policy.hide.includes(join(dir, "notes/private.md")), "a pen's own hidden paths are inside the pen");
  const args = bwrapArgs(policy, { proxySocket: "/x/p.sock", gateSocket: "/x/g.sock" }, dir).join(" ");
  assert.ok(args.includes(`--ro-bind /dev/null ${join(dir, ".env")}`));
  assert.ok(args.includes(`--ro-bind /dev/null ${join(dir, "apps/api/.env.local")}`));
  assert.ok(!args.includes(`/dev/null ${join(dir, "apps/api/.env.example")}`));
  assert.ok(args.includes(`--ro-bind ${join(dir, ".git")} ${join(dir, ".git")}`));
});

test("macOS: a sealed pen for real", { skip: process.platform !== "darwin" }, () => {
  const dir = project();
  spawnSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "apps", "api"), { recursive: true });
  for (const f of [".env", "apps/api/.env.local", "apps/api/.env.example", "app.js"]) writeFileSync(join(dir, f), "SECRET=1");
  const policy = makePolicy(loadProfile("sealed"), { dir });
  const profile = seatbeltProfile(policy, { proxyPort: 1, gateSocket: "/nonexistent" });
  const sh = (script: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.notEqual(sh("cat .env").status, 0, ".env is hidden");
  assert.notEqual(sh("cat apps/api/.env.local").status, 0, "nested .env files are hidden");
  assert.equal(sh("cat apps/api/.env.example").status, 0, "templates are shown");
  assert.equal(sh("echo new > apps/api/.env.example").status, 0, "and writable");
  assert.equal(sh("echo ok >> app.js").status, 0, "code is writable");
  const status = sh("git status --short");
  assert.equal(status.status, 0, "git status works on a read-only .git: " + status.stderr);
  assert.match(status.stdout, /app\.js/);
  assert.notEqual(sh("git add app.js").status, 0, "nothing can be staged");
  assert.notEqual(sh("git commit -qam x").status, 0, "or committed");
});

test("a pane's rules fingerprint changes with file rules, not with domains", () => {
  const dir = project();
  const pen = { id: "t", name: "t", workspaceId: "w", dir, profile: "strict", allow: [] as string[], createdAt: "" };
  const stamp = (profile: string, extra = {}) => rulesStamp(makePolicy(loadProfile(profile), { dir, pen: { ...pen, ...extra } }), loadProfile(profile));
  assert.equal(stamp("strict"), stamp("strict", { allow: ["example.com"] }), "letting a domain through needs no restart");
  assert.notEqual(stamp("strict"), stamp("sealed"), "another profile's files do");
  assert.notEqual(stamp("strict"), stamp("strict", { hide: ["notes.md"] }), "so does hiding a file");
});
