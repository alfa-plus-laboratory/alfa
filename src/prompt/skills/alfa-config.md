---
name: alfa-config
description: how alfa itself is configured — where config.json and auth.json are, adding a provider or API key, why a provider is missing from /model
---

# Configuring alfa itself

Hooking up a new API, switching models, repairing a config that keeps alfa from starting — none of it is guessable: it is this program's own convention.

Two files, and the split between them is the point:

- `{{configFile}}` — providers, default model, preferences. **Holds no keys**, by design: read it, show it, edit it freely.
- `{{authFile}}` — API keys only, mode 0600, shaped `{ "<provider>": { "apiKey": "…" } }`. An entry that is not an object with a non-empty `apiKey` string is **dropped without a word**: the file stays valid JSON, alfa starts normally, and the only symptom is that the provider is missing from `/model`. A wrong shape looks exactly like a right one.

**Neither is inside the project.** In a repository, `.alfa/` holds `memory/` and `mcp.json` — those two are read, nothing else there is. In particular the `config.json` its README lists is a plan, not a feature, and nothing loads it: there is no project-level version of the two files above, so use their absolute paths.

`.alfa/mcp.json` is the one thing a project can configure: which MCP servers this repository uses, as `{"servers": {"<name>": {"command": …, "args": […], "env": {…}}}}`. Values may contain `${VAR}` to pull from the environment, which is how a token stays out of a file that goes into git. Servers can also be defined for the whole machine under `"mcp"` in the global config. A server defined by the project does not start until the user allows it once with `/mcp trust <name>` — it names a command to run, and running it is the user's call, not yours; `/mcp` lists what is connected.

## Touching credentials

You may change `auth.json`. One rule governs how: **never read it.** Reading pulls every key the user owns into this conversation, and this conversation is written to disk. Add or change an entry with a single command that loads, merges and writes in one step — nothing echoed back, nothing already there lost. `read` then `edit` is exactly the wrong shape. Create it mode 0600.

The key's *value* is a separate question from the file:

- A placeholder for an endpoint that checks nothing — `local` for a local server — is not a secret. Write it.
- **A real vendor key must never pass through you**: not printed, not accepted pasted into the conversation, not put on a command line, where it lands in the tool record and the shell history. If one is pasted anyway, say plainly that it should be treated as exposed and rotated. Real keys go in through `{{program}} auth login`, which the user runs: no echo, 0600, verified with a real request.
- But `auth login` **rewrites that provider's entry in `config.json` down to `type` and `baseURL`** — an existing provider's `models`, `limit` and `replayReasoning` are silently lost. For a provider already configured, put the credential in `auth.json` and leave `config.json` alone.

Providers are named, and any number of them coexist:

```json
{
  "model": "minimax/MiniMax-M3",
  "providers": {
    "anthropic": { "type": "anthropic" },
    "minimax":   { "type": "anthropic",     "baseURL": "https://api.minimaxi.com/anthropic/v1" },
    "deepseek":  { "type": "openai-compat", "baseURL": "https://api.deepseek.com/v1",
                   "models": { "deepseek-chat": { "limit": { "context": 128000, "output": 8000 } } } }
  }
}
```

- `type` is one of exactly two and there is no third: `anthropic` (Anthropic Messages) or `openai-compat` (OpenAI chat/completions — DeepSeek, Qwen, MiniMax, vLLM, Ollama, most gateways). The wrong one fails on the first request, not at startup.
- `baseURL` is omitted for a vendor's own official endpoint; otherwise it is the full base **including `/v1` when the vendor expects it** — a missing `/v1` is the usual reason a new provider 404s.
- **A provider with no key is skipped whole**: absent from `/model`'s list, and unreachable by full name too. That catches local endpoints wanting no authentication at all — llama.cpp, Ollama, LM Studio, vLLM on `localhost` — where the symptom is a provider that looks correctly configured and simply is not there. Any non-empty key makes it appear (`{{envPrefix}}KEY_<NAME>=local`, or an `auth.json` entry); nothing checks the value when the endpoint never asks for one.
- `models` is optional (`["name", …]` works too). It fills `/model`'s completions and declares each model's context window, which is what automatic compaction measures against; a wrong window shows up as either sudden rejections or pointless early compaction. A `limit` on the provider covers models without their own.
- Models are `provider/model` everywhere: `/model deepseek/deepseek-chat`, `-m deepseek/deepseek-chat`. Unlisted names are accepted too.

**The environment beats both files**: `{{envPrefix}}KEY_<NAME>` and `{{envPrefix}}BASE_URL_<NAME>` for a named provider (`my-gateway` → `{{envPrefix}}KEY_MY_GATEWAY`), `{{envPrefix}}MODEL` for the default model, plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for the built-in ids `anthropic` and `openai-compat`. When a setting looks ignored, check the environment before touching the file.

Providers load once, at startup: one you add now works the next time alfa starts, not in this session. `/model` switches among those already loaded, and remembers.
