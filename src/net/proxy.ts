// The pen's only way out: an HTTP proxy that lets through the domains on the
// allow list (HTTPS by CONNECT, plain HTTP by forwarding) and refuses the rest.
// It sees the domain, not what's inside the TLS.
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import { allows, normalizeHost } from "./match.ts";

export type ProxyDecision = { host: string; port: number; allowed: boolean; method: string; reason?: string };

export type ProxyOptions = {
  /** Read on every request, so a domain let through from the window works at once. */
  rules: () => readonly string[];
  onDecision: (d: ProxyDecision) => void;
};

const DENY_BODY = (host: string) => `fence: ${host} is outside this pen's fence. Let it through from the pen's window in herdr.\n`;

/**
 * This machine and the link-local range (cloud metadata) are never reachable
 * through the proxy, whatever the list says: that's where herdr's neighbours
 * (Shepherd, graphdiff, dev servers) listen.
 */
export function isLocalAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fe80:");
}

/** Where to actually connect: the address it resolves to, checked, so a later lookup can't swap it. */
async function resolveSafe(host: string): Promise<{ address: string } | { reason: string }> {
  try {
    const { address } = isIP(host) ? { address: host } : await lookup(host);
    if (isLocalAddress(address)) return { reason: `${host} is this machine (${address})` };
    return { address };
  } catch (err) {
    return { reason: `can't resolve ${host}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` };
  }
}

function splitHostPort(target: string, fallbackPort: number): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target);
  if (!m) return null;
  return { host: normalizeHost(m[1]!), port: m[2] ? Number(m[2]) : fallbackPort };
}

export function createProxy(opts: ProxyOptions): Server {
  /** The address to connect to, or null when it stays out (and has been reported). */
  const decide = async (host: string, port: number, method: string): Promise<string | null> => {
    if (!allows(opts.rules(), host, port)) {
      opts.onDecision({ host, port, allowed: false, method });
      return null;
    }
    const where = await resolveSafe(host);
    if ("reason" in where) {
      opts.onDecision({ host, port, allowed: false, method, reason: where.reason });
      return null;
    }
    opts.onDecision({ host, port, allowed: true, method });
    return where.address;
  };

  const server = createServer(async (req, res) => {
    // Plain HTTP arrives in absolute form: GET http://host/path
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("fence: this is a proxy\n");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end("fence: only http:// here; https goes through CONNECT\n");
      return;
    }
    const port = Number(url.port || 80);
    const host = normalizeHost(url.hostname);
    req.pause();
    const address = await decide(host, port, req.method ?? "GET");
    if (!address) {
      res.writeHead(403, { "content-type": "text/plain" }).end(DENY_BODY(host));
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = httpRequest(
      { host: address, port, method: req.method, path: url.pathname + url.search, headers },
      (up: IncomingMessage) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502).end(`fence: ${host}: ${err.message}\n`);
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = splitHostPort(req.url ?? "", 443);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    client.on("error", () => client.destroy());
    const address = await decide(target.host, target.port, "CONNECT");
    if (!address) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${DENY_BODY(target.host)}`);
      return;
    }
    const upstream = connect(target.port, address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", (err) => {
      if (!client.destroyed && client.writable && upstream.connecting) client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\nfence: ${err.message}\n`);
      else close();
    });
    client.on("error", close);
  });

  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}
