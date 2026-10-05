// A profile made concrete for one pen: absolute paths, the allow list, the
// environment. The sandbox backends only ever see this.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { configDir, herdrHome, herdrState, pluginRoot, runDir, stateDir } from "./paths.ts";
import type { Pen } from "./pens.ts";
import { expandPath, type Profile } from "./profile.ts";

export type Policy = {
  /** Shows up in the sandbox's own denial messages, so fence can tell whose they are. */
  tag: string;
  penId: string | null;
  penName: string;
  profile: string;
  dir: string;
  tmp: string;
  write: string[];
  protect: string[];
  hide: string[];
  /** Exceptions to `hide`. */
  show: string[];
  /** Hidden whatever the profile or the pen says. */
  always: string[];
  allow: string[];
  localhost: number[];
  clipboard: boolean;
  open: boolean;
  tripwires: string[];
};

/**
 * Hidden whatever the profile says: herdr's socket and config (a pen that can
 * talk to herdr can open an unfenced pane), and fence's own pens and logs.
 */
export const ALWAYS_HIDDEN = [herdrHome, herdrState, configDir, stateDir];

export function makePolicy(profile: Profile, opts: { dir: string; pen?: Pen | null; pane?: string | null }): Policy {
  const dir = expandPath(opts.dir, opts.dir);
  const tmp = expandPath(tmpdir(), dir);
  const expand = (list: string[]) => [...new Set(list.map((p) => expandPath(p, dir, tmp)))];
  const pane = (opts.pane ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    tag: `fence:${opts.pen?.id ?? "run"}:${pane || "-"};`,
    penId: opts.pen?.id ?? null,
    penName: opts.pen?.name ?? "fence run",
    profile: profile.name,
    dir,
    tmp,
    write: expand(profile.files.write),
    // fence itself and its sockets stay out of reach even when the pen's folder holds them.
    protect: expand([...profile.files.protect, pluginRoot, runDir]),
    hide: expand([...profile.files.hide, ...(opts.pen?.hide ?? [])]),
    show: expand([...profile.files.show, ...(opts.pen?.show ?? [])]),
    always: expand(ALWAYS_HIDDEN),
    allow: [...new Set([...profile.net.allow, ...(opts.pen?.allow ?? [])])],
    localhost: profile.net.localhost,
    clipboard: profile.system.clipboard,
    open: profile.system.open,
    tripwires: profile.tripwires,
  };
}

const globToRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

/** The pen's environment: secrets dropped, the proxy and herdr gate pointed at. */
export function penEnv(
  base: NodeJS.ProcessEnv,
  profile: Profile,
  extra: Record<string, string>,
): Record<string, string> {
  const drop = profile.env.drop.map(globToRegex);
  const keep = new Set(profile.env.keep);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (!keep.has(k) && drop.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  return { ...env, ...profile.env.set, ...extra };
}

/** The proxy and git settings every pen gets, whatever the platform. */
export function proxyEnv(proxyUrl: string): Record<string, string> {
  const env: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    // Node's own fetch only reads the variables above when asked to.
    NODE_USE_ENV_PROXY: "1",
    // An empty helper list: git won't ask the keychain for your credentials.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
  return env;
}

export function describePolicy(p: Policy): string[] {
  const exists = (path: string) => (existsSync(path.replace(/\*.*$/, "")) ? "" : "  (doesn't exist)");
  return [
    `pen       ${p.penName}${p.penId ? ` (${p.penId})` : ""}`,
    `profile   ${p.profile}`,
    `folder    ${p.dir}`,
    "",
    "writable",
    ...p.write.map((w) => `  ${w}${exists(w)}`),
    "read-only inside those",
    ...p.protect.map((w) => `  ${w}`),
    "hidden",
    ...[...p.always, ...p.hide].map((w) => `  ${w}`),
    ...(p.show.length ? ["shown all the same", ...p.show.map((w) => `  ${w}`)] : []),
    "domains",
    ...p.allow.map((d) => `  ${d}`),
    ...(p.localhost.length ? ["localhost ports", ...p.localhost.map((port) => `  ${port}`)] : []),
  ];
}
