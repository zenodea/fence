// Just enough terminal drawing for the pen window, without a TUI library.

const ESC = "\x1b[";

export const style = {
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  inverse: (s: string) => `${ESC}7m${s}${ESC}27m`,
  underline: (s: string) => `${ESC}4m${s}${ESC}24m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
  /** 256-colour foreground and background, for the switches and keycaps. */
  paint: (s: string, fg: number, bg: number) => `${ESC}38;5;${fg};48;5;${bg}m${s}${ESC}39;49m`,
};

export const screen = {
  enter: `${ESC}?1049h${ESC}?25l`,
  leave: `${ESC}?25h${ESC}?1049l`,
  home: `${ESC}H`,
  clearLine: `${ESC}K`,
  clearBelow: `${ESC}J`,
};

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(s: string): number {
  return [...s.replace(ANSI_PATTERN, "")].length;
}

/** Cut a styled line to `width` visible characters. */
export function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length && visible < width; ) {
    if (s[i] === "\x1b") {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    visible++;
  }
  return `${out}${ESC}0m`;
}

export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

/** A whole frame: every line cut to the width, the rest of the screen cleared. */
export function frame(lines: string[], cols: number, rows: number): string {
  return screen.home + lines.slice(0, rows).map((l) => truncate(l, cols) + screen.clearLine).join("\r\n") + screen.clearBelow;
}

export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function when(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
