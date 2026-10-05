// macOS writes every sandbox denial to the system log, with the message the
// profile tagged it with. Following that log is how fence hears about blocked
// file writes and reads, not just blocked domains.
import { spawn, type ChildProcess } from "node:child_process";
import { lineReader } from "../herdr/client.ts";

export type MacDenial = { process: string; pid: number; operation: string; target: string };

// "Sandbox: zsh(123) deny(1) file-write-create /Users/me/.zshrc"
const DENIAL = /Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?/;

export function parseDenial(message: string): MacDenial | null {
  const m = DENIAL.exec(message);
  if (!m) return null;
  return { process: m[1]!, pid: Number(m[2]), operation: m[3]!, target: (m[4] ?? "").trim() };
}

/** Lookups the shell and its tools make all the time, fenced off on purpose: not even logged. */
export function isNoise(d: MacDenial): boolean {
  return d.operation === "network-outbound" && /mDNSResponder|\/var\/run\/syslog/.test(d.target);
}

/** What every shell does when it starts or exits (history, completion caches): logged, never toasted. */
export function isRoutine(d: MacDenial): boolean {
  return /\/\.(zsh|bash)_history|\/\.zcompdump|\/\.zsh_sessions\/|\/\.DS_Store$|\/\.local\/share\/fish\/fish_history/.test(d.target);
}

export function followDenials(tag: string, onDenial: (d: MacDenial) => void): ChildProcess | null {
  let child: ChildProcess;
  try {
    child = spawn("/usr/bin/log", ["stream", "--style", "ndjson", "--level", "default", "--predicate", `eventMessage CONTAINS "${tag}"`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  child.on("error", () => {});
  child.stdout!.on(
    "data",
    lineReader((line) => {
      let message: unknown;
      try {
        message = JSON.parse(line).eventMessage;
      } catch {
        return;
      }
      if (typeof message !== "string" || !message.includes(tag)) return;
      const d = parseDenial(message);
      if (d) onDenial(d);
    }),
  );
  return child;
}
