// macOS: a Seatbelt profile for sandbox-exec. Everything is allowed except what
// the policy fences off; the kernel enforces it for the shell and everything it
// starts, and logs each denial with the pen's tag.
import { globToRegexSource, hasGlob } from "../glob.ts";
import type { Policy } from "../policy.ts";

const q = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** A path rule: a folder and what's in it, or a pattern. */
export function pathFilter(path: string): string {
  if (path.includes('"')) throw new Error(`can't fence a path with a double quote in it: ${path}`);
  if (!hasGlob(path)) return `(subpath ${q(path)})`;
  return `(regex #"${globToRegexSource(path)}")`;
}

export type MacSockets = { proxyPort: number; gateSocket: string };

export function seatbeltProfile(p: Policy, s: MacSockets): string {
  const tag = `(with message ${q(p.tag)})`;
  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    "; writes: only the pen's folders, the terminal and the usual devices",
    `(deny file-write* ${tag}`,
    "  (require-not (require-any",
    ...p.write.map((w) => `    ${pathFilter(w)}`),
    '    (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '    (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/")',
    "  )))",
    "",
    "; read-only inside the writable folders: things that run later, outside the pen",
    `(deny file-write* ${tag}`,
    ...p.protect.map((w) => `  ${pathFilter(w)}`),
    ")",
    "",
    "; hidden: secrets, herdr's socket and config, fence's own state",
    `(deny file-read* file-write* ${tag}`,
    ...p.always.map((h) => `  ${pathFilter(h)}`),
    ")",
    ...(p.hide.length
      ? p.show.length
        ? [
            `(deny file-read* file-write* ${tag}`,
            "  (require-all",
            "    (require-any",
            ...p.hide.map((h) => `      ${pathFilter(h)}`),
            "    )",
            "    (require-not (require-any",
            ...p.show.map((h) => `      ${pathFilter(h)}`),
            "    ))))",
          ]
        : [`(deny file-read* file-write* ${tag}`, ...p.hide.map((h) => `  ${pathFilter(h)}`), ")"]
      : []),
    "",
    "; network: only fence's proxy, the herdr gate, and the localhost ports you named",
    `(deny network-outbound ${tag}`,
    "  (require-not (require-any",
    `    (remote ip ${q(`localhost:${s.proxyPort}`)})`,
    ...p.localhost.map((port) => `    (remote ip ${q(`localhost:${port}`)})`),
    `    (remote unix-socket (path-literal ${q(s.gateSocket)}))`,
    "  )))",
    "",
    "; signals: only to what runs inside this pen, so it can't kill herdr or your editor",
    `(deny signal ${tag})`,
    "(allow signal (target same-sandbox))",
    "",
    "; other apps: no Apple Events (osascript telling Terminal to run something)",
    `(deny appleevent-send ${tag})`,
  ];
  if (!p.open) {
    lines.push(
      "; no `open`: LaunchServices starts apps outside the sandbox",
      `(deny mach-lookup ${tag} (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb"))`,
    );
  }
  if (!p.clipboard) {
    lines.push("; no clipboard: it often holds a password you just copied", `(deny mach-lookup ${tag} (global-name "com.apple.pasteboard.1"))`);
  }
  return lines.join("\n") + "\n";
}

export function macCommand(profile: string, argv: string[]): string[] {
  return ["/usr/bin/sandbox-exec", "-p", profile, ...argv];
}
