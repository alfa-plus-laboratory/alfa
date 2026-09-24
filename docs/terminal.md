# Terminal interaction

One chronological transcript uses native terminal scrollback. Answers, edits, errors and approval receipts are permanent; only the current action and input are repainted. `/detail` retrieves tool records, `/jobs` and `/agents` retrieve background work. This avoids an application-owned history viewport and preserves terminal selection, SSH and tmux behavior.

Idle:
```text
The parser now preserves empty values.
› tips /resume picks up an earlier session
```

While it works:
```text
  ▰▰▰▰▱▱▱▱▱▱ 2/5 ▸ run the serializer tests
  agents ◌●● 2 running · 1 suspended
  jobs 1 running · bun run dev
  ⢎⡱⣇ thinking · 12s · esc to interrupt
  ┆ …the empty value case goes through a different branch, so the fix
  ┆ belongs in parseValue, not in the caller
› 
~/code/parser
anthropic/claude-opus-5 · ▓▓▓░░░░░ 41% ctx · cache 96% · 48 tok/s
```

The alfa mark on the running line moves while a turn runs: a brightness sweep while
thinking, the α writing itself while writing, a gap running round its loop while a tool
runs, still and yellow while a retry waits. The
phase and turn clock follow it. Thinking shows as a two-row tail that is not kept; a
`∴ thought 8.2s` receipt stays for blocks over a second. Settings → Thinking display
switches to the full thinking in the transcript, or off; Settings → Animation stops the
mark and the clock. Idle draws nothing.

The pinned rows show the plan's progress (one row, not the checklist), every subagent not
yet closed — running, queued, or suspended (finished, and wakeable by the main agent with
its memory) — and background processes still running. `/agents <id> suspend` stops one
and keeps it; `/agents <id> kill` removes it for good, `/agents kill` removes them all. The footer shows the context bar, the actual cache hit rate (`/cache-hit`,
first requests excluded; `—` when unknown) and the latest output speed (`~` while
estimating). At launch the empty input box shows one tip behind a `tips` label; once
the first message is sent the box stays empty.

Consecutive tools:
```text
· read src/config.ts
· grep parseConfig
· bash bun test
Tests passed.
›
```

Diff (including default-allowed edits):
```text
edit src/config.ts +1 -1
- if (!value) return fallback
+ if (value == null) return fallback
›
```

Approval:
```text
  ● write ../neighbor/config.ts
──────────────────────────────────────────────────────────────
  ⚠ Approve · path.write

    /private/work/neighbor/config.ts
    Outside initial workspace. Exact file only; no parent directory access is granted.

  Proceed?
  ❯ 1. allow once (y)
    2. allow for this session (s)
    3. always allow · /private/work/neighbor/config.ts (a)
    4. reject (esc)

  ⏎ select · ↑↓ move · d details · esc reject
```
Once answered, the card goes and a receipt stays under the tool line:
`✓ path.write · allow once · /detail <callID>`.

A question (the `ask` tool):
```text
  ● ask Which database should the new service use? (+1)
──────────────────────────────────────────────────────────────
  1/2 ? Which database should the new service use?

  ❯ 1. Postgres
       already in the stack
    2. SQLite
       zero ops, no concurrent writers
    3. something else…

  ⏎ select · ↑↓ move · 1-2 pick · or just type · esc dismiss
```
Typing anything moves to the last row and answers in your own words; ← goes back to the
previous question with its answer still there. Multiple choice ticks `[✓]` with ⏎ or
space and submits from a Done row. The answers stay under the call:
```text
    ↳ SQLite · typecheck, lint  10.2s
    · Which database should the new service use? → SQLite
    · Which checks should run before commit? → typecheck, lint
```

Slash commands:
```text
▌ /think

  ⎿ thinking on
    shown from the next turn
```
The command is echoed as typed and what it prints hangs under the elbow, so it can't be
mistaken for the model's answer — including a setting flipped mid-turn.

Parallel agents:
```text
· task parser investigation
· task serializer investigation
Subagent serializer:
· edit src/serializer.ts +1 -1
- oldValue
+ newValue
› /agents
parser · running · parser investigation
serializer · exited · serializer investigation
› /agents serializer
```

Narrow terminal:
```text
edit src/config.ts +1 -1
- if (!value) return fallback
+ if (value == null) retur
n fallback
› 次のテストも確認してください
```

These are interaction wireframes, not exact localized output snapshots. Actual wording depends on language and terminal width. Replies and diffs are committed as whole lines and left to the terminal's own wrapping, so a terminal that reflows on resize reflows them too. No alternate screen, mouse capture or permanent columns is used, and nothing animates while idle. `--plain` and `--no-mouse` remain compatibility aliases; `/view` explains the migration.

Resizing automatically clears and rebuilds the current viewport at the new dimensions.
Native scrollback is not cleared; the current streamed tail and input draft are retained.
`Ctrl-L` remains available for manual recovery.

## Settings and appearance

`/settings` opens a searchable list with current values. Use arrows to select,
Enter to open, and Esc to return one level. Changes keep the settings list open.
`/model` opens model candidates directly; provider connections and credentials
are managed from Settings → Providers & credentials.

The list covers model, providers, theme, tool output, thinking, permissions,
external directory grants, project trust, interface/reply language, checks,
subagent concurrency and compaction. Paths and credentials use text entry;
ordinary settings use choices. Opening a menu does not execute a check or
change a setting.

Themes: `terminal` preserves terminal colors; `dark` and `light` add semantic
colors and message backgrounds. Select the one matching your terminal background.
Theme changes affect the current menu and new output; native scrollback keeps
its original colors. Theme and tool-output preferences survive restart.

Bash results show the last six output lines in compact mode. Truncation includes
`/detail <callID>`; detail preserves multiline input/output and edit diffs.
Expanded mode prints full output. Nonzero exits and HTTP errors are marked as
failures even when the tool call itself completed normally.

The input uses horizontal separators, with working directory, model and context
usage underneath. Menus, completion and session selection use a consistent
selection highlight. This interaction design draws on
[Pi](https://github.com/badlogic/pi-mono); alfa keeps its own terminal implementation.

## Runtime and SSH

Ask alfa about its current sandbox or permissions to inspect live runtime facts.
The `environment` tool reports the backend, path grants, temporary directory and
supported controls. The saved sandbox preference applies in every permission mode, `/permission auto` included.

For a saved SSH alias, ask “inspect pc1, then test the connection with true”.
The `ssh` tool uses host OpenSSH and existing config, keys and agent. First access to each host
shows an approval in default/confirm mode. Auto applies its silent risk gate without
host prompts and does not create remembered grants. Press Enter/y for one call or s to allow
that exact host alias for the current conversation, including subagents; configured local SSH helpers are
included in that approval. `/ssh` lists grants; `/ssh revoke HOST|all` revokes them
and cancels active calls. Switching conversations or exiting clears the grants.
Configuration inspection does not connect. Strict
host-key checking remains enabled, and this tool does not provide an interactive
terminal. Ordinary shell commands follow the selected sandbox setting.


Settings → OS sandbox (experimental) toggles shell filesystem isolation.
Default is off because platform support is incomplete. It is absent from the slash-command
menu. Startup reports the setting only when enabled; it applies in auto mode too.
Changing it stops active commands and subagents first. Off runs shell commands with host filesystem access.
Tool approvals and file-tool path authorization remain separate.

Settings → Model window edits the current model's context and maximum output
limits in tokens. Empty input retains the current effective value. Saving updates
the context meter, compaction budget and subsequent requests immediately, and
survives restart. These budgets must fit the provider's actual capacity.


`/permission auto` is alfa's autonomous mode, and the one a session starts in
unless `--permission` or a previously saved choice says otherwise. Shift-Tab
cycles confirm → default → auto. In auto, tools run with the current OS
account's filesystem and environment access, without alfa approvals, hard-deny
rules, path restrictions, environment filtering or shell sandboxing. Clear reads
and read-only queries run directly; every other gated operation gets one short
review by the current model, which blocks major risks. A failed or timed-out
review also blocks. The sandbox preference remains saved but is overridden
while auto is active. Leaving auto stops active work first, then restores
normal rules and the saved sandbox preference. Auto does not create hidden
persistent grants or elevate OS account privileges.

`/trust` is a different setting: it decides whether the project's own
instruction files may influence the model, not how tools are approved.

## Approval cards and permission modes

Approvals in default/confirm mode stay in a fixed card above the draft. The card shows
why approval is needed, the operation and the choices together; background output
scrolls above it. ↑/↓ move between the choices and ⏎ takes the one under the cursor —
it starts on allow once, so ⏎ alone still allows once; digits and y/s/a/n pick directly.
Press d for full details, where ↑/↓ scroll (PgUp/PgDn scroll anywhere). Tab switches
between the card and the preserved draft, which only shows when it has text. If a draft already exists, typing continues there
until Tab selects the card; Enter does not submit it during approval. Esc rejects.
The original editor and cursor are restored after approval or cancellation.

| Operation | default | confirm | auto |
| --- | --- | --- | --- |
| Ordinary source read/edit, ls, project tests | Automatic under rules | Ask each time through the gate | Silent; clear reads/queries skip the model review, edits and tests get it |
| Unknown command, file redirection, network or MCP call | Ask unless an applicable grant covers it; structural flags can still force a prompt | Ask | Silent risk check; blocks return to the agent |
| Built-in hard denial | Deny | Deny | Risk check, not a user confirmation |

confirm does not offer session/always choices for generic tool approvals because it
asks again even for allow rules. It doesn't put an approval in front of the `ask` tool:
the question itself is the thing you answer. Path and SSH host grants remain separate in both
scoped modes. Not every internal tool invokes the permission gate.

Auto does not print automatic-approval receipts. The agent receives a blocked tool
result and must choose a safer approach instead of asking the user to approve it.

References: [Pi extension UI](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
provides confirm dialogs and custom overlays; [OpenCode permissions](https://opencode.ai/docs/permissions/)
documents once/always/reject choices. Alfa retains its own single-column renderer.

## Cache debugger

`/cache-hit` prints a compact recent-cache overview and returns immediately to the
conversation. `/debugger` → Cache opens the detailed menu: Overview, Request details, Models & task types, and Adapter & limitations.
`/context` keeps its existing session statistics and adds only the `/cache-hit` link
after the provider/local-estimate explanation, before the `/compact` hint.

The cache overview groups by provider/model and final transmitted effort, and shows
actual cache reads, structural ceiling, and retrospective
ceiling utilization (paired actual reads / structural ceiling). Unknown values use a
dash and estimates use `~`. Omitted effort is labeled provider default, never inferred
from the model name or thinking toggle. Thinking modes and token budgets are kept separate
as well. Each group has its own token-weighted rates and coverage. Browsing never sends
model requests.

Diagnostics start with the process and retain the latest 500 completed requests across
conversations and agent roles. Active requests appear when they finish. Restarting clears
the history. No prompt bodies or credentials are retained. `--report PATH` writes a full
invocation report on exit when explicitly requested.

Responses, Chat Completions and Anthropic all capture final requests for compatible
candidate comparison. Raw streaming usage preserves fields the SDK can discard or replace
with zero. Chat input includes cached tokens; Anthropic totals add ordinary input, cache
reads and cache writes. Unknown fields and ambiguous server-side iterations stay unknown.
Anthropic records explicit cache breakpoint positions. Moving a breakpoint does not
change content fingerprints; cache-control policies remain isolated. Its measured prefix
excludes the uncached suffix and remains usable if content through that boundary matches.

Hit rates use paired token-weighted counters. Contradictory observations are excluded
from aggregates and remain visible in detail. Growing histories reuse completed input measurements when an older request remains a
full prefix, or a measured Anthropic cache boundary still matches. An older usable
measurement takes precedence over a longer unmeasured or pending branch. The debugger
reports the measurement basis and boundary. Partial changed segments without measured
boundaries, model-specific eligibility and retention remain unverified. A compatible protocol is not a promise of provider cache
support. Fingerprints, mismatch positions and reason codes are evidence, not proof of a
provider cache miss.
