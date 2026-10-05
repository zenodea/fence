// The list of pens: which herdr space is fenced, with which profile, and the
// domains you've let through since.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { configDir, ensureDir, pensFile } from "./paths.ts";

export type Pen = {
  id: string;
  name: string;
  /** The herdr space it is. */
  workspaceId: string;
  /** The folder the pen may write. */
  dir: string;
  profile: string;
  /** Domains let through from the pen's window, on top of the profile's. */
  allow: string[];
  createdAt: string;
};

type PensFile = { pens: Pen[] };

let cache: { mtimeMs: number; pens: Pen[] } | null = null;

export function readPens(): Pen[] {
  try {
    const { mtimeMs } = statSync(pensFile);
    if (cache && cache.mtimeMs === mtimeMs) return cache.pens;
    const data = JSON.parse(readFileSync(pensFile, "utf8")) as PensFile;
    cache = { mtimeMs, pens: Array.isArray(data.pens) ? data.pens : [] };
    return cache.pens;
  } catch {
    return [];
  }
}

function writePens(pens: Pen[]): void {
  ensureDir(configDir);
  const tmp = `${pensFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pens } satisfies PensFile, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, pensFile);
  cache = null;
}

export function penById(id: string): Pen | null {
  return readPens().find((p) => p.id === id) ?? null;
}

export function penForWorkspace(workspaceId: string | undefined | null): Pen | null {
  if (!workspaceId) return null;
  return readPens().find((p) => p.workspaceId === workspaceId) ?? null;
}

export function addPen(pen: Omit<Pen, "id" | "createdAt" | "allow">): Pen {
  const pens = readPens().filter((p) => p.workspaceId !== pen.workspaceId);
  const created: Pen = { id: randomBytes(4).toString("hex"), allow: [], createdAt: new Date().toISOString(), ...pen };
  writePens([...pens, created]);
  return created;
}

export function updatePen(id: string, change: (pen: Pen) => Pen): Pen | null {
  const pens = readPens();
  const i = pens.findIndex((p) => p.id === id);
  if (i === -1) return null;
  const next = [...pens];
  next[i] = change(pens[i]!);
  writePens(next);
  return next[i]!;
}

export function removePen(id: string): Pen | null {
  const pens = readPens();
  const gone = pens.find((p) => p.id === id) ?? null;
  if (gone) writePens(pens.filter((p) => p.id !== id));
  return gone;
}
