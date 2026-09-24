# Changelog

User-visible changes per release, starting with 0.12.20.

## 0.15.1

**Slash commands, questions and approvals each look like themselves instead of like the
model's answer.**

- A slash command is echoed as you typed it and its output hangs under a `⎿`, indented —
  `/context` or a `/think` flipped mid-turn no longer reads as part of the reply.
- The `ask` tool's question is a card at the bottom: a `❯` cursor that ↑/↓ move, digits
  that pick, and a type-your-own row you reach just by typing. Multiple choice ticks
  `[✓]` and submits from a Done row; `←` goes back with the earlier answer still there
  and `→` keeps it. Once answered, each question and its answer stay under the call —
  also in a resumed session.
- The approval card has the same shape: the operation set off in bold, "Proceed?", then
  numbered choices under a cursor that starts on allow once (so ⏎ alone still allows
  once; y/s/a/n still work). The draft box only shows when it has text or you switch to
  it, and an input method eating the letter keys gets a one-line note on the card. The
  receipt under the tool line now says ✓/✗ and the choice in words.
- In confirm mode a question no longer comes after an approval card asking whether it
  may be asked (`⚠ Approve · ask` with just `*` in it). A rule you set for `ask` still
  applies.

## 0.15.0

**The screen shows what it's doing: a moving alfa mark, a turn clock, the thinking tail,
pinned progress for the plan, subagents and background jobs, and a richer footer.**

- While a turn runs, the line above the input box has the alfa mark, animated, the phase
  (`thinking`, `writing`, the running tool, `retrying in 3s`) and a turn clock. Idle
  still redraws nothing. Settings → Animation turns it off.
- The model's thinking shows as a two-row tail while it streams, and a
  `∴ thought 8.2s` line stays behind for blocks over a second. Settings → Thinking display
  switches to the full thinking in the transcript (as `--reasoning` does) or off.
- Every turn ends with `✻ worked 1m23s · 7 steps`.
- Pinned rows above the input box: the plan's progress and current item (one row, not the
  whole checklist), every subagent not yet killed — running, queued or suspended — and
  background processes still running. A hundred subagents still fit one row.
- Subagents can be **suspended** or **killed**. A suspended one (also any that finished on
  its own) keeps its memory and the main agent can wake it with `task resume`; a killed
  one is removed for good. The `job` tool has both actions, and its description tells the
  model to kill a subagent it judges won't be needed again and suspend it otherwise.
  `/agents <id> suspend`, `/agents <id> kill` and `/agents kill` do the same for you.
  Before, `job kill` only stopped a subagent and answered "Stopped" even for one that had
  already stopped, so "kill the others" left them listed.
- After the first checklist, a todo update prints only the items that changed. A plan can
  now be dropped (`todo` with `clear: true`); before, the model had no way to remove one
  and left a placeholder step pinned instead.
- The footer adds a context bar, the actual cache hit rate (as in `/cache-hit`, first
  requests excluded) and the latest output speed in tokens per second.
- At launch the empty input box shows one tip, labelled `tips` — `/` for commands, or
  `/compact` when a resumed session is nearly full, `/upgrade` when a new version is out.
  Once you send the first message the box stays empty.
- A `task` model name that differs from the configured one only in case
  (`MiniMax/MiniMax-M3` for provider `MINIMAX`) now resolves instead of failing, and a
  `task` line shows the subagent's name and brief instead of a bare `● task`.
- The live area rewrites only the rows that changed, instead of redrawing the whole block.

## 0.14.1

- A path glued to Chinese or Japanese text before it (`这是什么/Users/me/shot.png`,
  `看一下@shot.png`) now attaches the image. Before, only a path after a space did, and
  the model got the bare path instead.
- Pasting a `data:image/…;base64,` URL (what "Copy image address" gives on most Google
  Images results) saves it as a file and puts its `@path` in the line, like ctrl-v.
  Before, it was sent as tens of KB of text the model couldn't view.
- The system prompt says attached images are in the user's message, to be looked at
  directly. `read` on an image says so too, instead of "binary file", which had models
  decoding and OCRing a picture they had already been given.

## 0.14.0

**Reasoning effort, image input, and subagents with their own model, effort and tools.**

- `/effort low|medium|high|xhigh|max|default` sets how hard the model thinks (also in
  `/setting`, `--effort` for one run). It is sent as Anthropic's `output_config.effort`,
  Responses' `reasoning.effort` or Chat Completions' `reasoning_effort`. Claude models get
  the nearest level they support; `default` sends nothing.
- Fable 5 / 5.1, Mythos and Opus 5.5 no longer fail when extended thinking is off:
  thinking can't be disabled on them, and alfa used to send `disabled` anyway.
- Attach images with `@shot.png`, by dragging a file into the terminal, or with ctrl-v
  (clipboard screenshot). PNG, JPEG, GIF, WebP; large images are shrunk on macOS. Every
  model is assumed to take images; for a text-only one, set `"images": false` on its
  provider or model and it gets a one-line note instead. A failed turn in a conversation
  with images says so.
- The `task` tool takes `model`, `effort` and `tools`, so a subagent can run on a cheaper
  model, think less, or be limited to read-only tools. `job list` and the approval card
  show the setup.
- A subagent that fails right away (bad credentials, unknown model) now reports the real
  error to the agent that started it, instead of "It said nothing."

## 0.13.1

- On Linux, the sandbox checks that bubblewrap actually runs instead of only that it is
  installed. On Ubuntu 23.10+, where AppArmor blocks bwrap's user namespaces, alfa now
  says so and explains the fix. Before, it reported the sandbox as on and failed every
  shell command with "setting up uid map: Permission denied".
- Two tests no longer depend on the machine: a glob check that relied on `~/.ssh`
  existing, and a cache test that broke when colors were on. A wildcard in a directory
  part of a path now always goes to review in auto mode.

## 0.13.0

**Auto mode now works like Claude Code's: code nobody reviewed doesn't run unreviewed.**

- Project build/test scripts, workspace scripts and `git add` / `commit` / `fetch` go to
  the classifier instead of running directly. The classifier is shown the code the command
  will actually run: package.json scripts with their pre/post hooks, the Makefile recipe
  and its prerequisites, and the head of a script file.
- Edits to protected paths go to the classifier even inside the workspace. These include
  `.git`, `.alfa`, `.claude`, `.husky`, `.vscode`, shell rc files, package-manager rc
  files, hook configs and `.mcp.json`.
- Deny rules apply in auto.
- After 3 blocks in a row or 20 in total, auto pauses and asks you about the next blocked
  operation. Approving it resumes auto.
- The OS sandbox setting applies in every permission mode. Auto no longer turns it off.
- The first file read outside the workspace in auto asks once. Answering "always" saves
  `autoOutsideReads: true` in config.json.
- Output from bash, grep, background jobs and ssh, and subagent reports, is checked for
  prompt injection before the model reads it.
- Fixed fast-path bypasses: a committed bare repository's git config, `find -fprint0`,
  `~user` paths, symlinked `mkdir`/`touch` targets, glob-named secrets, and case variants
  of protected and secret paths.
- The Agentflow settings now show the default concurrency when turned on (6).

## 0.12.20

- Skills in `~/.claude/skills` go on the shelf instead of loading in every folder. A
  repository's own `.claude/skills` still loads.
