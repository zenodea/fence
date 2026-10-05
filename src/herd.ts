// Pens on the herdr side: making a space a pen, and getting every shell in it
// behind the fence. herdr can't start a pane with a command, so fence waits for
// the pane's shell to sit at its prompt and has it `exec` into `fence shell`.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { herdr, listPanes, listWorkspaces, processInfo, type PaneInfo } from "./herdr/client.ts";
import { cliPath, ensureDir, fenceBin, stateDir } from "./paths.ts";
import { addPen, penForWorkspace, readPens, removePen, updatePen, type Pen } from "./pens.ts";
import { makePolicy, readPaneRules, rulesStamp } from "./policy.ts";
import { DEFAULT_PROFILE, loadProfile } from "./profile.ts";

export const PEN_MARK = "🐑";

export type PaneState =
  /**
   * `idle`: only a shell is running inside, so it can be restarted without losing work.
   * `running`: what's in the foreground otherwise. `rules`: what its shell was started
   * with; null for a shell fenced by an older fence, which can't be restarted in place.
   */
  | { state: "fenced"; idle: boolean; running: string | null; rules: { pid: number; profile: string; stamp: string } | null }
  /** A plugin's own pane (like this window): not a shell, nothing to fence. */
  | { state: "plugin" }
  | { state: "shell" }
  | { state: "busy"; command: string }
  | { state: "gone" };

const SHELLS = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|nu|elvish|xonsh)$/;
const fenceCli = (() => {
  try {
    return realpathSync(cliPath);
  } catch {
    return cliPath;
  }
})();

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

let pluginRoots: Promise<Set<string>> | null = null;
/** Where herdr's plugins live: a pane running there is one of theirs. */
function knownPluginRoots(): Promise<Set<string>> {
  pluginRoots ??= herdr("plugin.list")
    .then((r) => new Set<string>((r.plugins ?? []).map((p: { plugin_root?: string }) => p.plugin_root).filter(Boolean)))
    .catch(() => new Set<string>());
  return pluginRoots;
}

function commandCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8" });
    return out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

export async function paneState(paneId: string): Promise<PaneState> {
  let info;
  try {
    info = await processInfo(paneId);
  } catch {
    return { state: "gone" };
  }
  if (!info?.shell_pid) return { state: "gone" };
  const top = commandOf(info.shell_pid);
  const fg = info.foreground_processes ?? [];
  if (top.includes(`${fenceCli} shell`)) {
    const busy = fg.find((p) => !SHELLS.test(p.name) && !SHELLS.test((p.argv?.[0] ?? "").split("/").pop() ?? ""));
    return { state: "fenced", idle: !busy, running: busy ? busy.cmdline || busy.name : null, rules: readPaneRules(paneId) };
  }
  const atPrompt = info.foreground_process_group_id === info.shell_pid || fg.length === 0 || fg.every((p) => p.pid === info.shell_pid);
  const name = top.split(/\s+/)[0]?.split("/").pop() ?? "";
  if (atPrompt && SHELLS.test(name)) return { state: "shell" };
  if (!SHELLS.test(name)) {
    const cwd = commandCwd(info.shell_pid);
    if (cwd && (await knownPluginRoots()).has(cwd)) return { state: "plugin" };
  }
  return { state: "busy", command: fg.find((p) => p.pid !== info.shell_pid)?.cmdline || top || "something" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The line a pen's shell runs. A leading space keeps it out of shell history. */
export const fenceLine = (pen: Pen) => ` exec '${fenceBin.replaceAll("'", "'\\''")}' shell --pen ${pen.id}`;

/**
 * Put a pane behind the fence. Waits up to `waitMs` for a new pane's shell to
 * reach its prompt; a pane already running something is left alone and
 * reported, never typed into.
 */
export async function fencePane(pen: Pen, paneId: string, waitMs = 8000): Promise<PaneState> {
  // Making a pen and herdr's pane.created hook both get here for the same pane.
  // Only one may type into it: the line run twice would replace the fenced shell.
  const release = claim(paneId);
  if (!release) {
    const until = Date.now() + waitMs;
    let state = await paneState(paneId);
    while (state.state === "shell" && Date.now() < until) {
      await sleep(250);
      state = await paneState(paneId);
    }
    return state;
  }
  try {
    return await fenceClaimed(pen, paneId, waitMs);
  } finally {
    release();
  }
}

const CLAIM_MS = 20_000;
/** Take the right to fence a pane, or null if someone else is at it. */
function claim(paneId: string): (() => void) | null {
  const file = join(ensureDir(join(stateDir, "fencing")), paneId.replace(/[^A-Za-z0-9_-]/g, "_"));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(file, "wx"));
      return () => rmSync(file, { force: true });
    } catch {
      try {
        // Left behind by a run that died: take it over.
        if (Date.now() - statSync(file).mtimeMs > CLAIM_MS) rmSync(file, { force: true });
        else return null;
      } catch {}
    }
  }
  return null;
}

async function fenceClaimed(pen: Pen, paneId: string, waitMs: number): Promise<PaneState> {
  const until = Date.now() + waitMs;
  let state = await paneState(paneId);
  while (state.state !== "shell" && state.state !== "fenced" && state.state !== "plugin" && Date.now() < until) {
    await sleep(250);
    state = await paneState(paneId);
  }
  if (state.state !== "shell") return state;
  // A just-opened shell may still be drawing its prompt; give it a beat.
  await sleep(150);
  await herdr("pane.send_input", { pane_id: paneId, text: fenceLine(pen), keys: ["enter"] });
  const confirm = Date.now() + 5000;
  while (Date.now() < confirm) {
    await sleep(200);
    state = await paneState(paneId);
    if (state.state === "fenced" || state.state === "gone") return state;
  }
  return state;
}

/** `stale`: fenced, but on rules the pen has since changed (another profile, other hidden files). */
export type PaneReport = { pane: PaneInfo; state: PaneState; stale?: boolean };

/** The fingerprint a pane started now would have. */
export function currentStamp(pen: Pen): string | null {
  try {
    const profile = loadProfile(pen.profile);
    return rulesStamp(makePolicy(profile, { dir: pen.dir, pen }), profile);
  } catch {
    return null;
  }
}

export async function penPanes(pen: Pen): Promise<PaneReport[]> {
  const panes = await listPanes(pen.workspaceId).catch(() => [] as PaneInfo[]);
  const now = currentStamp(pen);
  return Promise.all(
    panes.map(async (pane) => {
      const state = await paneState(pane.pane_id);
      return { pane, state, stale: state.state === "fenced" && state.rules !== null && now !== null && state.rules.stamp !== now };
    }),
  );
}

export type Applied = { restarted: number; fenced: number; waiting: PaneReport[] };

/**
 * Put the pen's panes on its current rules: fence shells that aren't, and restart
 * the shell in fenced panes that are on old rules. Only idle panes are touched;
 * one that's running something (an agent, a server) is left alone and reported.
 */
export async function applyToPanes(pen: Pen): Promise<Applied> {
  const out: Applied = { restarted: 0, fenced: 0, waiting: [] };
  for (const r of await penPanes(pen)) {
    const s = r.state;
    if (s.state === "shell") {
      const after = await fencePane(pen, r.pane.pane_id, 3000);
      if (after.state === "fenced") out.fenced++;
      else out.waiting.push({ ...r, state: after });
    } else if (s.state === "busy") out.waiting.push(r);
    else if (s.state === "fenced" && r.stale) {
      if (!s.idle || !s.rules) {
        out.waiting.push(r);
        continue;
      }
      try {
        process.kill(s.rules.pid, "SIGUSR1");
        out.restarted++;
      } catch {
        out.waiting.push(r);
      }
    }
  }
  return out;
}

/** Fence whatever in the pen can be fenced; returns the panes that couldn't be. */
export async function fenceAll(pen: Pen, waitMs = 3000): Promise<PaneReport[]> {
  const panes = await listPanes(pen.workspaceId).catch(() => [] as PaneInfo[]);
  const results = await Promise.all(panes.map(async (pane) => ({ pane, state: await fencePane(pen, pane.pane_id, waitMs) })));
  return results.filter((r) => r.state.state === "busy" || r.state.state === "shell");
}

const marked = (label: string) => (label.startsWith(PEN_MARK) ? label : `${PEN_MARK} ${label}`);
const unmarked = (label: string) => label.replace(new RegExp(`^${PEN_MARK}\\s*`), "");

export async function createPen(opts: { name: string; dir: string; profile?: string; focus?: boolean }): Promise<{ pen: Pen; problems: PaneReport[] }> {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  loadProfile(profile);
  const created = await herdr("workspace.create", { cwd: opts.dir, label: marked(opts.name), focus: opts.focus ?? true });
  const workspaceId: string = created.workspace.workspace_id;
  const pen = addPen({ name: opts.name, workspaceId, dir: opts.dir, profile });
  const problems = await fenceAll(pen, 8000);
  return { pen, problems };
}

/** Make an existing space a pen: its shells get fenced, anything already running is reported. */
export async function penThisWorkspace(opts: { workspaceId: string; dir: string; profile?: string; name?: string }): Promise<{ pen: Pen; problems: PaneReport[] }> {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  loadProfile(profile);
  const ws = (await listWorkspaces()).find((w) => w.workspace_id === opts.workspaceId);
  if (!ws) throw new Error(`no space ${opts.workspaceId}`);
  const name = opts.name ?? unmarked(ws.label);
  const pen = addPen({ name, workspaceId: opts.workspaceId, dir: opts.dir, profile });
  await herdr("workspace.rename", { workspace_id: opts.workspaceId, label: marked(ws.label) }).catch(() => {});
  const problems = await fenceAll(pen);
  return { pen, problems };
}

/** Stop treating the space as a pen. Shells already fenced stay fenced until they exit. */
export async function unpen(pen: Pen): Promise<void> {
  removePen(pen.id);
  const ws = (await listWorkspaces().catch(() => [])).find((w) => w.workspace_id === pen.workspaceId);
  if (ws) await herdr("workspace.rename", { workspace_id: pen.workspaceId, label: unmarked(ws.label) }).catch(() => {});
}

export function setProfile(pen: Pen, profile: string): Pen | null {
  loadProfile(profile);
  return updatePen(pen.id, (p) => ({ ...p, profile }));
}

/** The workspace and pane ids an event mentions, wherever herdr put them. */
export function idsIn(event: unknown): { workspaceId: string | null; paneId: string | null } {
  const found: { workspaceId: string | null; paneId: string | null } = { workspaceId: null, paneId: null };
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      if (k === "workspace_id" && typeof val === "string") found.workspaceId ??= val;
      else if (k === "pane_id" && typeof val === "string") found.paneId ??= val;
      else walk(val);
    }
  };
  walk(event);
  if (!found.workspaceId && found.paneId?.includes(":")) found.workspaceId = found.paneId.split(":")[0]!;
  return found;
}

/** herdr event hook: a new pane in a pen gets fenced; a closed pen's space is forgotten. */
export async function onEvent(name: string, json: string | undefined): Promise<string> {
  let event: unknown = {};
  try {
    event = JSON.parse(json ?? "{}");
  } catch {}
  const { workspaceId, paneId } = idsIn(event);
  if (name === "workspace.closed") {
    const pen = penForWorkspace(workspaceId);
    if (pen) removePen(pen.id);
    return pen ? `forgot pen ${pen.name}` : "not a pen";
  }
  const pen = penForWorkspace(workspaceId);
  if (!pen || !paneId) return "not a pen";
  const state = await fencePane(pen, paneId);
  return `${paneId}: ${state.state}`;
}

/** Forget pens whose space is gone (herdr doesn't always say when the last pane exits). */
export async function prunePens(): Promise<Pen[]> {
  const live = new Set((await listWorkspaces()).map((w) => w.workspace_id));
  const gone = readPens().filter((p) => !live.has(p.workspaceId));
  for (const pen of gone) removePen(pen.id);
  return gone;
}

/** At herdr start: fence the shells of every pen that's still there. */
export async function reconcile(): Promise<string[]> {
  const out = (await prunePens()).map((pen) => `${pen.name}: its space is gone, forgotten`);
  for (const pen of readPens()) {
    const problems = await fenceAll(pen, 8000);
    out.push(`${pen.name}: ${problems.length ? `${problems.length} pane(s) not fenced` : "all fenced"}`);
  }
  return out;
}
