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

export type Follower = {
  stop: () => void;
  /** Resolves once denials are really being heard (or after a moment, if that can't be confirmed). */
  ready: Promise<void>;
};

const PROBE_FILE = "/private/tmp/.fence-probe";
const PROBE_EVERY_MS = 150;
const PROBE_GIVE_UP_MS = 3000;

/**
 * `log stream` prints its header before it's attached, so that says nothing.
 * To know it hears us, cause a tagged denial on purpose (a write the probe's own
 * tiny sandbox refuses) until one comes back through the stream.
 */
export function followDenials(tag: string, onDenial: (d: MacDenial) => void): Follower | null {
  let child: ChildProcess;
  try {
    child = spawn("/usr/bin/log", ["stream", "--style", "ndjson", "--level", "default", "--predicate", `eventMessage CONTAINS "${tag}"`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  child.on("error", () => {});

  const probeTag = `${tag}probe`;
  let heard!: () => void;
  const ready = new Promise<void>((resolve) => (heard = resolve));
  const probe = () => {
    const p = spawn("/usr/bin/sandbox-exec", ["-p", `(version 1)(allow default)(deny file-write* (with message "${probeTag}") (literal "${PROBE_FILE}"))`, "/usr/bin/touch", PROBE_FILE], { stdio: "ignore" });
    p.on("error", () => {});
  };
  const probing = setInterval(probe, PROBE_EVERY_MS);
  const giveUp = setTimeout(() => heard(), PROBE_GIVE_UP_MS);
  void ready.then(() => {
    clearInterval(probing);
    clearTimeout(giveUp);
  });
  child.on("exit", () => heard());
  probe();

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
      if (message.includes(probeTag)) return heard();
      const d = parseDenial(message);
      if (d) onDenial(d);
    }),
  );
  return { stop: () => (heard(), child.kill()), ready };
}
