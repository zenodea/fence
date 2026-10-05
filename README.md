# fence

**Pens for your agents.**

fence is a [herdr](https://herdr.dev) plugin. It turns a herdr space into a **pen**:
every shell in it runs inside a sandbox that can write the pen's folder, reach the
domains you allow, and nothing else. Run Claude Code, Codex or anything else in there
with the permissions turned down, and the fence holds even when the agent goes
somewhere you didn't expect.

It doesn't claim to make an agent safe. It's defence in depth: one more fence between a
confused (or prompt-injected) agent and your SSH keys, your other projects, and the open
internet.

[Website](https://dea.dev/fence/) · [GitHub](https://github.com/zenodea/fence)

## What a pen fences off

| | inside a pen |
|---|---|
| **Files** | The pen's folder, `/tmp` and the agents' own state (`~/.claude`, `~/.codex`, caches) are writable. Everything else is read-only. |
| **Secrets** | `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.npmrc`, shell history, browser profiles and more can't be read at all. Tokens (`*_TOKEN`, `*_SECRET`, `AWS_*`, `SSH_AUTH_SOCK`, …) are dropped from the environment; the agents' own API keys are kept. |
| **Later, outside** | Things that run code *outside* the pen later stay read-only even inside the pen's folder: `.git/hooks`, `.git/config`, `.claude/settings.json`, `.envrc`, `.vscode`, your agents' global settings and hooks. |
| **Network** | Every connection goes through fence's proxy, which only lets through the domains on the pen's list. Going around the proxy is blocked by the kernel. This machine (`localhost`, so Shepherd, graphdiff and your dev servers) and cloud metadata addresses are never reachable. |
| **herdr** | A pen can't talk to herdr's socket, so it can't open an unfenced pane, type into another pane or read one. Agents can still report their status for their own pane, so herdr's sidebar keeps working. |
| **Other apps** (macOS) | No Apple Events (no `osascript` telling Terminal to run something), no `open`, no clipboard, and no signals to processes outside the pen (it can't kill herdr or your editor). |

When something is stopped at the fence you get a herdr toast ("🐑 blocked pastebin.com").
Press `prefix+p` to see the pen and let that domain through if it should be. It works at
once, without restarting anything.

## How it works

| | macOS | Linux |
|---|---|---|
| Sandbox | Seatbelt (`sandbox-exec`), the kernel sandbox Chrome and Codex use | [bubblewrap](https://github.com/containers/bubblewrap): mount, PID and network namespaces, unprivileged |
| Files | A generated profile: deny writes outside the allowed folders, deny reads of hidden ones | The root bound read-only, writable folders bound back in, secrets covered with empty mounts, a private `/tmp` and `/run` |
| Network | The profile only allows a connection to the proxy's localhost port | No network namespace at all; a small bridge inside forwards one localhost port to the proxy's unix socket |
| Hearing about denials | The kernel logs each denial with the pen's tag; fence follows the log | The proxy and the herdr gate (file denials just fail with `EROFS`/`ENOENT`) |

herdr can't start a pane with a command, so fence waits for each new pane's shell to reach
its prompt and has it `exec fence shell`. That process starts the pen's proxy and herdr
gate, then runs your login shell inside the sandbox and stays next to it. If a pane is
already running something, fence never types into it. It's shown as **not fenced** in
the pen window instead. If the sandbox can't start, the pane says so and stays empty: it
doesn't fall back to an unfenced shell.

## Install

```sh
herdr plugin install zenodea/fence
```

Then bind the pen window in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "fence.open"
description = "fence: this space's pen"
```

Needs herdr 0.9+ and Node 22.18+. On Linux, install `bubblewrap` (`apt install
bubblewrap`, `dnf install bubblewrap`, `pacman -S bubblewrap`). Ubuntu 24.04+ limits
unprivileged user namespaces with AppArmor; if `fence shell` says bwrap can't make
namespaces, allow it with an AppArmor profile for `bwrap` or
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`.

To use `fence` in a terminal too, link `bin/fence` from the plugin's folder (`herdr plugin
list --plugin fence` shows its `plugin_root`) onto your `PATH`, e.g.
`ln -s <plugin_root>/bin/fence ~/.local/bin/fence`.

## The pen window

`prefix+p` opens it over the space you're in.

- **Pen** (`o`): the pen's folder and profile, and every pane in it: fenced, or what's running outside the fence. In a space that isn't a pen: `n` makes a new pen (a new space for the focused pane's folder), `f` fences this space, `p` picks the profile.
- **Gates** (`g`): what was stopped lately, with `a` to let it through; the domains you've let through, with `x` to fence them off again; `+` to type one in. The profile's own domains are listed underneath.
- **Log** (`l`): everything that happened at the fence.
- **All pens** (`s`): every pen; `enter` goes there.

## Profiles

A pen uses a profile. Three are built in:

| profile | files | network |
|---|---|---|
| `strict` | the pen's folder, `/tmp`, the agents' state | the agents' model APIs only |
| `standard` (default) | strict, plus package manager caches | strict, plus package registries (npm, PyPI, crates.io, Go, RubyGems, Maven) and GitHub |
| `open` | as standard | any domain, still through the proxy, so it's all in the log |

Write your own in `~/.config/herdr/plugins/config/fence/profiles/NAME.toml` (that folder
is hidden from every pen). One with the same name as a built-in one replaces it.

```toml
description = "standard, plus our internal registry"
extends = "standard"

[files]
write = ["~/.cache/our-tool"]
hide = ["~/work/other-client"]

[net]
allow = ["npm.internal.example.com", "*.internal.example.com:8443"]
localhost = [5432]          # macOS: ports on this machine the pen may reach

[env]
drop = ["OUR_*"]
[env.set]
NODE_ENV = "development"

[system]
clipboard = true            # macOS
```

Lists add up through `extends`. Paths take `~`, `{pen}` (the pen's folder) and `{tmp}`, and
a `*` in the last part (`{pen}/.claude/settings*.json`). Domains: `example.com` (ports 80
and 443), `*.example.com` (any subdomain), `example.com:8443`, or `*`.

**Tripwires** watch files a pen has to be able to write but where a change runs code
outside the pen later. The default watches the `mcpServers` and `hooks` in
`~/.claude.json`: Claude Code needs to write that file, so fence can't stop an agent adding
an MCP server there, but it tells you the moment it happens.

## Commands

```
fence new [--profile P] [--dir D] [--name N]   a new pen, as a new herdr space
fence pen [--profile P]                        make the focused space a pen
fence unpen                                    stop fencing it (fenced shells stay fenced until they exit)
fence run [--profile P] [--dir D] -- CMD...    one command, fenced, anywhere
fence allow DOMAIN [--pen ID]                  let a domain through (disallow to undo)
fence status                                   every pen and whether each pane is fenced
fence log [--pen ID]                           what happened at a pen's fence
fence profiles                                 the profiles there are
fence policy [--profile P] [--sandbox]         what a profile allows, or the exact sandbox profile / bwrap call
```

From inside a pen none of these can change anything: fence's config is hidden there. Only
you can open a gate.

## What it doesn't stop

Worth knowing, so the fence isn't trusted for more than it is:

- **Allowed domains can carry data out.** The proxy sees the domain, not what's inside the TLS. With GitHub allowed, an agent can push to a repo or make a gist; with only the model APIs allowed, the agent's own conversation is still a channel. `strict` keeps that list as short as it gets.
- **What's in the pen's folder is the agent's.** A `.env` in the project can be read.
- **The keychain stays reachable** (macOS). Claude Code keeps its login there, so a pen can ask for keychain items; macOS still asks you before handing over anything whose access list doesn't include the asking program. fence does stop `git` asking the keychain for your GitHub credentials.
- **Agent config that has to be writable.** `~/.claude.json` holds MCP servers that run outside the pen later, and Claude Code must be able to write it. The tripwire tells you when they change; it can't prevent it.
- **Seatbelt is deprecated by Apple** (still used by Chrome, Codex and Claude Code, and still enforced by the kernel). If it goes away, fence will need another macOS backend.
- **Linux, older kernels:** a pen shares the terminal with nothing else (its shell `exec`s), but TIOCSTI keystroke injection into that same terminal is only off by default from Linux 6.2.
- **No shell history in pens.** Your history file is hidden (it's full of secrets), so `zsh` can't read or write it there, and a `.zcompdump` your `.zshrc` regenerates can't be written either (zsh runs it outside the pen later). Your shell may print one line about it.

## Development

```sh
git clone https://github.com/zenodea/fence && cd fence
npm install            # typescript, for the typecheck only; fence has no dependencies
herdr plugin link "$PWD"
npm test && npm run typecheck
```

`node src/cli.ts policy --sandbox` prints the exact Seatbelt profile (or bwrap call) a
pen would get.

## License

[MIT](LICENSE)
