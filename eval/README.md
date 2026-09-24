# Coding-task baseline

`tasks.ts` creates three isolated small projects: quoted CSV parsing, a cross-package pagination contract change, and retry/cancellation semantics. Prompts describe behavior; hidden acceptance tests are introduced only after the agent attempt. The harness first verifies that the unmodified fixture fails. Tests written by the agent also run. No external repository or remote install is required.

```sh
bun eval/run.ts --validate --out eval/fixture-results.json
bun eval/run.ts --model provider/model --out /tmp/alfa-baseline.json
bun eval/run.ts --model provider/model --repeat 3 --compare --profile candidate --cache-condition unspecified --out /tmp/alfa-candidate.json
bun eval/run.ts --model provider/model --task pagination --repeat 3 --compare --out /tmp/alfa-pagination.json
bun eval/run.ts --model provider/model --interrupt-ms 3000 --out /tmp/alfa-resume.json
```

Live runs use your configured API and can incur charges. No credentials are embedded in results. Each task keeps its temporary workspace for inspection. Runs time out after ten minutes. `--compare` requires at least three repeats. `--task ID` selects one coding task; unknown IDs fail before any call. Results record a task-set hash, save after every attempt, and retain partial progress on SIGINT/SIGTERM. In-flight reports keep complete billing totals unknown until reported. Keep provider/model, settings and task version fixed when comparing results. `--profile` and `--cache-condition cold|warm|unspecified` are operator labels only: they neither select a prompt nor flush or warm provider caches. Actual cache state remains unverified.

Results include completion according to independent tests, test output, elapsed time, CLI exit code, model requests and provider-reported token usage, approval requests and interruptions. `--report path` is also available on the main CLI. Usage includes main agent, subagents, summaries, compaction and auto-mode reviews for the current invocation. A failed/interrupted request may lack usage; missing usage is unknown, not zero.

Dollar cost is `null` unless all request usage and explicit prices are available. Supply `--prices /absolute/prices.json` with per-million USD rates:

```json
{"provider/model":{"input":1,"output":3,"cacheRead":0.1,"cacheWrite":1.25}}
```

These example rates are placeholders, not vendor prices. The output records the supplied price file. Resume runs include `recovery` and `recoveryMetrics`; cost combines both invocations and remains unknown if either report is missing. The runner uses your saved permission mode unless `--permission default|confirm|auto` explicitly overrides it for the invocation. In auto the classifier reviews everything outside the fast path, including project test scripts since 0.13.0, and a block reaches the agent as a tool error. The few prompts auto still shows (after repeated blocks, and on the first read outside the workspace) are denied noninteractively and counted as approvals. In default/confirm, approvals cannot be answered noninteractively, so they are denied and counted. Measure human approval latency separately in an interactive run.

The invocation report includes OpenAI Responses cache observations and request execution identities. Cache snapshots contain keyed fingerprints rather than prompt text. Ratios are token-weighted and include coverage counts; unavailable token-prefix ceilings and TTL predictions remain null. Main, subagent, summary, compaction and review calls are distinguished. Context amplification includes cached input and becomes unknown when usage or ownership is missing.

Runtime explanations are evaluated separately from coding correctness. `--validate` also checks seven runtime grading fixtures. Run `bun eval/runtime-run.ts --model provider/model --permission confirm --repeat 3 --out /absolute/evidence.json` with isolated XDG config/data to capture all seven scenarios through the actual CLI. This makes paid calls, retains each attempt incrementally and refuses to overwrite existing evidence. In noninteractive confirm mode, environment calls are denied too: calling the tool first does not establish a successful environment read. Captured evidence can be scored with `--runtime-evidence /absolute/evidence.json --repeat 3 --compare`; `--help` describes the evidence format. Tool order is checked automatically, while factual errors, unsupported attributions and unnecessary safety downgrades require a named review. Missing reviews remain unknown. Fixture success is not evidence of live-model behavior.

`fixture-results.json` records fixture validation only. Its `completed` values are null: reference solutions passing tests is not evidence of model performance. [The 2026-09-22 MiniMax comparison](harness-results-2026-09-22.json) records 21 runtime and 9 coding attempts per version, each scenario repeated three times. Under noninteractive confirm, environment-first attempts rose from 1/21 to 11/21, but successful environment reads were zero and both versions completed 0/9 coding tasks with approval blockers. These are permission-constrained observations, not evidence that coding quality improved or regressed. Small synthetic projects are a reproducible starting baseline, not evidence of performance on large production repositories.

## Final controlled comparison (2026-09-23)

[The completed MiniMax comparison](harness-results-2026-09-23.json) uses default permission with the sandbox enabled. Both variants include the same read-only macOS timezone runtime fix; the candidate restores the generic template for MiniMax. Each variant has nine scored coding attempts: six CSV/retry attempts and three clarified pagination reruns. All original pagination rows are excluded because the original prompt did not specify the indexing contract required by the grader; their records and API usage remain retained.

Both variants passed 8/9 joint workspace/acceptance suites and 9/9 hidden acceptance checks. Verified successful agent-dispatched testing fell from 8/9 to 5/9 attempts. This metric requires a persisted successful `bun test` tool result, excludes evaluator tests, and does not prove the final edited revision was tested. Successful environment reads increased from 2/21 to 10/21, but agent review still found incorrect permission advice and command syntax. Provider caches were uncontrolled; these small samples establish no overall reliability, speed, or cost improvement.

All evaluation runs are complete and temporary credential copies have been removed. Follow-up work is limited to permission reasoning and recovery after blocked verification; no additional evaluation rounds are scheduled. Local validation passed 1491 tests, project and evaluation typechecks, the compiled build, and the real terminal smoke check.

The subsequent 0.12.1 template rewrite is not covered by these live results. That rewrite changes task ownership, tool use and verification guidance; local prompt-contract tests do not establish model-quality improvement. Neither is the 0.13.0 auto-mode redesign, which sends project scripts to the classifier and can change auto-mode latency and cost.

## Keeping result files

A result file is committed only when this README cites it as evidence, and it is deleted when that citation goes. Everything else, including repeats, partial runs and personal baselines, is written outside the repository (`--out /tmp/…`). Without this rule every run adds a dated JSON file that nobody reads, and the evidence that matters gets harder to find.
