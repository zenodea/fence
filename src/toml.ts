// Just enough TOML for fence's profiles: tables, strings, numbers, booleans,
// arrays (over several lines too) and inline tables. No dates, no arrays of tables.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let i = 0;
  let line = 1;

  const fail = (message: string): never => {
    throw new TomlError(message, line);
  };
  const peek = () => text[i];
  // Spaces and tabs only; newlines mean something at the top level.
  const skipBlank = () => {
    while (peek() === " " || peek() === "\t") i++;
  };
  const skipComment = () => {
    if (peek() === "#") while (i < text.length && peek() !== "\n") i++;
  };
  // Inside arrays: any whitespace, newlines and comments.
  const skipAll = () => {
    for (;;) {
      skipBlank();
      skipComment();
      if (peek() === "\n") {
        i++;
        line++;
      } else if (peek() === "\r") i++;
      else return;
    }
  };

  const bareKey = () => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9_-]/.test(peek()!)) i++;
    if (i === start) fail(`expected a key, found ${JSON.stringify(peek() ?? "end of file")}`);
    return text.slice(start, i);
  };
  const key = (): string => (peek() === '"' || peek() === "'" ? str() : bareKey());
  const dottedKey = (): string[] => {
    const parts = [key()];
    for (;;) {
      skipBlank();
      if (peek() !== ".") return parts;
      i++;
      skipBlank();
      parts.push(key());
    }
  };

  const str = (): string => {
    const quote = text[i++];
    let out = "";
    while (i < text.length) {
      const ch = text[i++]!;
      if (ch === quote) return out;
      if (ch === "\n") fail("newline in a string");
      if (ch === "\\" && quote === '"') {
        const esc = text[i++];
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
        if (esc && esc in simple) out += simple[esc];
        else if (esc === "u" || esc === "U") {
          const len = esc === "u" ? 4 : 8;
          const hex = text.slice(i, i + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail("bad unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          i += len;
        } else fail(`unknown escape \\${esc}`);
      } else out += ch;
    }
    return fail("unterminated string");
  };

  const value = (): TomlValue => {
    const ch = peek();
    if (ch === '"' || ch === "'") return str();
    if (ch === "[") {
      i++;
      const items: TomlValue[] = [];
      for (;;) {
        skipAll();
        if (peek() === "]") {
          i++;
          return items;
        }
        items.push(value());
        skipAll();
        if (peek() === ",") i++;
        else if (peek() !== "]") fail("expected , or ] in an array");
      }
    }
    if (ch === "{") {
      i++;
      const t: TomlTable = {};
      skipBlank();
      if (peek() === "}") {
        i++;
        return t;
      }
      for (;;) {
        skipBlank();
        const path = dottedKey();
        skipBlank();
        if (text[i++] !== "=") fail("expected = in an inline table");
        skipBlank();
        assign(t, path, value());
        skipBlank();
        const next = text[i++];
        if (next === "}") return t;
        if (next !== ",") fail("expected , or } in an inline table");
      }
    }
    const m = /^(true|false|[+-]?\d[\d_]*(?:\.\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) return fail(`unexpected ${JSON.stringify(ch ?? "end of file")}`);
    i += m[1]!.length;
    if (m[1] === "true") return true;
    if (m[1] === "false") return false;
    return Number(m[1]!.replaceAll("_", ""));
  };

  const assign = (t: TomlTable, path: string[], v: TomlValue) => {
    let at = t;
    for (const part of path.slice(0, -1)) {
      const next = at[part] ?? (at[part] = {});
      if (typeof next !== "object" || Array.isArray(next)) fail(`${part} is not a table`);
      at = next as TomlTable;
    }
    const last = path[path.length - 1]!;
    if (last in at) fail(`${path.join(".")} is set twice`);
    at[last] = v;
  };

  while (i < text.length) {
    skipAll();
    if (i >= text.length) break;
    if (peek() === "[") {
      i++;
      if (peek() === "[") fail("arrays of tables aren't supported");
      skipBlank();
      const path = dottedKey();
      skipBlank();
      if (text[i++] !== "]") fail("expected ] after a table name");
      table = root;
      for (const part of path) {
        const next = table[part] ?? (table[part] = {});
        if (typeof next !== "object" || Array.isArray(next)) fail(`${part} is not a table`);
        table = next as TomlTable;
      }
    } else {
      const path = dottedKey();
      skipBlank();
      if (text[i++] !== "=") fail("expected =");
      skipBlank();
      assign(table, path, value());
    }
    skipBlank();
    skipComment();
    if (i < text.length && peek() !== "\n" && peek() !== "\r") fail(`unexpected ${JSON.stringify(peek())} after a value`);
  }
  return root;
}
