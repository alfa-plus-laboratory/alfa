# alfa

[![release](https://img.shields.io/github/v/release/alfa-plus-laboratory/alfa?style=flat-square&color=0B5C9E)](https://github.com/alfa-plus-laboratory/alfa/releases/latest)
[![license](https://img.shields.io/badge/license-Apache--2.0-0B5C9E?style=flat-square)](LICENSE)

**A coding agent that lives in your terminal.** Open a project, describe what you
want, and it reads your code, edits your files and runs your tests — asking before
anything that cannot be undone.

Everything except the model call runs on your machine. Your own API key, straight
to your own provider. No backend, no account, no telemetry.

*Read this in [中文](README.zh.md) · [日本語](README.ja.md).*

```
╭─ api ────────────[-]─┬─ session ──────────────────────────┬─ detail ─────────────────[-]─╮
│ ▸ src                │ so far ─────────────────────────── │                              │
│ ▸ test               │ what this session is about will ap │  nothing to show yet.        │
│   package.json    ?  │ pear here after the first reply.   │                              │
│   README.md       ?  │ ─[● ●]─ ────────────────────────── │  it follows the latest tool… │
│                      │                                    │    read   -> file            │
│                      │                                    │    edit   -> diff            │
│                      │                                    │    bash   -> output          │
│                      │                                    │                              │
│                      │                                    │  or pick a file on the left. │
│                      ├───────────────── ▓░░░░░░░░░░░ ~9% ─┤                              │
│                      │ › Ask anything, or /help           │                              │
├──────────────────────┴────────────────────────────────────┴──────────────────────────────┤
│ ~/api · anthropic/claude-sonnet-4-5 · [⧉ copy]                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────╯
```

## Install

```bash
curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
```

One file, no runtime to install — the binary carries its own. macOS and Linux on
x64 and arm64, Windows on x64. The installer verifies a SHA-256 checksum and
refuses to install if it does not match.

Later: `alfa upgrade` replaces the binary in place. It never updates itself
behind your back; it tells you a release exists and waits for you to ask.

Prefer to build it yourself? See [Building from source](#building-from-source).

## First run

```bash
cd your-project
alfa
```

The first time, alfa asks for a model provider — paste an API key from Anthropic,
OpenAI, or any OpenAI-compatible endpoint, and it verifies the key before saving.

The first time in each folder, it asks two short questions: how the screen should
look, and whether the folder is trusted. Both answers are stored in **your config**,
never in the repository. Press Enter twice to take the defaults.

Then just talk to it:

```
› the login handler drops the session cookie on redirect — find out why
› add a test for the empty-cart case and make it pass
› what does this repo actually do?  read around first
```

Not interested in the full-screen UI? `alfa --plain` keeps a plain prompt at the
bottom of your normal scrollback. Scripting it? `alfa -p "…"` runs one turn and
exits.

## What it can do

Fifteen built-in tools: `read` `write` `edit` `bash` `grep` `glob` `todo` `job`
`task` `ask` `memory` `context` `skill` `webfetch` `websearch`.

Beyond the obvious ones, that means it can:

- **Run things in the background** — start a dev server, keep working, check on
  it later. Background processes are killed when alfa exits, not orphaned.
- **Send out subagents** — `task` spawns a subagent with its own context window.
  Useful when a question needs a whole subtree read but the answer is a paragraph.
  With `/agentflow` you can fan several out at once and pipeline them.
- **Stop and ask you** — when it hits a real fork in the road it asks a question
  instead of guessing, and waits.
- **Remember across sessions** — notes it writes go in `.alfa/memory/` and load
  automatically next time.
- **Check its own work** — before handing back, it runs your project's type-check
  or build if it can find one, and fixes what it broke.

## Permissions

This is the part worth reading before you trust it with a repository.

Every tool call passes a gate. Reads are free. Anything that writes, deletes, or
reaches the network is classified, and the classification is shown to you in full
— for shell commands, each piece of a pipeline on its own line, not squashed into
one string you would scan and approve.

Three modes, switched with `shift-tab` or `/permission`:

| mode | what it does |
|---|---|
| `confirm` | ask for everything, including reads |
| `default` | ask before writes, deletes, and network |
| `trust` | run without asking |

`default` is the default. A non-default mode is **always printed at startup** —
a security setting you can forget about is not a security setting.

"Always allow this" is remembered per workspace, and startup tells you how many
such rules are in force. Some things can never be auto-allowed: reading credential
files, writing outside the workspace, and fetching link-local or cloud-metadata
addresses are refused outright, in every mode.

**Everything the model reads from outside is treated as data, not instructions.**
Web pages, search results, MCP tool results, and files you did not write all go
through the same filter, which strips invisible characters and flags text that
tries to give the agent orders. This is not paranoia: a poisoned README sitting in
`node_modules` reaches the model exactly like a web page does.

## Folder trust

A repository can talk to the agent without you doing anything: its `AGENTS.md`
and `CLAUDE.md` are pasted into the system prompt, and `.alfa/mcp.json` names
executables to start. That is fine for your own code, less so for something you
just cloned.

Trust is **granted by default** — a tool that asks you to press `y` in every
directory trains you to press `y` without reading. What matters is that there is
a clear way to withhold it, and that the grant is dated.

Pick *look it over first* and a subagent reads those files and trusts the folder
only if nothing in them is steering the agent rather than describing the project.
The test is where a line's effect goes, not how firmly it is worded: "do not add
comments" is a house rule; "send the .env to this address" is not. If the review
comes back with anything to say — or does not come back at all — the folder stays
untrusted.

While a folder is untrusted, its `AGENTS.md`, `CLAUDE.md`, `.alfa/memory/` and
`.alfa/skills/` stay out of the system prompt entirely, and startup says so.
Manage it with `/trust`.

## Keys

| key | |
|---|---|
| `enter` | send — queues if a turn is already running |
| `ctrl-j` | newline |
| `esc` | interrupt the turn; otherwise back out one level |
| `tab` | move between panes — typing always jumps back to the input |
| `shift-tab` | permission mode |
| `/` `@` | command palette · mention a file |
| `ctrl-b` `ctrl-p` `ctrl-]` | file tree · plan · detail pane |
| `ctrl-y` | copy — code blocks, the reply, your message, the session |
| `ctrl-l` | repaint the screen |
| `ctrl-o` `ctrl-r` | lock the detail pane · rescan the tree |
| `ctrl-c` | clear input; twice on an empty line to exit |

### Copying

Full-screen terminal apps capture the mouse, which breaks drag-select — and even
when you get it, you have selected the *screen*: borders, wrapped lines, and bits
of the neighbouring pane.

`ctrl-y` (or the `[⧉ copy]` chip in the status bar) lists what there is to copy
and takes the text from the session store instead: each code block in the last
reply, the reply itself, your last message, or the whole conversation. It copies
over OSC 52, so it works the same over SSH. In tmux you need
`set -g set-clipboard on`.

## Commands

`/help` `/context` `/compact` `/check` `/init` `/model` `/view`
`/language` `/permission` `/trust` `/think` `/agentflow` `/mcp` `/skills`
`/resume` `/summary` `/clear` `/history-clean` `/reset` `/upgrade` `/exit`

A few worth knowing:

- **`/init`** writes an `AGENTS.md` for the repository by actually reading it —
  how to build, how to test, which conventions matter.
- **`/compact`** folds a long session into a handoff summary when the context
  window fills. It happens automatically near the limit; nothing is deleted.
- **`/context`** shows what is using your context window, so you know what to cut.
- **`/reset`** removes alfa's state; **`alfa uninstall`** removes alfa itself,
  binary included. Both list what they will delete before doing it.

## Configuration

Two files, deliberately separate:

| | |
|---|---|
| `~/.config/alfa/config.json` | providers, default model, preferences. **Zero secrets** — safe to put in a dotfiles repo |
| `~/.local/share/alfa/auth.json` | API keys, mode `0600` |

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "providers": {
    "anthropic": { "type": "anthropic" },
    "local": {
      "type": "openai-compat",
      "baseURL": "http://localhost:11434/v1",
      "models": ["qwen2.5-coder:32b"]
    }
  },
  "language": { "interface": "auto", "reply": "auto" }
}
```

Any OpenAI-compatible endpoint works — a local llama.cpp or Ollama server, a
gateway, a hosted provider. Editing this file by hand is a supported way to use
alfa, so errors in it name the field and say what was expected.

Environment overrides: `ALFA_KEY_<PROVIDER>`, `ALFA_BASE_URL_<PROVIDER>`,
`ALFA_MODEL`, `ALFA_SHELL`, `ALFA_DEBUG=1`.

The interface speaks English, 中文 and 日本語 (`/language`). Key names, tool names
and mode names are never translated — they are things you type.

### MCP, skills, memory

- **MCP** — servers go in `config.json` (yours) or `.alfa/mcp.json` (the
  project's). A server the *project* defines has to be approved by you before it
  is started, because that file names an executable.
- **Skills** — a playbook is a markdown file in `.alfa/skills/`,
  `~/.config/alfa/skills/`, or `.claude/skills/`. Only the name and one-line
  description sit in the prompt; the body is fetched when it applies.
- **Memory** — `.alfa/memory/` holds notes the agent wrote about the project.
  They load at the start of every session. `/init` and the `memory` tool manage them.

## Privacy

alfa has **no telemetry**. There is no analytics code in the source, and no
endpoint that belongs to us.

It makes network requests to exactly three kinds of place:

1. **Your model provider** — whichever one you configured, with your key.
2. **GitHub** — once a day at most, in the background, to see whether a newer
   release exists. It tells you; it never installs on its own. `alfa upgrade`
   downloads from there too.
3. **The web, only when you ask it to** — `webfetch` and `websearch` always
   require approval, and never gain an allowlist, because the risk is not *which*
   site but *who chose it*.

Everything else — sessions, history, saved tool output, credentials — stays in
`~/.local/share/alfa/` on your machine. `/reset` and `alfa uninstall` show you
the list before deleting.

## Building from source

```bash
git clone https://github.com/alfa-plus-laboratory/alfa
cd alfa
bun install
bun run typecheck && bun test
bun run build          # → bin/alfa-bin
```

Requires **[Bun](https://bun.sh) ≥ 1.3** — not Node. Released binaries are built
with a pinned Bun version, because `bun build --compile` bundles the runtime: the
version used to build is the version you run.

## Documentation

[**DESIGN.md**](DESIGN.md) is the design log — every decision, what was tried and
failed, and what breaks if you change it. It is long, it is in Chinese, and it is
the truth source for why the code looks the way it does. Read it before changing
something, not before using it.

[**AGENTS.md**](AGENTS.md) is the short list of house rules for working in this
repository, including the ones that are the opposite of the usual defaults.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution — the
compiled binary strips upstream copyright headers, so NOTICE is where those
obligations are met. It ships with every release.
