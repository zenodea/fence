// `fence shell` and `fence run`: start the pen's proxy and herdr gate, then run
// the shell (or a command) inside the sandbox and stay alongside it until it
// exits. This process is outside the fence; everything it starts is inside.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { denied, record } from "./events.ts";
import { createGate } from "./herdr/gate.ts";
import { createProxy } from "./net/proxy.ts";
import { ensureDir, herdrSocketPath, runDir } from "./paths.ts";
import { penById, type Pen } from "./pens.ts";
import { clearPaneRules, makePolicy, penEnv, proxyEnv, rulesStamp, writePaneRules, type Policy } from "./policy.ts";
import { loadProfile, type Profile } from "./profile.ts";
import { bwrapAvailable, BRIDGE_PORT, INSIDE, linuxCommand } from "./sandbox/linux.ts";
import { followDenials, isNoise, isRoutine, type Follower } from "./sandbox/maclog.ts";
import { macCommand, seatbeltProfile } from "./sandbox/macos.ts";
import { watchTripwires } from "./tripwire.ts";
import { style } from "./ui/ansi.ts";

export type FencedRun = {
  pen: Pen | null;
  profile: string;
  dir: string;
  /** What to run inside; the login shell when empty. */
  argv: string[];
  /** The herdr pane it runs in, for the gate and the log. */
  pane: string | null;
  quiet?: boolean;
};

export function backendProblem(): string | null {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? null : "sandbox-exec is missing from /usr/bin";
  if (process.platform === "linux") return bwrapAvailable() ? null : "bubblewrap isn't installed (or can't make namespaces): install the bwrap package";
  return `fence doesn't know how to fence ${process.platform}`;
}

const listen = (server: Server, where: string | number) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (typeof where === "number") server.listen(where, "127.0.0.1", resolve);
    else server.listen(where, resolve);
  });

/** A toast's title for something the sandbox stopped. Says what, not who: agents often run under a version number. */
export function denialTitle(op: string, target: string, proc: string): string {
  if (op.startsWith("file-write")) return `blocked writing ${target}`;
  if (op.startsWith("file-read")) return `blocked reading ${target}`;
  if (op === "appleevent-send") return `blocked ${proc} controlling another app`;
  if (op === "mach-lookup") return `blocked ${proc} reaching ${target.replace(/^.*global-name:?\s*/, "")}`;
  return `blocked ${op} ${target}`;
}

export async function runFenced(run: FencedRun): Promise<number> {
  if (process.env.FENCE_ACTIVE) throw new Error("this shell is already inside a pen");
  const problem = backendProblem();
  if (problem) throw new Error(problem);

  let profile: Profile = loadProfile(run.profile);
  let policy: Policy = makePolicy(profile, { dir: run.dir, pen: run.pen, pane: run.pane });
  const penId = run.pen?.id ?? null;
  // The pen as it is now: its profile can be switched from the window while this shell runs.
  let looked = 0;
  const refresh = () => {
    if (!penId || Date.now() - looked < 1000) return;
    looked = Date.now();
    const pen = penById(penId);
    if (!pen) return;
    try {
      const next = loadProfile(pen.profile);
      profile = next;
      policy = makePolicy(next, { dir: pen.dir, pen, pane: run.pane });
    } catch {}
  };
  const name = policy.penName;
  const mac = process.platform === "darwin";

  ensureDir(runDir);
  const id = `${process.pid}`;
  const gateSocket = join(runDir, `g${id}.sock`);
  const proxySocket = join(runDir, `p${id}.sock`);
  for (const s of [gateSocket, proxySocket]) rmSync(s, { force: true });

  const seen = new Set<string>();
  const proxy = createProxy({
    // Read again as requests come in, so a domain let through or a profile switched works at once.
    rules: () => (refresh(), [...new Set([...profile.net.allow, ...((penId && penById(penId)?.allow) || [])])]),
    onDecision: (d) => {
      const target = d.port === 443 || d.port === 80 ? d.host : `${d.host}:${d.port}`;
      if (d.allowed) {
        if (!seen.has(target)) record({ pen: penId, pane: run.pane, kind: "net", verdict: "allowed", target });
        seen.add(target);
        return;
      }
      denied({ pen: penId, pane: run.pane, kind: "net", target, detail: d.reason }, name, `blocked ${target}`, d.reason ? `${name} · ${d.reason}` : undefined);
    },
  });
  const gate = createGate({
    herdrSocket: herdrSocketPath(),
    ownPane: run.pane,
    onDecision: (d) => {
      if (!d.allowed) denied({ pen: penId, pane: run.pane, kind: "herdr", target: d.method, detail: d.reason }, name, `blocked herdr ${d.method}`);
    },
  });

  let proxyUrl: string;
  if (mac) {
    await listen(proxy, 0);
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  } else {
    await listen(proxy, proxySocket);
    proxyUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  }
  await listen(gate, gateSocket);

  const stopTripwires = watchTripwires(policy.tripwires, (t) => {
    record({ pen: penId, pane: run.pane, kind: "tripwire", verdict: "changed", target: t.spec });
    denied({ pen: penId, pane: run.pane, kind: "tripwire", target: t.spec }, name, `${t.spec} changed`, `${name} · check it before you next run that agent outside a pen`);
  });

  let follower: Follower | null = null;
  if (mac) {
    follower = followDenials(policy.tag, (d) => {
      if (isNoise(d)) return;
      const kind = d.operation.startsWith("file") ? "file" : d.operation === "appleevent-send" || d.operation === "mach-lookup" ? "app" : "net";
      // Connections the proxy didn't see are logged, not toasted: tools look things up before they use the proxy.
      if (kind === "net" || isRoutine(d)) {
        record({ pen: penId, pane: run.pane, kind, verdict: "denied", target: d.target || d.operation, detail: `${d.process}: ${d.operation}` });
        return;
      }
      const target = d.target || d.operation;
      const shown = target.replace(process.env.HOME ?? "\0", "~");
      denied({ pen: penId, pane: run.pane, kind, target, detail: `${d.process}: ${d.operation}` }, name, denialTitle(d.operation, shown, d.process), `${name} · ${d.process} · prefix+p to see the pen`);
    });
  }

  // Wait for the log to be followed, or what the shell does in its first second goes unheard.
  await follower?.ready;

  const argv = run.argv.length ? run.argv : [process.env.SHELL || "/bin/sh", "-l"];
  let child: ReturnType<typeof spawn> | null = null;
  // The window asks for a restart (SIGUSR1) to put a pane on the pen's new rules: the
  // shell inside is ended and started again in the same pane, under a fresh sandbox.
  let restart = false;
  process.on("SIGUSR1", () => {
    restart = true;
    const ending = child;
    ending?.kill("SIGHUP");
    setTimeout(() => ending?.exitCode === null && ending.kill("SIGKILL"), 3000).unref();
  });
  // The terminal's keys belong to the shell inside.
  for (const sig of ["SIGINT", "SIGQUIT", "SIGTSTP", "SIGTTIN", "SIGTTOU"] as const) process.on(sig, () => {});
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => child?.kill(sig));

  let code = 0;
  for (let first = true; first || restart; first = false) {
    if (!first) {
      looked = 0;
      refresh();
    }
    restart = false;
    const env = penEnv(process.env, profile, {
      ...proxyEnv(proxyUrl),
      HERDR_SOCKET_PATH: mac ? gateSocket : INSIDE.gate,
      FENCE_ACTIVE: "1",
      FENCE_PEN: penId ?? "",
      FENCE_PEN_NAME: name,
      FENCE_PROFILE: profile.name,
    });
    const cwd = process.cwd().startsWith(policy.dir) ? process.cwd() : policy.dir;
    const command = mac
      ? macCommand(seatbeltProfile(policy, { proxyPort: Number(new URL(proxyUrl).port), gateSocket }), argv)
      : linuxCommand(policy, { proxySocket, gateSocket }, cwd, argv);

    if (!run.quiet) {
      const domains = policy.allow.includes("*") ? "any domain" : `${policy.allow.length} domains`;
      process.stderr.write(`${first ? "" : "\n"}${style.green(first ? "🐑 fenced" : "🐑 fenced again")} ${style.bold(name)} ${style.dim(`· ${profile.name} · ${domains} · writes ${policy.dir.replace(process.env.HOME ?? "\0", "~")}`)}\n`);
    }
    record({ pen: penId, pane: run.pane, kind: "info", verdict: "info", target: `${first ? "started" : "restarted"} ${argv[0]}`, detail: `profile ${profile.name}` });
    if (run.pane) writePaneRules(run.pane, { pid: process.pid, pen: penId, profile: profile.name, stamp: rulesStamp(policy, profile) });

    const running = spawn(command[0]!, command.slice(1), { stdio: "inherit", env, cwd });
    child = running;
    code = await new Promise<number>((resolve) => {
      running.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : 1)));
      running.on("error", (err) => {
        process.stderr.write(`fence: couldn't start the sandbox: ${err.message}\n`);
        restart = false;
        resolve(127);
      });
    });
  }
  if (run.pane) clearPaneRules(run.pane);

  stopTripwires();
  follower?.stop();
  proxy.close();
  gate.close();
  for (const s of [gateSocket, proxySocket]) rmSync(s, { force: true });
  return code;
}
