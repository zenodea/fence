// Path patterns in profiles: `*` matches within one name, `**` any number of
// folders. A pattern without either means that path and everything under it.
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

export const hasGlob = (pattern: string) => pattern.includes("*");

/**
 * The pattern as a regular expression, in the plain subset both JavaScript and
 * macOS's sandbox understand. Matches the path itself and anything inside it.
 */
export function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      out += "(.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i++;
    } else {
      out += pattern[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return `^${out}(/.*)?$`;
}

export function matches(path: string, pattern: string): boolean {
  if (!hasGlob(pattern)) return path === pattern || path.startsWith(pattern + "/");
  return new RegExp(globToRegexSource(pattern)).test(path);
}

export const matchesAny = (path: string, patterns: readonly string[]) => patterns.some((p) => matches(path, p));

/** Folders a `**` doesn't go into: huge, and not where your secrets live. */
const SKIP = new Set(["node_modules", ".git"]);
const MAX_FOLDERS = 20_000;

/**
 * The files and folders a pattern matches right now. Linux needs real paths to
 * mount over; the pen window uses it to show what a pen hides.
 */
export function expandGlob(pattern: string): string[] {
  if (!hasGlob(pattern)) return existsSync(pattern) ? [pattern] : [];
  const segs = pattern.split(sep).filter(Boolean);
  const firstGlob = segs.findIndex(hasGlob);
  const root = sep + segs.slice(0, firstGlob).join(sep);
  const out = new Set<string>();
  let budget = MAX_FOLDERS;

  const list = (dir: string) => {
    if (budget-- <= 0) return [];
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const walk = (dir: string, rest: string[]) => {
    if (!rest.length) {
      out.add(dir);
      return;
    }
    const [seg, ...after] = rest as [string, ...string[]];
    if (seg === "**") {
      walk(dir, after);
      for (const e of list(dir)) if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name)) walk(join(dir, e.name), rest);
    } else if (!hasGlob(seg)) {
      const next = join(dir, seg);
      if (existsSync(next)) walk(next, after);
    } else {
      const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);
      for (const e of list(dir)) if (re.test(e.name) && (!after.length || e.isDirectory())) walk(join(dir, e.name), after);
    }
  };
  if (existsSync(root)) walk(root, segs.slice(firstGlob));
  return [...out];
}
