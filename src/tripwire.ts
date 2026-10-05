// Tripwires: files a pen has to be able to write (an agent's own config) but
// where a change could run code outside the pen later, like a new MCP server in
// ~/.claude.json. fence can't stop the write, so it tells you about it.
//   "~/.claude.json#mcpServers"  every "mcpServers" key in that JSON file, at any depth
//   "~/.some/file"               the whole file
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { home } from "./paths.ts";

export type Tripwire = { spec: string; path: string; key: string | null };

export function parseTripwire(spec: string): Tripwire {
  const hash = spec.lastIndexOf("#");
  const raw = hash === -1 ? spec : spec.slice(0, hash);
  const path = raw === "~" || raw.startsWith("~/") ? home + raw.slice(1) : raw;
  return { spec, path, key: hash === -1 ? null : spec.slice(hash + 1) };
}

function collect(value: unknown, key: string, out: unknown[]): void {
  if (Array.isArray(value)) for (const v of value) collect(v, key, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort()) : val));

/** A fingerprint of what the tripwire watches, or null if the file isn't there (or isn't JSON yet). */
export function fingerprint(t: Tripwire): string | null {
  let text: string;
  try {
    text = readFileSync(t.path, "utf8");
  } catch {
    return null;
  }
  if (!t.key) return createHash("sha256").update(text).digest("hex");
  try {
    const found: unknown[] = [];
    collect(JSON.parse(text), t.key, found);
    return createHash("sha256").update(stable(found)).digest("hex");
  } catch {
    return null;
  }
}

/** Polls the tripwires; calls back once per change. */
export function watchTripwires(specs: string[], onChange: (t: Tripwire) => void, everyMs = 2000): () => void {
  const wires = specs.map(parseTripwire);
  const seen = new Map(wires.map((w) => [w.spec, { print: fingerprint(w), mtime: mtime(w.path) }]));
  const timer = setInterval(() => {
    for (const w of wires) {
      const before = seen.get(w.spec)!;
      const m = mtime(w.path);
      if (m === before.mtime) continue;
      const print = fingerprint(w);
      // A half-written JSON file reads as null; wait for the next look.
      if (print === null && w.key) {
        before.mtime = -1;
        continue;
      }
      if (print !== before.print && before.print !== null) onChange(w);
      seen.set(w.spec, { print, mtime: m });
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
