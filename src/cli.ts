// fence: pens for herdr. A pen is a herdr space whose shells run inside a
// sandbox: they can write the pen's folder, reach the domains on its list, and
// nothing else.
//
//   fence shell [--pen ID]              this pane's shell, fenced (what a pen's panes run)
//   fence run [--profile P] -- CMD...   one command, fenced
//   fence new [--profile P] [--dir D]   a new pen, as a new herdr space
//   fence pen [--profile P]             make the focused space a pen
//   fence unpen                         stop fencing the focused space
//   fence allow DOMAIN [--pen ID]       let a domain through for a pen
//   fence hide PATH [--pen ID]          hide a file or pattern from a pen (show to undo)
//   fence status | log | profiles | policy
//
// herdr runs the rest: open (the window), ui, event, startup.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { readLog, record } from "./events.ts";
import { createPen, fenceAll, onEvent, penPanes, penThisWorkspace, prunePens, reconcile, unpen } from "./herd.ts";
import { notify } from "./herdr/client.ts";
import { cleanRule } from "./net/match.ts";
import { herdrBin } from "./paths.ts";
import { penById, penForWorkspace, readPens, updatePen } from "./pens.ts";
import { describePolicy, makePolicy } from "./policy.ts";
import { DEFAULT_PROFILE, listProfiles, loadProfile } from "./profile.ts";
import { bwrapArgs } from "./sandbox/linux.ts";
import { seatbeltProfile } from "./sandbox/macos.ts";
import { runFenced } from "./shell.ts";
import { style } from "./ui/ansi.ts";

type Args = { positional: string[]; flags: Map<string, string | true>; rest: string[] };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags.set(k, v);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags.set(k, argv[++i]!);
      else flags.set(k, true);
    } else positional.push(a);
  }
  return { positional, flags, rest };
}

const str = (args: Args, name: string): string | undefined => {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

/** What herdr tells a plugin action about where you are. */
export function herdrContext(env: NodeJS.ProcessEnv = process.env): { workspaceId: string | null; paneId: string | null; cwd: string } {
  let ctx: Record<string, unknown> = {};
  try {
    ctx = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {}
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const paneId = s(ctx.focused_pane_id) ?? s(env.HERDR_ACTIVE_PANE_ID) ?? s(env.FENCE_PANE) ?? s(env.HERDR_PANE_ID);
  const workspaceId =
    s(ctx.workspace_id) ?? s(ctx.focused_workspace_id) ?? s(ctx.active_workspace_id) ?? s(env.HERDR_ACTIVE_WORKSPACE_ID) ?? s(env.FENCE_WORKSPACE) ?? (paneId?.includes(":") ? paneId.split(":")[0]! : null) ?? s(env.HERDR_WORKSPACE_ID);
  const cwd = s(ctx.focused_pane_cwd) ?? s(env.HERDR_ACTIVE_PANE_CWD) ?? s(ctx.workspace_cwd) ?? process.cwd();
  return { workspaceId, paneId, cwd };
}

function problemsText(problems: { pane: { pane_id: string }; state: { state: string; command?: string } }[]): string {
  return problems.map((p) => `${p.pane.pane_id} is running ${p.state.state === "busy" ? p.state.command : p.state.state}`).join(", ");
}

/** A command's failure, shown where it happened and, for herdr actions, as a toast. */
async function fail(message: string, toast: boolean): Promise<never> {
  process.stderr.write(`${style.red("fence:")} ${message}\n`);
  if (toast) await notify("🐑 fence", message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command = "help", ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  const fromHerdr = Boolean(process.env.HERDR_PLUGIN_ID);

  switch (command) {
    case "shell": {
      // Already inside a pen (the line was run twice, or by hand): the fence is
      // inherited, so just be the shell rather than end the pane.
      if (process.env.FENCE_ACTIVE) {
        const argv = args.rest.length ? args.rest : [process.env.SHELL || "/bin/sh", "-l"];
        process.exit(spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" }).status ?? 0);
      }
      const pen = str(args, "pen") ? penById(str(args, "pen")!) : penForWorkspace(process.env.HERDR_WORKSPACE_ID);
      try {
        if (!pen && !str(args, "profile")) throw new Error("this space isn't a pen (pass --profile to fence a shell anyway)");
        const code = await runFenced({
          pen,
          profile: pen?.profile ?? str(args, "profile")!,
          dir: pen?.dir ?? str(args, "dir") ?? process.cwd(),
          argv: args.rest,
          pane: process.env.HERDR_PANE_ID ?? null,
        });
        process.exit(code);
      } catch (err) {
        // Fail closed: say why and keep the pane open, rather than drop to an unfenced shell.
        process.stderr.write(`\n${style.red("🐑 fence couldn't fence this pane:")} ${(err as Error).message}\n`);
        process.stderr.write(style.dim("Nothing is running here. Press enter to close the pane.\n"));
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          await new Promise((r) => process.stdin.once("data", r));
        }
        process.exit(1);
      }
    }

    case "run": {
      if (!args.rest.length) await fail("usage: fence run [--profile P] [--dir D] -- command...", false);
      const pen = penForWorkspace(process.env.HERDR_WORKSPACE_ID);
      const code = await runFenced({
        pen,
        profile: str(args, "profile") ?? pen?.profile ?? DEFAULT_PROFILE,
        dir: str(args, "dir") ?? pen?.dir ?? process.cwd(),
        argv: args.rest,
        pane: process.env.HERDR_PANE_ID ?? null,
        quiet: args.flags.has("quiet"),
      }).catch((err) => fail((err as Error).message, false));
      process.exit(code);
    }

    case "new": {
      const ctx = herdrContext();
      const dir = str(args, "dir") ?? ctx.cwd;
      try {
        const { pen, problems } = await createPen({ name: str(args, "name") ?? basename(dir), dir, profile: str(args, "profile"), focus: !args.flags.has("no-focus") });
        const msg = problems.length ? `${pen.name} is a pen, but ${problemsText(problems)}` : `${pen.name} is a pen (${pen.profile})`;
        console.log(msg);
        if (fromHerdr && problems.length) await notify("🐑 fence", msg);
      } catch (err) {
        await fail((err as Error).message, fromHerdr);
      }
      return;
    }

    case "pen": {
      const ctx = herdrContext();
      if (!ctx.workspaceId) return fail("can't tell which space you're in", fromHerdr);
      const existing = penForWorkspace(ctx.workspaceId);
      if (existing) {
        const problems = await fenceAll(existing);
        console.log(problems.length ? `already a pen; ${problemsText(problems)}` : `${existing.name} is already a pen; every pane is fenced`);
        return;
      }
      try {
        const { pen, problems } = await penThisWorkspace({ workspaceId: ctx.workspaceId, dir: str(args, "dir") ?? ctx.cwd, profile: str(args, "profile") });
        const msg = problems.length
          ? `${pen.name} is a pen. Not fenced yet: ${problemsText(problems)}. Close those or quit what's running, and they'll be fenced next time.`
          : `${pen.name} is a pen (${pen.profile})`;
        console.log(msg);
        if (fromHerdr) await notify("🐑 fence", msg);
      } catch (err) {
        await fail((err as Error).message, fromHerdr);
      }
      return;
    }

    case "unpen": {
      const ctx = herdrContext();
      const pen = penForWorkspace(ctx.workspaceId);
      if (!pen) return fail("this space isn't a pen", fromHerdr);
      await unpen(pen);
      console.log(`${pen.name} isn't a pen any more. Shells already fenced stay fenced until they exit.`);
      return;
    }

    case "allow":
    case "disallow": {
      const rule = cleanRule(args.positional[0] ?? "");
      if (!rule) return fail(`usage: fence ${command} DOMAIN [--pen ID]`, false);
      const pen = str(args, "pen") ? penById(str(args, "pen")!) : penForWorkspace(herdrContext().workspaceId);
      if (!pen) return fail("which pen? pass --pen ID (see fence status)", false);
      updatePen(pen.id, (p) => ({ ...p, allow: command === "allow" ? [...new Set([...p.allow, rule])] : p.allow.filter((r) => r !== rule) }));
      record({ pen: pen.id, pane: null, kind: "info", verdict: "info", target: `${command === "allow" ? "let through" : "fenced off"} ${rule}` });
      console.log(`${pen.name}: ${rule} ${command === "allow" ? "let through" : "fenced off again"}`);
      return;
    }

    case "hide":
    case "show": {
      const path = args.positional[0]?.trim();
      if (!path || path.includes('"')) return fail(`usage: fence ${command} PATH [--pen ID]   (a path inside the pen, ~/…, or a pattern like **/*.sqlite)`, false);
      const pen = str(args, "pen") ? penById(str(args, "pen")!) : penForWorkspace(herdrContext().workspaceId);
      if (!pen) return fail("which pen? pass --pen ID (see fence status)", false);
      const without = (list: string[] | undefined) => (list ?? []).filter((x) => x !== path);
      // show takes back a hide of yours, or makes an exception to the profile's.
      const wasMine = (pen.hide ?? []).includes(path);
      updatePen(pen.id, (p) => (command === "hide" ? { ...p, hide: [...without(p.hide), path], show: without(p.show) } : wasMine ? { ...p, hide: without(p.hide) } : { ...p, show: [...without(p.show), path] }));
      record({ pen: pen.id, pane: null, kind: "info", verdict: "info", target: `${command === "hide" ? "hid" : "showed"} ${path}` });
      console.log(`${pen.name}: ${path} is ${command === "hide" ? "hidden" : "shown"}. New panes get it; fenced shells keep their rules until they exit.`);
      return;
    }

    case "status": {
      await prunePens().catch(() => []);
      const pens = readPens();
      if (!pens.length) console.log("No pens yet. `fence new` makes one.");
      for (const pen of pens) {
        console.log(`${style.bold(pen.name)} ${style.dim(`${pen.id} · space ${pen.workspaceId} · ${pen.profile} · ${pen.dir}`)}`);
        for (const r of await penPanes(pen)) {
          const s = r.state.state === "fenced" ? (r.stale ? style.yellow(`fenced, old rules (${r.state.rules?.profile ?? "?"})`) : style.green("fenced")) : r.state.state === "busy" ? style.red(`not fenced: ${r.state.command}`) : style.yellow(r.state.state);
          console.log(`  ${r.pane.pane_id}  ${s}`);
        }
      }
      return;
    }

    case "log": {
      const pen = str(args, "pen") ? penById(str(args, "pen")!) : penForWorkspace(herdrContext().workspaceId);
      for (const e of readLog(pen?.id ?? null, Number(str(args, "lines") ?? 50))) {
        console.log(`${e.t.slice(11, 19)}  ${e.verdict.padEnd(7)}  ${e.kind.padEnd(8)}  ${e.target}${e.detail ? style.dim(`  ${e.detail}`) : ""}`);
      }
      return;
    }

    case "profiles": {
      for (const p of listProfiles()) console.log(`${style.bold(p.name.padEnd(10))} ${p.description} ${style.dim(`(${p.source})`)}`);
      return;
    }

    case "policy": {
      const pen = str(args, "pen") ? penById(str(args, "pen")!) : penForWorkspace(process.env.HERDR_WORKSPACE_ID);
      const profile = loadProfile(str(args, "profile") ?? pen?.profile ?? DEFAULT_PROFILE);
      const policy = makePolicy(profile, { dir: str(args, "dir") ?? pen?.dir ?? process.cwd(), pen, pane: process.env.HERDR_PANE_ID });
      if (args.flags.has("sandbox")) {
        if (process.platform === "darwin") console.log(seatbeltProfile(policy, { proxyPort: 0, gateSocket: "<gate>" }));
        else console.log(["bwrap", ...bwrapArgs(policy, { proxySocket: "<proxy>", gateSocket: "<gate>" }, policy.dir)].join(" \\\n  "));
      } else console.log(describePolicy(policy).join("\n"));
      return;
    }

    // herdr: the plugin action behind prefix+p. Opens the window over the focused space.
    case "open": {
      const ctx = herdrContext();
      const screen = str(args, "screen");
      const env = [`FENCE_WORKSPACE=${ctx.workspaceId ?? ""}`, `FENCE_PANE=${ctx.paneId ?? ""}`, `FENCE_CWD=${ctx.cwd}`, ...(screen ? [`FENCE_SCREEN=${screen}`] : [])];
      const r = spawnSync(herdrBin, ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID ?? "fence", "--entrypoint", "window", "--focus", ...env.flatMap((e) => ["--env", e])], {
        stdio: "inherit",
      });
      process.exit(r.status ?? 1);
    }

    case "ui": {
      const { runWindow } = await import("./ui/window.ts");
      await runWindow({ workspaceId: process.env.FENCE_WORKSPACE || null, paneId: process.env.FENCE_PANE || null, cwd: process.env.FENCE_CWD || process.cwd(), screen: process.env.FENCE_SCREEN });
      return;
    }

    // herdr: event hooks (a new pane in a pen gets fenced) and startup.
    case "event": {
      const name = args.positional[0] ?? process.env.HERDR_PLUGIN_EVENT ?? "";
      console.log(await onEvent(name, process.env.HERDR_PLUGIN_EVENT_JSON));
      return;
    }
    case "startup": {
      for (const line of await reconcile().catch((e) => [`herdr isn't answering: ${(e as Error).message}`])) console.log(line);
      return;
    }

    case "help":
    case "--help":
    case "-h": {
      const { readFileSync } = await import("node:fs");
      const head = readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 15);
      console.log(head.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      return;
    }
    default:
      await fail(`unknown command ${command} (fence help)`, false);
  }
}

await main();
