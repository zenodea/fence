// Does a host (and port) pass the pen's allow list?
//   "example.com"      that host, ports 80 and 443
//   "*.example.com"    any subdomain of it (not example.com itself)
//   "example.com:8443" that host on that port
//   "*"                anything

const DEFAULT_PORTS = new Set([80, 443]);

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function allows(rules: readonly string[], rawHost: string, port: number): boolean {
  const host = normalizeHost(rawHost);
  for (const raw of rules) {
    const rule = raw.trim().toLowerCase();
    if (rule === "*") return true;
    const colon = rule.lastIndexOf(":");
    const hasPort = colon > 0 && /^\d+$/.test(rule.slice(colon + 1));
    const pattern = hasPort ? rule.slice(0, colon) : rule;
    if (hasPort ? Number(rule.slice(colon + 1)) !== port : !DEFAULT_PORTS.has(port)) continue;
    if (pattern.startsWith("*.")) {
      if (host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1) return true;
    } else if (host === pattern) return true;
  }
  return false;
}

/** A domain someone typed into the allow box: trimmed, no scheme or path. */
export function cleanRule(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (!s) return null;
  if (!/^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)(:\d+)?$/.test(s)) return null;
  return s;
}
