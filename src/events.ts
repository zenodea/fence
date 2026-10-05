// What happened at a pen's fence: a log per pen, and a herdr toast when
// something was stopped (once a minute per thing, so a retry loop doesn't spam).
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { notify } from "./herdr/client.ts";
import { ensureDir, logDir } from "./paths.ts";

export type FenceEvent = {
  t: string;
  pen: string | null;
  pane: string | null;
  /** net: a domain; file: a path; herdr: a socket call; app: another app; tripwire: a watched file changed. */
  kind: "net" | "file" | "herdr" | "app" | "tripwire" | "info";
  verdict: "denied" | "allowed" | "changed" | "info";
  /** The domain, path or method. */
  target: string;
  /** What did it: a process name, the operation. */
  detail?: string;
};

const MAX_LOG_BYTES = 2_000_000;

export function logFile(pen: string | null): string {
  return join(logDir, `${pen ?? "run"}.jsonl`);
}

export function record(e: Omit<FenceEvent, "t">): FenceEvent {
  const event = { t: new Date().toISOString(), ...e };
  try {
    ensureDir(logDir);
    const file = logFile(e.pen);
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0);
    appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {}
  return event;
}

export function readLog(pen: string | null, limit = 500): FenceEvent[] {
  try {
    const lines = readFileSync(logFile(pen), "utf8").trimEnd().split("\n");
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as FenceEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is FenceEvent => e !== null);
  } catch {
    return [];
  }
}

const lastToast = new Map<string, number>();
const TOAST_EVERY_MS = 60_000;

/** Log a denial and, unless the same one was just shown, tell you about it. */
export function denied(e: Omit<FenceEvent, "t" | "verdict">, penName: string, title: string, body?: string): void {
  record({ ...e, verdict: "denied" });
  const key = `${e.pen}|${e.kind}|${e.target}`;
  const now = Date.now();
  if ((lastToast.get(key) ?? 0) + TOAST_EVERY_MS > now) return;
  lastToast.set(key, now);
  void notify(`🐑 ${title}`, body ?? `${penName} · prefix+p to see the pen`);
}
