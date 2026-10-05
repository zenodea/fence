// Profiles: TOML files that say what a pen may touch. Yours (in fence's config
// dir) win over the built-in ones with the same name.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { builtinProfilesDir, home, userProfilesDir } from "./paths.ts";
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";

export type Profile = {
  name: string;
  description: string;
  /** The file it came from; "builtin" ones live in the plugin. */
  source: "builtin" | "user";
  path: string;
  extends: string | null;
  files: { write: string[]; protect: string[]; hide: string[] };
  net: { allow: string[]; localhost: number[] };
  env: { drop: string[]; keep: string[]; set: Record<string, string> };
  system: { clipboard: boolean; open: boolean };
  tripwires: string[];
};

export const DEFAULT_PROFILE = "standard";

const strings = (v: TomlValue | undefined, where: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${where} must be a list of strings`);
  return v as string[];
};
const table = (v: TomlValue | undefined, where: string): TomlTable => {
  if (v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be a table`);
  return v;
};

export function parseProfile(name: string, text: string, source: Profile["source"], path: string): Profile {
  const t = parseToml(text);
  const files = table(t.files, "[files]");
  const net = table(t.net, "[net]");
  const env = table(t.env, "[env]");
  const system = table(t.system, "[system]");
  const set = table(env.set, "[env.set]");
  const ports = net.localhost ?? [];
  if (!Array.isArray(ports) || ports.some((p) => typeof p !== "number")) throw new Error("net.localhost must be a list of port numbers");
  return {
    name,
    description: typeof t.description === "string" ? t.description : "",
    source,
    path,
    extends: typeof t.extends === "string" ? t.extends : null,
    files: { write: strings(files.write, "files.write"), protect: strings(files.protect, "files.protect"), hide: strings(files.hide, "files.hide") },
    net: { allow: strings(net.allow, "net.allow"), localhost: ports as number[] },
    env: {
      drop: strings(env.drop, "env.drop"),
      keep: strings(env.keep, "env.keep"),
      set: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, String(v)])),
    },
    system: { clipboard: system.clipboard === true, open: system.open === true },
    tripwires: strings(table(t.tripwires, "[tripwires]").watch, "tripwires.watch"),
  };
}

function profileFiles(): Map<string, { path: string; source: Profile["source"] }> {
  const found = new Map<string, { path: string; source: Profile["source"] }>();
  for (const [dir, source] of [[builtinProfilesDir, "builtin"], [userProfilesDir, "user"]] as const) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (file.endsWith(".toml")) found.set(basename(file, ".toml"), { path: join(dir, file), source });
    }
  }
  return found;
}

export function listProfiles(): Profile[] {
  return [...profileFiles().keys()].map((name) => loadProfile(name));
}

/** A profile with everything it extends folded in: lists add up, settings from the child win. */
export function loadProfile(name: string, seen: string[] = []): Profile {
  if (seen.includes(name)) throw new Error(`profiles extend each other in a loop: ${[...seen, name].join(" → ")}`);
  const file = profileFiles().get(name);
  if (!file) throw new Error(`no profile called ${name}`);
  let own: Profile;
  try {
    own = parseProfile(name, readFileSync(file.path, "utf8"), file.source, file.path);
  } catch (err) {
    throw new Error(`${file.path}: ${(err as Error).message}`);
  }
  if (!own.extends) return own;
  const base = loadProfile(own.extends, [...seen, name]);
  const both = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    ...own,
    files: { write: both(base.files.write, own.files.write), protect: both(base.files.protect, own.files.protect), hide: both(base.files.hide, own.files.hide) },
    net: { allow: both(base.net.allow, own.net.allow), localhost: [...new Set([...base.net.localhost, ...own.net.localhost])] },
    env: { drop: both(base.env.drop, own.env.drop), keep: both(base.env.keep, own.env.keep), set: { ...base.env.set, ...own.env.set } },
    // A child only loosens these by saying so.
    system: { clipboard: own.system.clipboard || base.system.clipboard, open: own.system.open || base.system.open },
    tripwires: both(base.tripwires, own.tripwires),
  };
}

/** Follow symlinks for the part of the path that exists (macOS: /tmp is /private/tmp). */
export function realish(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return path;
    tail.unshift(basename(head));
    head = up;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return path;
  }
}

/** ~, {pen} and {tmp} filled in, made absolute, symlinks followed. A trailing glob stays in the last part. */
export function expandPath(pattern: string, penDir: string, tmp: string = tmpdir()): string {
  let p = pattern.trim();
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  p = p.replaceAll("{pen}", penDir).replaceAll("{tmp}", tmp);
  p = resolve(penDir, p);
  const glob = p.includes("*") ? basename(p) : null;
  return glob ? join(realish(dirname(p)), glob) : realish(p);
}
