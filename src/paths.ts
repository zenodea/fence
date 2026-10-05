// Where fence keeps things. herdr hands plugin commands their dirs; panes don't
// get those variables, so the same locations are worked out by hand there.
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
const xdgState = process.env.XDG_STATE_HOME || join(home, ".local", "state");

/** The fence checkout (or herdr's install of it). */
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cliPath = join(pluginRoot, "src", "cli.ts");
/** What a pane runs to become fenced. */
export const fenceBin = join(pluginRoot, "bin", "fence");

export const herdrHome = join(xdgConfig, "herdr");
export const herdrState = join(xdgState, "herdr");
export const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

/** Profiles you write, and the list of pens. Hidden from every pen. */
export const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || join(herdrHome, "plugins", "config", "fence");
/** Logs. Hidden from every pen. */
export const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || join(herdrState, "plugins", "fence");
export const pensFile = join(configDir, "pens.json");
export const userProfilesDir = join(configDir, "profiles");
export const builtinProfilesDir = join(pluginRoot, "profiles");
export const logDir = join(stateDir, "log");

/**
 * Sockets the fenced side talks to (the proxy and the herdr gate). Kept short:
 * macOS caps a socket path at 104 bytes.
 */
// (/private/tmp rather than /tmp: the sandbox matches the real path.)
export const runDir = join(process.platform === "darwin" ? "/private/tmp" : process.env.XDG_RUNTIME_DIR || tmpdir(), `fence-${process.getuid?.() ?? 0}`);

export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (env.HERDR_SESSION) return join(herdrHome, "sessions", env.HERDR_SESSION, "herdr.sock");
  return join(herdrHome, "herdr.sock");
}

export function ensureDir(dir: string, mode = 0o700): string {
  mkdirSync(dir, { recursive: true, mode });
  return dir;
}
