# alfa

A local-first coding agent for your terminal. Bring your API endpoint and model, read the conversation, inspect changes, and keep typing.

[中文](README.zh.md) · [日本語](README.ja.md)

```text
› Fix the config parser
  · read src/config.ts
  edit src/config.ts +2 -1
  - oldValue
  + newValue
  Tests passed. The parser now preserves empty values.
›
```

## Install

Install the latest release with one command. No Bun runtime is required.

**macOS / Linux:**

```sh
curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
```

The installer selects the platform binary and verifies its SHA-256 checksum. It installs to `~/.local/bin` on macOS/Linux or `%LOCALAPPDATA%\Programs\alfa` on Windows. If that directory is missing from `PATH`, follow the command printed by the installer; it does not change your shell configuration or environment variables automatically. Then run `alfa` to set up your model.

You can also download a binary and its checksum from [Releases](https://github.com/alfa-plus-laboratory/alfa/releases/latest).

**Update:**

```sh
alfa upgrade
```

**Uninstall:** first preview what will be removed:

```sh
alfa uninstall
```

Then uninstall with one command:

```sh
alfa uninstall confirm
```

This removes the installed binary, global configuration, saved credentials, session data, and the current directory's `.alfa/` if present. Other projects' `.alfa/` directories and `PATH` entries are left alone. On Windows, follow any printed cleanup command to remove the renamed executable after exit.

Shell isolation uses macOS Seatbelt or Linux bubblewrap (`bwrap`, installed through your OS package manager). On platforms without a supported backend, shell execution fails closed; file tools remain available. Windows users can use WSL with bubblewrap.

## Start and configure

```sh
alfa
alfa -m my-gateway/model-id -p "Explain this repository"
alfa --continue
alfa --resume
printf 'Explain the failing test\n' | alfa
```

First launch guides you through a provider template or custom API, protocol, base URL, hidden credential, model discovery or manual model ID, and an actual connection test. Choose **switch** for this session or **default** for future sessions. Failed tests and cancellation do not save a partial configuration.

Use `/settings` → **Providers & credentials** to add, edit, enable, disable or delete providers and model records, or test a connection. `/model` opens a searchable model picker. Settings show current values; use arrows and Enter to select, type to search, and Esc to go back. `/model provider/model` remains available and remembers the default unless `ALFA_MODEL` overrides it. Discovery is optional: an unsupported `/models`, a network error, or an incomplete list never means “no models”. No-key authentication is available for loopback endpoints.

Named providers share three protocol adapters: `anthropic`, `openai-responses` (OpenAI-compatible Responses API), and `openai-chat` (OpenAI-compatible Chat Completions). New custom endpoints default to Responses; select Chat Completions explicitly for older gateways without `/responses`. Templates supply defaults, not separate integrations. Custom authentication headers and disabled discovery are supported.

`config.json` stores ordinary configuration; `auth.json` stores credentials separately with mode 0600. Environment variables override saved values: `ALFA_MODEL`, `ALFA_KEY_<NAME>`, `ALFA_BASE_URL_<NAME>`, and the existing `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` and `OPENAI_API_KEY` / `OPENAI_BASE_URL`. Settings show the effective key and endpoint sources. Keys are hidden or masked; there is no show-key command. `alfa auth login/list/logout` remains supported.

## Conversation and tools

The terminal's native scrollback is the permanent transcript. Answers, errors, approvals and edit/write diffs stay visible; the input area shows only current activity. `/detail` retrieves the most recent full tool record; `/detail read` or `/detail <callID>` selects records. `/jobs` and `/agents` show background work. Native selection and copying work without mouse capture.

While it works, the line above the input shows what it's doing (thinking, writing, which tool), a turn clock and the tail of its thinking; pinned rows show the plan's progress, subagents (running or suspended — a suspended one keeps its memory and can be woken; `kill` removes one for good) and background processes. The footer shows how full the context is, the actual prompt-cache hit rate and the output speed.

- Enter sends; while running it supplements or queues input. Ctrl-J / Alt-Enter inserts a newline.
- Esc interrupts. Ctrl-C clears or interrupts; twice on empty input exits. Ctrl-D exits.
- Shift-Tab cycles permission modes; Ctrl-L redraws the terminal. Type `@` to complete workspace paths; `/help` lists commands.
- Attach images with `@shot.png`, by dragging a file into the terminal, or with Ctrl-V for a clipboard screenshot. Cmd-V pastes text only, so a copied image needs Ctrl-V; a pasted `data:image/…` URL (what "Copy image address" gives on Google Images) is attached too.
- `/settings` also covers themes (terminal / dark / light), compact or expanded tool output, permissions, path grants, project trust, language, checks, subagent concurrency, thinking, reasoning effort and compaction. Changes return to the settings list.
- `/context`, `/compact`, `/check`, `/trust`, `/language`, `/think`, `/effort`, `/agentflow`, `/resume`, `/clear`, `/skills`, `/mcp`, `/init`, `/history-clean` and `/reset` remain available.

`--plain` and `--no-mouse` are compatibility aliases. `/view` explains the migration. The old full-screen panes, mascot, mouse interface and layout settings are retired. Existing `view` / `panels` keys are ignored and removed on the next configuration save. `-p` and piped input do not acquire the interactive terminal.

## Permissions

alfa works on its own by default (`auto`). Reads and edits in the workspace just happen; anything else goes past a classifier that weighs how clearly you asked for it against what it could cost. Something risky you didn't ask for goes back to alfa to find another way, or to ask you. Reaching outside the workspace asks you first; `/access` manages what you've granted.

If you'd rather approve things yourself, Shift-Tab switches to `default` (workspace reads and edits go through, the rest asks you) or `confirm` (everything asks you).

This is judgment, not isolation: what alfa runs has your account's access. An experimental OS sandbox for shell commands can be turned on in `/settings`.

## Extend and evaluate

Skills and MCP remain supported. The versioned external API supports tools, before/after tool events, `/x:name` commands, and plain-text notifications. Configure reviewed extensions by absolute path and SHA-256 in global config; they have **host privileges**. See [extension API](docs/extensions.md) and [example](examples/extension.ts).

Three reproducible coding tasks cover CSV parsing, a multi-package API migration and retry cancellation. [Evaluation instructions](eval/README.md) explain independent acceptance tests, elapsed time, usage, pricing, approvals and interruption/resume runs. Fixture validation is not a model success score. No comparison with other agents is claimed.

Use `--report /absolute/report.json` to save invocation usage, request roles and available cache diagnostics. OpenAI Responses models can opt into the experimental `openai-codex` prompt profile and native patch tool through their model configuration; see the built-in `alfa-config` skill.

## Build

Bun ≥ 1.3 is required for source development:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Model requests go directly to your configured provider. Web and MCP tools can make additional network requests. Sessions are stored locally in SQLite; tool output and debug logs can contain project content. There is no alfa account or telemetry service.

Design history and boundaries: [DESIGN.md](DESIGN.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md); security reports: [SECURITY.md](SECURITY.md); changes: [CHANGELOG.md](CHANGELOG.md). License: [Apache-2.0](LICENSE); third-party notices: [NOTICE](NOTICE).

Setup uses a five-step wizard: provider → connection → credentials → model → review and test. Use arrow keys and Enter, or type to filter choices. Templates hide advanced settings until needed; failed tests keep the draft editable. Type `/` in chat for command completion or `@` for workspace paths. Concurrent requests recheck earlier approvals before asking; approval keys cannot spill into chat.
