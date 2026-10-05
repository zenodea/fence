// The pen window (prefix+p): the pen for the space you're in, what's been
// stopped at its fence, the gates you've opened and the files it can't see.
// Also makes a pen when the space isn't one.
import { relative } from "node:path";
import { readLog, record, type FenceEvent } from "../events.ts";
import { expandGlob, matchesAny } from "../glob.ts";
import { createPen, fenceAll, penPanes, penThisWorkspace, prunePens, setProfile, unpen, type PaneReport } from "../herd.ts";
import { herdr } from "../herdr/client.ts";
import { cleanRule } from "../net/match.ts";
import { home } from "../paths.ts";
import { penForWorkspace, readPens, updatePen, type Pen } from "../pens.ts";
import { makePolicy, type Policy } from "../policy.ts";
import { DEFAULT_PROFILE, listProfiles, loadProfile, type Profile } from "../profile.ts";
import { frame, pad, screen, style, when } from "./ansi.ts";

export const SCREENS = ["pen", "gates", "files", "log", "pens"] as const;
export type Screen = (typeof SCREENS)[number];

const TABS: Record<Screen, { key: string; label: string }> = {
  pen: { key: "o", label: "Pen" },
  gates: { key: "g", label: "Gates" },
  // f fences on the Pen tab, so Files takes h, for hidden.
  files: { key: "h", label: "Files" },
  log: { key: "l", label: "Log" },
  pens: { key: "s", label: "All pens" },
};

export type GateRow =
  | { kind: "blocked"; target: string; count: number; last: string }
  | { kind: "yours"; rule: string }
  | { kind: "profile"; rule: string };

export type FileRow =
  | { kind: "tried"; path: string; shown: string; count: number; last: string; why: "hidden" | "read-only" | "outside the pen" | "shown now" }
  | { kind: "now"; path: string }
  | { kind: "yours"; pattern: string }
  | { kind: "shown"; pattern: string }
  | { kind: "profile"; pattern: string };

export type WindowData = {
  workspaceId: string | null;
  cwd: string;
  pen: Pen | null;
  profile: Profile | null;
  profiles: Profile[];
  panes: PaneReport[] | null;
  log: FenceEvent[];
  pens: Pen[];
  /** The pen's rules with real paths; null when the space isn't a pen. */
  policy: Policy | null;
  /** Files in the pen that are hidden right now, relative to its folder. */
  hiddenNow: string[];
};

export type Mode =
  | { kind: "normal" }
  | { kind: "pick-profile"; index: number; then: "new" | "pen" | "change" }
  | { kind: "confirm-unpen"; pen: Pen }
  | { kind: "type-domain"; text: string }
  | { kind: "type-path"; text: string };

export type ViewState = {
  screen: Screen;
  selected: number;
  mode: Mode;
  /** The profile a new pen gets. */
  draftProfile: string;
  flash: { text: string; tone: "ok" | "warn" | "error" } | null;
  now: number;
};

const tilde = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const label = (s: string) => style.dim(pad(s, 13));
export const keycap = (key: string) => `${style.dim("[")}${style.bold(style.cyan(key))}${style.dim("]")}`;

/** Gate rows: what was stopped lately first (that's what you came for), then yours, then the profile's. */
export function gateRows(data: WindowData): GateRow[] {
  const rows: GateRow[] = [];
  if (!data.pen) return rows;
  const allowed = new Set([...(data.profile?.net.allow ?? []), ...data.pen.allow]);
  const blocked = new Map<string, { count: number; last: string }>();
  for (const e of data.log) {
    if (e.kind !== "net" || e.verdict !== "denied" || e.target.includes("/") || e.target.startsWith("remote:")) continue;
    const b = blocked.get(e.target);
    blocked.set(e.target, { count: (b?.count ?? 0) + 1, last: e.t });
  }
  for (const [target, b] of [...blocked].sort((a, b) => b[1].last.localeCompare(a[1].last))) {
    if (!allowed.has(target)) rows.push({ kind: "blocked", target, ...b });
  }
  for (const rule of data.pen.allow) rows.push({ kind: "yours", rule });
  for (const rule of data.profile?.net.allow ?? []) rows.push({ kind: "profile", rule });
  return rows;
}

const ROUTINE = /\/\.(zsh|bash)_history|\/\.zcompdump|\/\.zsh_sessions\/|\.DS_Store$/;
const isHidden = (policy: Policy, path: string) => matchesAny(path, policy.always) || (matchesAny(path, policy.hide) && !matchesAny(path, policy.show));
/** A path the way the Files tab stores and shows it: relative inside the pen, ~ elsewhere. */
export const penPath = (dir: string, path: string) => (path === dir || path.startsWith(dir + "/") ? relative(dir, path) || "." : tilde(path));

/** What a pen hides right now: the files in its folder that match a hidden pattern. */
export function hiddenInPen(policy: Policy): string[] {
  const inside = policy.hide.filter((p) => p.startsWith(policy.dir + "/"));
  const found = inside.flatMap(expandGlob).filter((f) => !matchesAny(f, policy.show));
  return [...new Set(found)].map((f) => relative(policy.dir, f)).sort();
}

/** File rows: what the pen reached for lately, what's hidden now, then your changes and the profile's patterns. */
export function fileRows(data: WindowData): FileRow[] {
  const { pen, policy, profile } = data;
  if (!pen || !policy) return [];
  const rows: FileRow[] = [];
  const tried = new Map<string, { count: number; last: string }>();
  for (const e of data.log) {
    if (e.kind !== "file" || e.verdict !== "denied" || ROUTINE.test(e.target)) continue;
    tried.set(e.target, { count: (tried.get(e.target)?.count ?? 0) + 1, last: e.t });
  }
  for (const [path, t] of [...tried].sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, 5)) {
    const why = isHidden(policy, path) ? "hidden" : matchesAny(path, policy.protect) ? "read-only" : matchesAny(path, policy.write) ? "shown now" : "outside the pen";
    rows.push({ kind: "tried", path, shown: penPath(policy.dir, path), why, ...t });
  }
  for (const path of data.hiddenNow.slice(0, 8)) rows.push({ kind: "now", path });
  for (const pattern of pen.hide ?? []) rows.push({ kind: "yours", pattern });
  for (const pattern of pen.show ?? []) rows.push({ kind: "shown", pattern });
  for (const pattern of (profile?.files.hide ?? []).filter((h) => h.startsWith("{pen}")).slice(0, 6)) rows.push({ kind: "profile", pattern: pattern.replace("{pen}/", "") });
  return rows;
}

function filesScreen(view: ViewState, data: WindowData): string[] {
  if (!data.pen || !data.policy) return [`  ${style.dim("Not a pen, so nothing is hidden. Make one from the Pen tab.")}`];
  const rows = fileRows(data);
  const lines: string[] = [];
  const heads = { tried: "Reached for lately", now: "Hidden in this pen now", yours: "Hidden by you", shown: "Shown by you, though the profile hides it", profile: `From the ${data.pen.profile} profile` };
  let section = "";
  rows.forEach((row, i) => {
    if (row.kind !== section) {
      if (section) lines.push("");
      const extra = row.kind === "now" && data.hiddenNow.length > 8 ? style.dim(`  ${data.hiddenNow.length} files, the first 8`) : "";
      lines.push(`  ${style.bold(heads[row.kind])}${extra}`);
      section = row.kind;
    }
    const sel = i === view.selected;
    const mark = sel ? style.cyan(" › ") : "   ";
    const name = (s: string) => (sel ? style.bold(s) : s);
    if (row.kind === "tried") lines.push(`${mark}${style.red("✗")} ${pad(name(row.shown), 44)}${style.dim(`${row.why} · ${row.count}× · ${when(row.last, view.now)}`)}`);
    else if (row.kind === "now") lines.push(`${mark}${style.dim("∅")} ${name(row.path)}`);
    else if (row.kind === "yours") lines.push(`${mark}${style.dim("∅")} ${name(row.pattern)}`);
    else if (row.kind === "shown") lines.push(`${mark}${style.green("✓")} ${name(row.pattern)}`);
    else lines.push(`${mark}${style.dim(`∅ ${row.pattern}`)}`);
  });
  if (!rows.some((r) => r.kind === "now")) lines.unshift(`  ${style.dim("No file in the pen's folder is hidden. + hides one; the sealed profile hides .env files and keys.")}`, "");
  const elsewhere = data.policy.always.length + data.policy.hide.filter((h) => !h.startsWith(data.policy!.dir + "/")).length;
  const more = (data.profile?.files.hide ?? []).filter((h) => h.startsWith("{pen}")).length - 6;
  lines.push("", `  ${style.dim(`${more > 0 ? `…and ${more} more patterns. ` : ""}Outside the pen, ${elsewhere} places are hidden: keys, logins, shell history, herdr.`)}`);
  if (matchesAny(`${data.policy.dir}/.git`, data.policy.protect)) lines.push(`  ${style.dim(".git is read-only here: the pen can read history and diff, not stage or commit.")}`);
  return lines;
}

function paneLine(r: PaneReport): string {
  const who = r.pane.agent ? style.dim(` · ${r.pane.agent}`) : "";
  switch (r.state.state) {
    case "fenced":
      return `${style.green("● fenced")}${who}`;
    case "busy":
      return `${style.red("✗ not fenced")} ${style.dim(`running ${r.state.command.slice(0, 50)}`)}`;
    case "shell":
      return `${style.yellow("○ about to be fenced")}`;
    case "plugin":
      return style.dim("a plugin's window");
    default:
      return style.dim("gone");
  }
}

function penScreen(view: ViewState, data: WindowData): string[] {
  const lines: string[] = [];
  if (!data.pen) {
    lines.push(`  ${style.bold("This space isn't a pen.")}`, "");
    lines.push(`  ${keycap("n")} ${style.bold("new pen")}      a new space for ${tilde(data.cwd)}, every shell in it fenced`);
    lines.push(`  ${keycap("f")} ${style.bold("fence this")}   this space becomes the pen; shells get fenced, what's running now stays as it is`);
    lines.push("");
    const p = data.profiles.find((x) => x.name === view.draftProfile);
    lines.push(`  ${label("Profile")}${style.bold(view.draftProfile)}  ${style.dim(p?.description ?? "")}   ${keycap("p")} ${style.dim("change")}`);
    lines.push(`  ${label("Folder")}${tilde(data.cwd)}`);
    return lines;
  }
  const pen = data.pen;
  const blocked = data.log.filter((e) => e.verdict === "denied");
  lines.push(`  ${label("Pen")}${style.bold(pen.name)}  ${style.dim(`${pen.id} · space ${pen.workspaceId}`)}`);
  lines.push(`  ${label("Folder")}${tilde(pen.dir)}`);
  lines.push(`  ${label("Profile")}${style.bold(pen.profile)}  ${style.dim(data.profile?.description ?? "missing!")}`);
  const domains = data.profile?.net.allow.includes("*") ? "any domain" : `${data.profile?.net.allow.length ?? 0} domains`;
  lines.push(`  ${label("Network")}${domains}${pen.allow.length ? ` + ${pen.allow.length} you let through` : ""}`);
  const gitRo = data.policy && matchesAny(`${data.policy.dir}/.git`, data.policy.protect);
  lines.push(`  ${label("Files")}${data.hiddenNow.length ? `${data.hiddenNow.length} hidden in the pen` : style.dim("nothing hidden in the pen")}${gitRo ? style.dim(" · .git read-only") : ""}`);
  lines.push("");
  if (!data.panes) lines.push(`  ${label("Panes")}${style.dim("looking…")}`);
  else if (!data.panes.length) lines.push(`  ${label("Panes")}${style.dim("none (the space is gone?)")}`);
  else data.panes.forEach((r, i) => lines.push(`  ${label(i === 0 ? "Panes" : "")}${pad(r.pane.pane_id, 9)}${paneLine(r)}`));
  const unfenced = data.panes?.filter((r) => r.state.state === "busy").length ?? 0;
  if (unfenced) {
    lines.push(`  ${label("")}${style.yellow(`${unfenced} pane${unfenced === 1 ? " runs" : "s run"} outside the fence.`)} Quit what's running there and press ${keycap("f")}.`);
  }
  lines.push("");
  const last = blocked[blocked.length - 1];
  lines.push(
    `  ${label("Stopped")}${blocked.length ? `${blocked.length} time${blocked.length === 1 ? "" : "s"}${style.dim(` · last ${last!.target.replace(home, "~")}, ${when(last!.t, view.now)}`)}` : style.dim("nothing yet")}`,
  );
  return lines;
}

function gatesScreen(view: ViewState, data: WindowData): string[] {
  if (!data.pen) return [`  ${style.dim("Not a pen, so no gates. Make one from the Pen tab.")}`];
  const rows = gateRows(data);
  const lines: string[] = [];
  let section = "";
  rows.forEach((row, i) => {
    const head = row.kind === "blocked" ? "Stopped lately" : row.kind === "yours" ? "Let through by you" : `From the ${data.pen!.profile} profile`;
    if (head !== section) {
      if (section) lines.push("");
      lines.push(`  ${style.bold(head)}`);
      section = head;
    }
    const sel = i === view.selected;
    const mark = sel ? style.cyan(" › ") : "   ";
    if (row.kind === "blocked") lines.push(`${mark}${style.red("✗")} ${pad(sel ? style.bold(row.target) : row.target, 40)}${style.dim(`${row.count}× · ${when(row.last, view.now)}`)}`);
    else if (row.kind === "yours") lines.push(`${mark}${style.green("✓")} ${sel ? style.bold(row.rule) : row.rule}`);
    else lines.push(`${mark}${style.dim(`✓ ${row.rule}`)}`);
  });
  if (!rows.some((r) => r.kind === "blocked")) lines.unshift(`  ${style.dim("Nothing stopped at the fence lately.")}`, "");
  return lines;
}

function logScreen(data: WindowData, height: number): string[] {
  if (!data.log.length) return [`  ${style.dim("Nothing logged yet.")}`];
  return data.log.slice(-height).map((e) => {
    const verdict = e.verdict === "denied" ? style.red("stopped") : e.verdict === "allowed" ? style.green("let in ") : e.verdict === "changed" ? style.yellow("changed") : style.dim("·      ");
    return `  ${style.dim(e.t.slice(11, 19))}  ${verdict}  ${pad(e.kind, 9)}${e.target.replace(home, "~")}${e.detail ? style.dim(`  ${e.detail}`) : ""}`;
  });
}

function pensScreen(view: ViewState, data: WindowData): string[] {
  if (!data.pens.length) return [`  ${style.dim("No pens yet.")}`];
  return data.pens.map((p, i) => {
    const sel = i === view.selected;
    const here = p.workspaceId === data.workspaceId ? style.cyan(" (here)") : "";
    return `${sel ? style.cyan(" › ") : "   "}🐑 ${pad(sel ? style.bold(p.name) : p.name, 22)}${pad(p.profile, 10)}${style.dim(`${tilde(p.dir)} · ${p.workspaceId}`)}${here}`;
  });
}

function hints(view: ViewState, data: WindowData): [string, string][] {
  const m = view.mode;
  if (m.kind === "pick-profile") return [["↑↓", "choose"], ["enter", "use it"], ["esc", "back"]];
  if (m.kind === "type-domain") return [["enter", "let it through"], ["esc", "cancel"]];
  if (m.kind === "type-path") return [["enter", "hide it"], ["esc", "cancel"]];
  if (m.kind === "confirm-unpen") return [["y", "yes"], ["n", "no"]];
  switch (view.screen) {
    case "pen":
      return data.pen
        ? [["p", "profile"], ["f", "fence panes"], ["u", "unfence"], ["q", "close"]]
        : [["n", "new pen"], ["f", "fence this"], ["p", "profile"], ["q", "close"]];
    case "gates":
      return [["↑↓", "select"], ["a", "let through"], ["x", "fence off"], ["+", "add a domain"], ["q", "close"]];
    case "files":
      return [["↑↓", "select"], ["u", "show to the pen"], ["x", "remove"], ["+", "hide a path"], ["q", "close"]];
    case "log":
      return [["q", "close"]];
    case "pens":
      return [["↑↓", "select"], ["enter", "go there"], ["q", "close"]];
  }
}

export function render(view: ViewState, data: WindowData, cols: number, rows: number): string[] {
  const title = data.pen ? `${style.green("🐑")} ${style.bold(data.pen.name)}` : style.dim("not a pen");
  const header = `  ${style.bold("fence")}  ${title}`;
  const tabs = "  " + SCREENS.map((s) => (s === view.screen ? `${keycap(TABS[s].key)} ${style.bold(style.underline(TABS[s].label))}` : `${style.dim(`[${TABS[s].key}]`)} ${style.dim(TABS[s].label)}`)).join("   ");
  const top = [header, "", tabs, style.dim("─".repeat(cols)), ""];
  const height = Math.max(0, rows - top.length - 3);

  let body: string[];
  const m = view.mode;
  if (m.kind === "pick-profile") {
    body = [`  ${style.bold(m.then === "change" ? "A new profile for this pen" : "Which profile?")}`, ""];
    data.profiles.forEach((p, i) => {
      const sel = i === m.index;
      body.push(`${sel ? style.cyan(" › ") : "   "}${pad(sel ? style.bold(p.name) : p.name, 12)}${style.dim(p.description)}${p.source === "user" ? style.dim(" (yours)") : ""}`);
    });
    if (m.then === "change") body.push("", `  ${style.dim("New panes get it at once; shells already fenced keep theirs until they exit.")}`);
  } else if (view.screen === "pen") body = penScreen(view, data);
  else if (view.screen === "gates") body = gatesScreen(view, data);
  else if (view.screen === "files") body = filesScreen(view, data);
  else if (view.screen === "log") body = logScreen(data, height);
  else body = pensScreen(view, data);
  body = body.slice(0, height);
  while (body.length < height) body.push("");

  let message = "";
  if (m.kind === "confirm-unpen") message = style.yellow(`  Stop fencing ${m.pen.name}? Shells already fenced stay fenced until they exit.  y yes · n no`);
  else if (m.kind === "type-path") message = `  Hide from the pen: ${style.bold(m.text)}${style.inverse(" ")}  ${style.dim("e.g. config/secrets.yml, **/*.sqlite, ~/notes")}`;
  else if (m.kind === "type-domain") message = `  Let through: ${style.bold(m.text)}${style.inverse(" ")}  ${style.dim("e.g. example.com, *.example.com, example.com:8443")}`;
  else if (view.flash) message = `  ${(view.flash.tone === "ok" ? style.green : view.flash.tone === "warn" ? style.yellow : style.red)(view.flash.text)}`;
  const hintLine = "  " + hints(view, data).map(([k, what]) => `${keycap(k)} ${style.dim(what)}`).join("  ");
  return [...top, ...body, "", message, hintLine];
}

export async function runWindow(opts: { workspaceId: string | null; paneId: string | null; cwd: string; screen?: string }): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  const initial = (SCREENS as readonly string[]).includes(opts.screen ?? "") ? (opts.screen as Screen) : "pen";

  const load = (panes: PaneReport[] | null): WindowData => {
    const pen = penForWorkspace(opts.workspaceId);
    let profile: Profile | null = null;
    try {
      profile = pen ? loadProfile(pen.profile) : null;
    } catch {}
    let profiles: Profile[] = [];
    try {
      profiles = listProfiles();
    } catch {}
    let policy: Policy | null = null;
    try {
      policy = pen && profile ? makePolicy(profile, { dir: pen.dir, pen }) : null;
    } catch {}
    return { workspaceId: opts.workspaceId, cwd: opts.cwd, pen, profile, profiles, panes, log: pen ? readLog(pen.id, 400) : [], pens: readPens(), policy, hiddenNow: policy ? hiddenNow(policy) : [] };
  };
  // Walking the pen's folder is the slow part, so it's done every few seconds, or at once when the rules change.
  let walked: { key: string; at: number; files: string[] } | null = null;
  const hiddenNow = (policy: Policy): string[] => {
    const key = JSON.stringify([policy.dir, policy.hide, policy.show]);
    if (!walked || walked.key !== key || Date.now() - walked.at > 4000) walked = { key, at: Date.now(), files: hiddenInPen(policy) };
    return walked.files;
  };

  const view: ViewState = { screen: initial, selected: 0, mode: { kind: "normal" }, draftProfile: DEFAULT_PROFILE, flash: null, now: Date.now() };
  let data = load(null);
  let flashTimer: NodeJS.Timeout | null = null;
  let busy = false;

  const draw = () => out.write(frame(render(view, data, out.columns || 80, out.rows || 24), out.columns || 80, out.rows || 24));
  const flash = (text: string, tone: "ok" | "warn" | "error" = "ok") => {
    view.flash = { text, tone };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      view.flash = null;
      draw();
    }, 5000);
    draw();
  };
  const refreshPanes = async () => {
    if (!data.pen) return;
    try {
      data.panes = await penPanes(data.pen);
    } catch {}
    draw();
  };
  const refresh = () => {
    view.now = Date.now();
    data = load(data.panes);
    const max = view.screen === "gates" ? gateRows(data).length : view.screen === "files" ? fileRows(data).length : view.screen === "pens" ? data.pens.length : 0;
    view.selected = Math.max(0, Math.min(view.selected, max - 1));
    draw();
  };
  const close = () => {
    out.write(screen.leave);
    if (input.isTTY) input.setRawMode(false);
    process.exit(0);
  };
  /** Runs one thing at a time and shows how it went. */
  const act = async (start: string, fn: () => Promise<string | void>) => {
    if (busy) return;
    busy = true;
    flash(start, "warn");
    try {
      const msg = await fn();
      if (msg) flash(msg, /not fenced|isn't|couldn't/.test(msg) ? "warn" : "ok");
    } catch (err) {
      flash((err as Error).message, "error");
    }
    busy = false;
    refresh();
    void refreshPanes();
  };
  const problemsMsg = (name: string, problems: PaneReport[]) =>
    problems.length ? `${name} is a pen; ${problems.length} pane${problems.length === 1 ? " is" : "s are"} still running something outside it` : `${name} is a pen; every pane is fenced`;

  const pickProfile = (then: "new" | "pen" | "change") => {
    const current = then === "change" ? data.pen?.profile : view.draftProfile;
    view.mode = { kind: "pick-profile", then, index: Math.max(0, data.profiles.findIndex((p) => p.name === current)) };
    draw();
  };
  const usedProfile = (then: "new" | "pen" | "change", name: string) => {
    view.mode = { kind: "normal" };
    if (then === "change" && data.pen) {
      setProfile(data.pen, name);
      record({ pen: data.pen.id, pane: null, kind: "info", verdict: "info", target: `profile is now ${name}` });
      flash(`${data.pen.name} uses ${name} now. New panes get it; restart fenced shells to apply it there.`);
      refresh();
    } else {
      view.draftProfile = name;
      draw();
    }
  };

  const allowRule = (rule: string) => {
    if (!data.pen) return;
    const pen = data.pen;
    updatePen(pen.id, (p) => ({ ...p, allow: [...new Set([...p.allow, rule])] }));
    record({ pen: pen.id, pane: null, kind: "info", verdict: "info", target: `let through ${rule}` });
    flash(`${rule} is let through. It works at once, in every pane of ${pen.name}.`);
    refresh();
  };

  /** Files only change for shells that start afterwards: the sandbox's rules are fixed when it starts. */
  const WHEN = "New panes get it; fenced shells keep their rules until they exit.";
  const changeFiles = (change: (pen: Pen) => Pen, logged: string, said: string) => {
    if (!data.pen) return;
    updatePen(data.pen.id, change);
    record({ pen: data.pen.id, pane: null, kind: "info", verdict: "info", target: logged });
    flash(`${said} ${WHEN}`);
    refresh();
  };

  const onKey = (key: string) => {
    if (key === "\x03") return close();
    const m = view.mode;
    if (m.kind === "confirm-unpen") {
      view.mode = { kind: "normal" };
      if (key === "y" || key === "Y") void act("Taking the fence down…", async () => {
        await unpen(m.pen);
        return `${m.pen.name} isn't a pen any more`;
      });
      else draw();
      return;
    }
    if (m.kind === "type-domain") {
      if (key === "\x1b") view.mode = { kind: "normal" };
      else if (key === "\r") {
        const rule = cleanRule(m.text);
        view.mode = { kind: "normal" };
        if (rule) allowRule(rule);
        else flash(`${m.text || "that"} isn't a domain fence understands`, "error");
      } else if (key === "\x7f") m.text = m.text.slice(0, -1);
      else if (/^[\x20-\x7e]+$/.test(key)) m.text += key;
      draw();
      return;
    }
    if (m.kind === "type-path") {
      if (key === "\x1b") view.mode = { kind: "normal" };
      else if (key === "\r") {
        const path = m.text.trim();
        view.mode = { kind: "normal" };
        if (path && !path.includes('"') && data.pen) changeFiles((p) => ({ ...p, hide: [...new Set([...(p.hide ?? []), path])], show: (p.show ?? []).filter((x) => x !== path) }), `hid ${path}`, `${path} is hidden.`);
        else if (path) flash("fence can't hide a path with a double quote in it", "error");
      } else if (key === "\x7f") m.text = m.text.slice(0, -1);
      else if (/^[\x20-\x7e]+$/.test(key)) m.text += key;
      draw();
      return;
    }
    if (m.kind === "pick-profile") {
      if (key === "\x1b" || key === "q") view.mode = { kind: "normal" };
      else if (key === "\x1b[A" || key === "k") m.index = Math.max(0, m.index - 1);
      else if (key === "\x1b[B" || key === "j") m.index = Math.min(data.profiles.length - 1, m.index + 1);
      else if (key === "\r" && data.profiles[m.index]) return usedProfile(m.then, data.profiles[m.index]!.name);
      draw();
      return;
    }

    const show = (s: Screen) => {
      view.screen = s;
      view.selected = 0;
      refresh();
    };
    switch (key) {
      case "q":
      case "\x1b":
        return close();
      case "o":
        return show("pen");
      case "g":
        return show("gates");
      case "h":
        return show("files");
      case "l":
        return show("log");
      case "s":
        return show("pens");
      case "\t":
        return show(SCREENS[(SCREENS.indexOf(view.screen) + 1) % SCREENS.length]!);
      case "\x1b[Z":
        return show(SCREENS[(SCREENS.indexOf(view.screen) + SCREENS.length - 1) % SCREENS.length]!);
    }

    if (view.screen === "pen") {
      if (key === "p") return pickProfile(data.pen ? "change" : "new");
      if (!data.pen && key === "n") {
        return void act("Building the pen…", async () => {
          const { pen, problems } = await createPen({ name: opts.cwd.split("/").pop() || "pen", dir: opts.cwd, profile: view.draftProfile });
          setTimeout(close, 1200);
          return problemsMsg(pen.name, problems);
        });
      }
      if (!data.pen && key === "f") {
        if (!opts.workspaceId) return flash("Can't tell which space this is.", "error");
        return void act("Fencing this space…", async () => {
          const { pen, problems } = await penThisWorkspace({ workspaceId: opts.workspaceId!, dir: opts.cwd, profile: view.draftProfile });
          return problemsMsg(pen.name, problems);
        });
      }
      if (data.pen && key === "f") {
        const pen = data.pen;
        return void act("Fencing every shell in the pen…", async () => problemsMsg(pen.name, await fenceAll(pen)));
      }
      if (data.pen && key === "u") {
        view.mode = { kind: "confirm-unpen", pen: data.pen };
        return draw();
      }
      return;
    }

    if (view.screen === "gates") {
      const rows = gateRows(data);
      const row = rows[view.selected];
      if (key === "\x1b[A" || key === "k") view.selected = Math.max(0, view.selected - 1);
      else if (key === "\x1b[B" || key === "j") view.selected = Math.min(rows.length - 1, view.selected + 1);
      else if (key === "+" && data.pen) view.mode = { kind: "type-domain", text: "" };
      else if ((key === "a" || key === "\r") && row?.kind === "blocked") return allowRule(row.target);
      else if (key === "x" && row?.kind === "yours" && data.pen) {
        const pen = data.pen;
        updatePen(pen.id, (p) => ({ ...p, allow: p.allow.filter((r) => r !== row.rule) }));
        record({ pen: pen.id, pane: null, kind: "info", verdict: "info", target: `fenced off ${row.rule}` });
        flash(`${row.rule} is fenced off again`);
        return refresh();
      } else if (key === "x" && row?.kind === "profile") return flash(`That one comes from the ${data.pen?.profile} profile; edit the profile to drop it.`, "warn");
      draw();
      return;
    }

    if (view.screen === "files") {
      const rows = fileRows(data);
      const row = rows[view.selected];
      if (key === "\x1b[A" || key === "k") view.selected = Math.max(0, view.selected - 1);
      else if (key === "\x1b[B" || key === "j") view.selected = Math.min(rows.length - 1, view.selected + 1);
      else if (key === "+" && data.pen) view.mode = { kind: "type-path", text: "" };
      else if (key === "u" && row && data.policy) {
        const path = row.kind === "tried" ? row.shown : row.kind === "now" ? row.path : null;
        if (row.kind === "tried" && row.why === "shown now") return flash("That one is shown already. New panes can read it.", "warn");
        if (row.kind === "tried" && row.why !== "hidden") return flash(row.why === "read-only" ? "That one isn't hidden, it's read-only: it would run outside the pen later." : "That one isn't hidden, it's outside the pen: read-only. Widen files.write in a profile to change that.", "warn");
        if (row.kind === "tried" && matchesAny(row.path, data.policy.always)) return flash("herdr's and fence's own files stay hidden from every pen.", "warn");
        if (path) {
          // Hidden by you: just take it back. Hidden by the profile: an exception for this pen.
          const mine = (data.pen?.hide ?? []).includes(path);
          return changeFiles((p) => (mine ? { ...p, hide: (p.hide ?? []).filter((x) => x !== path) } : { ...p, show: [...new Set([...(p.show ?? []), path])] }), `showed ${path}`, `${path} is shown to the pen.`);
        }
        if (row.kind === "yours") return changeFiles((p) => ({ ...p, hide: (p.hide ?? []).filter((x) => x !== row.pattern) }), `showed ${row.pattern}`, `${row.pattern} is shown to the pen.`);
        if (row.kind === "profile") return flash(`That pattern comes from the ${data.pen?.profile} profile. Select a file under "Hidden in this pen now" to show just that one.`, "warn");
      } else if (key === "x" && row) {
        if (row.kind === "yours") return changeFiles((p) => ({ ...p, hide: (p.hide ?? []).filter((x) => x !== row.pattern) }), `showed ${row.pattern}`, `${row.pattern} isn't hidden any more.`);
        if (row.kind === "shown") return changeFiles((p) => ({ ...p, show: (p.show ?? []).filter((x) => x !== row.pattern) }), `hid ${row.pattern}`, `${row.pattern} is hidden again.`);
        return flash("Only what you hid or showed can be removed here.", "warn");
      }
      draw();
      return;
    }

    if (view.screen === "pens") {
      if (key === "\x1b[A" || key === "k") view.selected = Math.max(0, view.selected - 1);
      else if (key === "\x1b[B" || key === "j") view.selected = Math.min(data.pens.length - 1, view.selected + 1);
      else if (key === "\r" && data.pens[view.selected]) {
        const pen = data.pens[view.selected]!;
        void herdr("workspace.focus", { workspace_id: pen.workspaceId })
          .then(close)
          .catch(() => flash(`${pen.name}'s space isn't there any more`, "error"));
        return;
      }
      draw();
    }
  };

  out.write(screen.enter);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => onKey(chunk));
  out.on("resize", draw);
  process.on("SIGTERM", close);
  setInterval(refresh, 1000);
  setInterval(() => void refreshPanes(), 3000);
  draw();
  void refreshPanes();
  void prunePens().then(refresh, () => {});
  await new Promise(() => {});
}
