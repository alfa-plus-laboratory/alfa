/**
 * Comparison labels describe the operator's experiment, never provider-side actions.
 * Keeping argument validation pure makes malformed runs fail before any paid call.
 */
export const help = `Usage: bun eval/run.ts --validate | --model provider/model [options]
  --task ID                  Run one coding fixture by ID; unknown IDs fail before calls
  --repeat N                 Independent attempts per coding task (default 1)
  --compare                  Require --repeat >= 3 for comparison runs
  --cache-condition LABEL    cold, warm, or unspecified; declared, not measured or flushed
  --profile LABEL            Metadata label only; does not select a prompt or settings
  --permission MODE          Explicit per-run override: default, confirm, or auto
  --runtime-evidence PATH    Grade captured runtime evidence instead of coding tasks
  --interrupt-ms N           Interrupt each initial live attempt, then resume
  --prices PATH              Explicit per-million token prices; absent means unknown cost
  --out PATH                 JSON output (default eval/results.json)
--validate uses local reference solutions and grader fixtures, never a provider.
Runtime evidence tool order is checked automatically; factual judgments require a reviewer.
Evidence JSON is an array of {scenario, model, repetition, events, review?}.
Events: {type:"tool-call",tool:"environment"}, {type:"answer",text:"..."},
or {type:"commentary",text:"..."}, in captured order.
Review: {reviewer, factualErrors, unsupportedAttributions, unnecessaryDowngrades, notes}.
--validate output lists scenario prompts and review criteria; evidence has no automatic
truthfulness score. --compare also requires three captured attempts per scenario/model.`

export function parseOptions(args: string[]) {
  const flags = new Set(["--validate", "--compare", "--help"])
  const values = new Set(["--model", "--repeat", "--cache-condition", "--profile", "--runtime-evidence", "--interrupt-ms", "--prices", "--out", "--permission", "--task"])
  const parsed = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (parsed.has(key)) throw new Error(`Duplicate argument: ${key}`)
    if (flags.has(key)) parsed.set(key, true)
    else if (values.has(key)) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`)
      parsed.set(key, value)
    } else throw new Error(`Unknown argument: ${key}`)
  }
  const value = (key: string) => parsed.get(key) as string | undefined
  const integer = (key: string, fallback?: number) => {
    if (!parsed.has(key)) return fallback
    const n = Number(value(key))
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`)
    return n
  }
  const repeat = integer("--repeat", 1)!
  const compare = parsed.has("--compare")
  if (compare && repeat < 3) throw new Error("--compare requires --repeat >= 3")
  const cacheCondition = value("--cache-condition") ?? "unspecified"
  if (!["cold", "warm", "unspecified"].includes(cacheCondition)) throw new Error("--cache-condition must be cold, warm, or unspecified")
  const validate = parsed.has("--validate"), model = value("--model"), runtimeEvidence = value("--runtime-evidence")
  if (!parsed.has("--help") && Number(validate) + Number(!!model) + Number(!!runtimeEvidence) !== 1) throw new Error("Choose exactly one of --validate, --model, or --runtime-evidence")
  const task = value("--task")
  if (task && runtimeEvidence) throw new Error("--task selects coding fixtures, not runtime evidence")
  const interruptMs = integer("--interrupt-ms")
  const permission = value("--permission")
  if (permission !== undefined && (!model || !["default", "confirm", "auto"].includes(permission))) throw new Error("--permission requires --model and must be default, confirm, or auto")
  if (interruptMs && !model) throw new Error("--interrupt-ms requires --model")
  return { validate, model, runtimeEvidence, task, repeat, compare, cacheCondition, permission, profile: value("--profile") ?? null, interruptMs, prices: value("--prices"), out: value("--out") ?? "eval/results.json", help: parsed.has("--help") }
}
