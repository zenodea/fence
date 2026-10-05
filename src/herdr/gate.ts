// The herdr gate: the pen's stand-in for herdr's socket. An agent's herdr
// integration can still say how it's doing (working, blocked, done) for its own
// pane; everything else (opening panes, typing into them, reading them) is
// refused, because any of that walks straight out of the pen.
import { createConnection, createServer, type Server } from "node:net";
import { lineReader } from "./client.ts";

/** Calls about the caller's own pane that can't reach anything else. */
export const GATE_ALLOWED = new Set([
  "pane.report_agent",
  "pane.report_agent_session",
  "pane.release_agent",
  "pane.clear_agent_authority",
  "pane.report_metadata",
]);

/** Harmless, and the herdr CLI sends it before anything else. */
const ANYONE = new Set(["ping"]);

export type GateDecision = { method: string; allowed: boolean; reason?: string };

export function judge(request: unknown, ownPane: string | null): GateDecision {
  const req = request as { method?: unknown; params?: { pane_id?: unknown } };
  const method = typeof req?.method === "string" ? req.method : "?";
  if (ANYONE.has(method)) return { method, allowed: true };
  if (!GATE_ALLOWED.has(method)) return { method, allowed: false, reason: "not allowed from inside a pen" };
  if (!ownPane || req.params?.pane_id !== ownPane) return { method, allowed: false, reason: "only for the pen's own pane" };
  return { method, allowed: true };
}

export function createGate(opts: { herdrSocket: string; ownPane: string | null; onDecision: (d: GateDecision) => void }): Server {
  return createServer((client) => {
    client.on("error", () => client.destroy());
    client.on(
      "data",
      lineReader((line) => {
        let req: any;
        try {
          req = JSON.parse(line);
        } catch {
          client.end(JSON.stringify({ id: null, error: { code: "invalid_request", message: "fence: not JSON" } }) + "\n");
          return;
        }
        const d = judge(req, opts.ownPane);
        if (d.method !== "ping") opts.onDecision(d);
        if (!d.allowed) {
          const message = `fence: ${d.method} is ${d.reason}`;
          client.end(JSON.stringify({ id: req?.id ?? null, error: { code: "fence_denied", message } }) + "\n");
          return;
        }
        // herdr answers one request per connection, so this one gets its own.
        const upstream = createConnection(opts.herdrSocket);
        upstream.on("connect", () => upstream.write(JSON.stringify(req) + "\n"));
        upstream.on("data", (chunk) => client.write(chunk));
        upstream.on("end", () => client.end());
        upstream.on("error", (err) => client.end(JSON.stringify({ id: req.id ?? null, error: { code: "herdr_unreachable", message: err.message } }) + "\n"));
      }),
    );
  });
}
