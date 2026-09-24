---
name: alfa-config
description: how alfa itself is configured — where config.json and auth.json are, adding a provider or API key, why a provider is missing from /model
---

# Configuring alfa itself

Hooking up a new API, switching models, repairing a config that keeps alfa from starting — none of it is guessable: it is this program's own convention.

Use runtime_state or environment for the actual paths in this process. Do not guess ~/.alfa/config.json or propose undocumented sandbox settings.

Two files, and the split between them is the point:

- `{{configFile}}` — providers, default model, preferences. **Holds no keys**, by design. Manage it through `/setting`; outside auto mode agent file tools cannot access alfa’s protected configuration directory.
- `{{authFile}}` — API keys only, mode 0600, shaped `{ "<provider>": { "apiKey": "…" } }`. An entry that is not an object with a non-empty `apiKey` string is **dropped without a word**: the file stays valid JSON, alfa starts normally, and the only symptom is that the provider is missing from `/model`. A wrong shape looks exactly like a right one.

**Neither is inside the project.** In a repository, `.alfa/` holds `memory/`, `skills/` and `mcp.json` — those three are read, nothing else there is. In particular the `config.json` its README lists is a plan, not a feature, and nothing loads it: there is no project-level version of the two files above, so use their absolute paths.

`.alfa/mcp.json` is the one thing a project can configure: which MCP servers this repository uses, as `{"servers": {"<name>": {"command": …, "args": […], "env": {…}}}}`. Values may contain `${VAR}` to pull from the environment, which is how a token stays out of a file that goes into git. Servers can also be defined for the whole machine under `"mcp"` in the global config. A server defined by the project does not start until the user allows it once with `/mcp trust <name>` — it names a command to run, and running it is the user's call, not yours; `/mcp` lists what is connected.

## Model window and sandbox

Settings → Model window edits the current model’s context and maximum output tokens. Blank retains the effective value; positive integers are required and output must not exceed context. Changes are stored per model and immediately update the context meter and compaction budget. They do not increase the provider’s actual capacity. Settings → OS sandbox or `/sandbox on|off` controls shell filesystem isolation independently of permission mode.

## Reasoning effort and images

`/effort low|medium|high|xhigh|max|default` (also Settings → Reasoning effort, `--effort` for one run, `"effort"` in the global config) sets how hard the model thinks, for the conversation and for subagents that don't choose their own. `default` sends nothing and each provider's default applies. Anthropic rounds to what the model supports (4.6 has no xhigh; Haiku 4.5 takes no effort at all); Responses sends `max` as `xhigh`; Chat Completions endpoints get the level verbatim as `reasoning_effort`, so one that rejects it needs `/effort default`. `/think` is separate: it decides whether reasoning is shown and, on Claude, whether thinking runs at all.

The user attaches images by writing `@path/to/image.png` (or pasting/dragging the file's path) or pressing ctrl-v with an image on the clipboard. PNG, JPEG, GIF and WebP. Every model is assumed to take images. For an endpoint that rejects them (a text-only model — the turn fails with an error about the image), set `"images": false` on its provider or under `providers.<id>.models.<model>`: the images stay in the conversation and that model gets a one-line note instead.

## Cache diagnostics

`/cache-hit` prints a compact recent-cache overview grouped by provider/model and final transmitted effort without opening a menu; omitted effort is labeled provider default, and distinct thinking modes/budgets remain separate; `/debugger` → Cache opens detailed diagnostics with Overview, Request details, Models & task types, and Adapter & limitations. `/context` keeps its session statistics and places a `/cache-hit` link after its provider/local-estimate explanation, before the compaction hint. Collection starts with the process, keeps the latest 500 completed requests in memory across conversations and agent roles, and resets on restart. The debugger does not send model requests or retain prompts or credentials. `--report PATH` saves the full invocation report on exit. Responses, Chat Completions and Anthropic support structural diagnosis and raw usage accounting. Compatible providers may omit cache fields; those remain unknown. Structural estimates support growing histories by reusing completed input-prefix measurements or matching measured Anthropic cache boundaries, excluding the uncached suffix. They do not require whole-request equality. Partially changed segments without measured boundaries remain unknown. Unknown counters and predictions are not zero or proof of a cache miss.

## Touching credentials

For `auth.json` outside auto mode, **never read it.** Agent tools cannot modify it either. In auto mode access is available when required by the user’s task; prefer the credential interface to avoid putting keys into the conversation. `/setting` provides hidden credential entry, verifies a real model request, then saves the provider and key separately. The host loads, merges and writes in one step without exposing existing credentials; `read` then `edit` is exactly the wrong shape for an agent.

- **A real vendor key must never pass through you**: not printed, accepted in conversation, or put on a command line. If pasted, it should be treated as exposed and rotated. Direct the user to `/setting` or `{{program}} auth login` for hidden input.
- `auth login` preserves existing model records, limits and reasoning settings. It tests before saving when a model is supplied; `--no-verify` remains a legacy opt-out.
- Local endpoints that require no authentication use `noKey: true`, not a dummy credential. The wizard limits this option to loopback addresses.

Providers are named, and any number of them coexist:

```json
{
  "model": "gateway/your-model-id",
  "providers": {
    "anthropic": { "type": "anthropic" },
    "openai":   { "type": "openai-responses", "baseURL": "https://api.openai.com/v1" },
    "gateway": { "type": "openai-chat", "baseURL": "https://api.example.invalid/v1",
                   "models": { "your-model-id": { "limit": { "context": 128000, "output": 8000 } } } }
  }
}
```

The gateway URL, model ID and limits above are placeholders; use the values documented by your endpoint. Third-party services use Custom API / gateway rather than a built-in vendor preset.

- `type` is one of exactly three: `anthropic` (Anthropic Messages), `openai-responses` (OpenAI-compatible Responses, the default for new custom endpoints), or `openai-chat` (OpenAI-compatible Chat Completions). No former aliases are accepted or migrated. On an interactive start, an unknown type opens the Settings provider repair page and requires an explicit choice; one-shot and piped invocations fail with the precise config error instead of waiting for input. Choosing a valid type that the endpoint does not implement fails on the first request.
- `baseURL` is omitted for a vendor's own official endpoint; otherwise it is the full base **including `/v1` when the vendor expects it** — a missing `/v1` is the usual reason a new provider 404s.
- An authenticated provider missing a key is unavailable; a local endpoint with `noKey: true` is available without a key. The settings screen distinguishes missing credentials, disabled providers and unavailable model discovery. A failed `/models` request never proves that no models exist: enter an exact model ID manually.
- `models` is optional (`["name", …]` works too). It fills `/model`'s completions and declares each model's context window, which is what automatic compaction measures against; a wrong window shows up as either sudden rejections or pointless early compaction. A `limit` on the provider covers models without their own.
- For controlled Responses evaluations, a model entry can set `"promptProfile": "openai-codex"`. This explicitly opts into the Codex template and native patch editing path; it is not chosen from the model name. Omit it or use `"generic"` to retain the default. Only `openai-responses` providers accept this setting. Restart after a manual edit; repeated live-model evaluations are still needed before treating the opt-in profile as better.
- Models are `provider/model` everywhere: `/model gateway/your-model-id`, `-m gateway/your-model-id`. Unlisted names are accepted too.

**The environment beats both files**: `{{envPrefix}}KEY_<NAME>` and `{{envPrefix}}BASE_URL_<NAME>` for a named provider (`my-gateway` → `{{envPrefix}}KEY_MY_GATEWAY`), `{{envPrefix}}MODEL` for the default model, plus `ANTHROPIC_API_KEY` for built-in `anthropic` and `OPENAI_API_KEY` for built-in `openai` / `openai-chat`. When a setting looks ignored, check the environment before touching the file.

`/setting` can add, search, edit, disable and delete providers/models. In Model or Providers & credentials, Discover & add models fetches an existing provider's list using its saved connection and credentials. It accepts manual IDs when discovery fails and can save several models without switching or retesting the connection. Saving alone keeps the active model and startup default; switching now and setting the startup default are explicit choices. Connection setup still verifies a real request before saving, with a save-only option inside settings. You can switch immediately after a successful test by explicitly selecting Save & switch now or Save as default & switch. It displays effective credential and endpoint sources, including environment overrides. Ordinary configuration and keys remain separate. A cancelled or failed wizard does not save a partial provider. Manual changes outside the settings flow require a restart.
