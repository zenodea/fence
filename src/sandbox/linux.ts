// Linux: bubblewrap. The pen sees the whole filesystem read-only, its own /tmp
// and /run, its writable folders bound back in, secrets covered over, and no
// network but its own localhost. A tiny bridge inside forwards one localhost
// port to fence's proxy, which sits outside on a unix socket.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Policy } from "../policy.ts";

/** Where the pen finds fence's sockets. */
export const INSIDE = { dir: "/run/fence", proxy: "/run/fence/proxy.sock", gate: "/run/fence/herdr.sock" } as const;
/** The localhost port the bridge listens on inside the pen. */
export const BRIDGE_PORT = 3128;

/** bwrap is there and this kernel lets it make namespaces (some distros switch that off). */
export function bwrapAvailable(): boolean {
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "true"], { stdio: "ignore" });
  return r.status === 0;
}

/** A trailing glob matched against what's there now: bind mounts need real files. */
function existing(path: string): string[] {
  if (!path.includes("*")) return existsSync(path) ? [path] : [];
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${basename(path).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => join(dir, f));
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export type LinuxSockets = { proxySocket: string; gateSocket: string };

export function bwrapArgs(p: Policy, s: LinuxSockets, cwd: string): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    // Private /tmp and /run: no ssh-agent, X11, D-Bus or Docker sockets from the host.
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
  ];
  const tmpIsPrivate = p.tmp === "/tmp" || p.tmp.startsWith("/tmp/");
  for (const w of p.write.flatMap(existing)) {
    if (tmpIsPrivate && (w === p.tmp || w.startsWith("/tmp/"))) continue;
    if (w.startsWith("/run/")) continue;
    args.push("--bind", w, w);
  }
  for (const r of p.protect.flatMap(existing)) args.push("--ro-bind", r, r);
  for (const h of p.hide.flatMap(existing)) {
    if (isDir(h)) args.push("--tmpfs", h);
    else args.push("--ro-bind", "/dev/null", h);
  }
  args.push(
    "--dir", INSIDE.dir,
    "--bind", s.proxySocket, INSIDE.proxy,
    "--bind", s.gateSocket, INSIDE.gate,
    "--chdir", cwd,
  );
  return args;
}

/** The bridge's code, run with `node -e` so it works wherever fence is installed (even somewhere hidden). */
export function bridgeSource(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "bridge.mjs"), "utf8");
}

export function linuxCommand(p: Policy, s: LinuxSockets, cwd: string, argv: string[]): string[] {
  return [
    "bwrap",
    ...bwrapArgs(p, s, cwd),
    "--",
    process.execPath,
    "--input-type=module",
    "-e",
    bridgeSource(),
    "--",
    String(BRIDGE_PORT),
    INSIDE.proxy,
    ...argv,
  ];
}
