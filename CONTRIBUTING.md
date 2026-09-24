# Contributing to alfa

Thanks for helping. This page is the short path in: how to build and check a change,
where the reasons live, and the traps that don't announce themselves.

## Build and check

alfa runs on **Bun ≥ 1.3**, not Node. CI pins 1.3.14. Text imports, `--compile` and
`bun:test` all depend on Bun.

```sh
bun install
bun run dev          # run alfa from source
bun run typecheck    # tsc --noEmit
bun test             # about 45 seconds
bun run build        # single-file binary at bin/alfa-bin
```

Run `typecheck` and `test` before opening a pull request. There is no linter; please
don't add one in the same change. CI also runs these on macOS, and on Linux it runs a few
grep-based architecture guards (`.github/workflows/ci.yml` explains each one).

## Where the reasons are

The reasons live in the code. Every file opens with a comment on *why* it is the way it
is, what was tried and failed, and what breaks if it's removed. Read that comment before
you change the file. When you change logic, check that the comment above it is still
true, and write the reason for your own change there too. Comments that only restate the
code are unwanted. [AGENTS.md](AGENTS.md) lists the other conventions that are reversed
in this repository; read it once.

## Traps that fail silently

- `src/tool/**` must not import `ai` / `@ai-sdk/*`, and `src/prompt/**` must not depend
  on `src/cli/**`.
- The tool list must stay sorted (`src/tool/registry.ts`). It is the earliest prompt-cache
  prefix, so if the order jitters, every request misses the cache.
- The system prompt's `parts[0]` holds only static content. Anything that varies per
  session goes in `parts[1]`, otherwise caching is off.
- A new tool must be registered in `src/tool/builtin.ts`. A new built-in skill needs a
  line in `src/prompt/builtin-skills.ts` and in the list in `test/skills.test.ts`. Miss
  either step and it simply doesn't exist.
- Text the user reads goes through the catalogs in `src/i18n/` or `uiText(en, zh, ja)`,
  never a bare string. Text the model reads (tool descriptions, errors) is English.

## Where changes land

`src/cli/main.ts` is large (about 4,400 lines), and most features are wired through it.
Put new logic in its own module, keep the edits in `main.ts` to the wiring, and expect
merge conflicts there to be the common kind.

## Tests

A test title says what the test guards. Put the reason above any assertion that looks
odd. Several tests assert exact sentences in prompts and tool descriptions, and what they
guard is the removal of that sentence. If one fails after you deleted a sentence, the
test is doing its job.

## Commits and pull requests

Commit messages are in English and start with `feat:`, `fix:`, `docs:` or `release:`.
The subject says what changed and why. A change users will notice also gets a line in
[CHANGELOG.md](CHANGELOG.md).

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
