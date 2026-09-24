# 0.10 verification

Validated on macOS arm64 with Bun 1.3.14. Bun was obtained as the official npm platform archive, with its published SHA-512 verified; no remote installation script was executed.

- `bun run typecheck`: passed.
- `bun test`: 1384 passed, 0 failed, 56 files.
- `bun run build`: single-file binary compiled successfully.
- `ALFA_BINARY=/absolute/path/bin/alfa-bin python3 script/smoke-terminal.py`: passed at 40 columns and 20 rows. Tests CJK input, visible default-allowed edit diffs, tool details, settings provider creation against a local protocol fixture, connection test, immediate switching, access listing, clean exit, native scrollback, one-shot usage, pipes, SIGINT and resume.
- OS execution tests: real macOS kernel denial before an external grant, read without write after a read grant, write after a write grant, and denial after revocation.
- File-tool tests: adjacent repository reads, separate external edit authorization, directory reuse, symlink resolution, nonexistent parents, credentials, session expiry, persistent grants and revocation.
- `bun eval/run.ts --validate --out eval/fixture-results.json`: all three initially broken coding projects fail before repair and pass independent acceptance tests after the reference repair.

There are no live-model scores: the validation environment has no configured default model or usable provider credential. `completed` and API cost remain null for fixture validation. The local mock API tests the CLI, not model coding ability. The live evaluation runner is available with `--model`, explicit optional prices and interruption/resume reports.

Linux bubblewrap is implemented but was not exercised on a Linux kernel in this environment. SSH, tmux and physical IME composition were not tested on separate hosts; terminal protocol behavior and committed CJK input were tested through a real PTY. Filesystem isolation does not isolate networking or trusted MCP/extension host code. Known credential-path checks are not a complete secret detector; filesystem races and platform policy differences remain limitations.

## 0.10.1 onboarding repair

Removed the ambiguous authentication-mode question: credentials now go directly into hidden input. The MiniMax template supplies its Anthropic-compatible endpoint; empty or malformed endpoints retry in place. Hidden input also consumes buffered paste characters without leaking them into the next echoed field.

Full suite: 1387 tests passed. First-run PTY coverage now includes an empty endpoint retry, hidden credential input, separate auth/config persistence and successful entry into the interactive session, all against a local API fixture. No real user credential is used.

## 0.10.2 wizard and concurrent permissions

The wizard now uses five steps, arrow-key menus, searchable choices, a review before testing, optional advanced settings, and an editable draft after failures. `/` completion is wired to the single-column input again. Permission decisions serialize and re-evaluate rules after earlier approvals; the active prompt retains keyboard and display ownership. A confirmation key plus Enter in the same input batch cannot reach chat.

The compiled macOS binary passed the 40-column PTY fixture with five real subagent runners issuing twenty same-scope read requests: exactly one permission prompt, no approval text submitted as user messages. This uses a local mock model and dummy files, not live news or real credentials. First-run setup, settings, model switching, slash completion, interruption and resume also passed.
