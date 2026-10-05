// herdr's socket API: newline-delimited JSON, one request per connection.
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { herdrSocketPath } from "../paths.ts";

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/** Splits a byte stream into lines. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

let nextId = 0;

export function herdr<T = any>(method: string, params: Record<string, unknown> = {}, opts: { socket?: string; timeoutMs?: number } = {}): Promise<T> {
  const id = `fence:${process.pid}:${++nextId}`;
  const socket = opts.socket ?? herdrSocketPath();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<T>((resolve, reject) => {
    const conn = createConnection(socket);
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new HerdrError("timeout", `herdr ${method} timed out`))), timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify({ id, method, params }) + "\n"));
    conn.on(
      "data",
      lineReader((line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.id !== id) return;
        if (msg.error) settle(() => reject(new HerdrError(msg.error.code, msg.error.message)));
        else settle(() => resolve(msg.result as T));
      }),
    );
    conn.on("error", (err) => settle(() => reject(err)));
    conn.on("close", () => settle(() => reject(new HerdrError("disconnected", `herdr closed the connection during ${method}`))));
  });
}

export type PaneInfo = { pane_id: string; workspace_id: string; tab_id: string; cwd?: string | null; agent?: string | null; agent_status?: string; label?: string | null };
export type WorkspaceInfo = { workspace_id: string; label: string; focused?: boolean };
export type ProcessInfo = {
  pane_id: string;
  shell_pid: number | null;
  foreground_process_group_id: number | null;
  foreground_processes: { pid: number; name: string; argv: string[]; cmdline: string; cwd?: string }[];
};

export const listWorkspaces = async (): Promise<WorkspaceInfo[]> => (await herdr("workspace.list")).workspaces ?? [];
export const listPanes = async (workspaceId?: string): Promise<PaneInfo[]> =>
  (await herdr("pane.list", workspaceId ? { workspace_id: workspaceId } : {})).panes ?? [];
export const processInfo = async (paneId: string): Promise<ProcessInfo> => (await herdr("pane.process_info", { pane_id: paneId })).process_info;

/** A herdr toast. Never throws: a missing herdr shouldn't break the pen. */
export async function notify(title: string, body?: string, sound: "none" | "request" = "none"): Promise<void> {
  try {
    await herdr("notification.show", { title, body: body ?? null, sound }, { timeoutMs: 3000 });
  } catch {}
}
