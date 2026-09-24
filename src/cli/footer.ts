/**
 * The two footer lines under the input box: where you are, and the state of the model
 * you're talking to — how full the window is, how well the prompt cache is hitting, how
 * fast it writes.
 *
 * ── What each number is, and why that one ──
 * - Context: the same `gradientGauge` and `rampPaint` as `/context`, so the footer and
 *   the report can never disagree in colour, plus the percentage. Still no absolute token
 *   counts: the only decision here is "compact now or not", and the percentage answers it.
 * - Cache: the **actual cache hit rate** row of `/cache-hit` — the comparable cohort
 *   (requests with a known input, known cache read and a positive structural ceiling),
 *   not the overall rate that includes cold first requests. The overall rate starts every
 *   session near zero and climbs whether or not caching works; the actual rate asks "of
 *   what could have hit, how much did", which is what drops when the prefix breaks.
 *   ⚠ It must come from the diagnostics ledger, never from the meter's Tokens: those turn
 *   a counter the provider didn't send into 0, and "unknown" would read as "0% — broken".
 *   Unknown is `—`; no request yet shows nothing.
 * - Speed: output tokens per second of the latest step (see cli/activity.ts), `~` while
 *   it's still a live estimate.
 *
 * ── What gives way on a narrow screen ──
 * The model name is trimmed from the left first (as before: the tail is what identifies
 * it). Once the name would drop under 12 columns, the metrics go in reverse order of how
 * often they drive a decision — speed, then cache, then the bar — and the percentage stays
 * to the end: it's the one number that says whether the next message fits.
 */
import { gradientGauge, rampPaint } from "./context.ts"
import { theme } from "./theme.ts"
import { displayWidth, elideLeft } from "./width.ts"

const BAR = 8
const MIN_NAME = 12

export interface FooterInput {
  path: string
  spec: string
  ratio: number
  estimated: boolean
  /** undefined = no comparable request yet (draw nothing); null = requests seen, rate unknown */
  cache?: number | null
  speed?: { rate: number; estimated: boolean }
  thinking: boolean
  effort?: string
}

export function footerLines(input: FooterInput, width: number): string[] {
  const percent = `${input.estimated ? "~" : ""}${Math.round(input.ratio * 100)}%`
  const pct = rampPaint(input.ratio)(percent) + theme.muted(" ctx")
  const bar = gradientGauge(input.ratio, BAR)
  const cache = input.cache === undefined ? undefined
    : theme.muted("cache ") + (input.cache === null ? theme.muted("—") : cacheColor(input.cache)(`${Math.round(input.cache * 100)}%`))
  const speed = input.speed ? theme.muted(`${input.speed.estimated ? "~" : ""}${formatRate(input.speed.rate)} tok/s`) : undefined
  const flags = [input.thinking ? "thinking" : "", input.effort ? `effort ${input.effort}` : ""].filter(Boolean).map(flag => theme.muted(flag))

  const sep = theme.muted(" · ")
  const compose = (withBar: boolean, withCache: boolean, withSpeed: boolean): string =>
    [...flags, (withBar ? bar + " " : "") + pct, withCache ? cache : undefined, withSpeed ? speed : undefined]
      .filter((part): part is string => part !== undefined).join(sep)
  const attempts: [boolean, boolean, boolean][] = [[true, true, true], [true, true, false], [true, false, false], [false, false, false]]
  let status = compose(false, false, false)
  for (const [withBar, withCache, withSpeed] of attempts) {
    const candidate = compose(withBar, withCache, withSpeed)
    if (width - displayWidth(candidate) - 3 >= MIN_NAME) { status = candidate; break }
  }
  const name = elideLeft(input.spec, Math.max(1, width - displayWidth(status) - 3))
  return [theme.muted(elideLeft(input.path, width)), theme.muted(name) + sep + status]
}

/**
 * Yellow under 50%: with a positive structural ceiling most of the prompt could have hit,
 * so a low actual rate is a prefix that broke, not a provider without caching (that has
 * no comparable requests and shows `—`).
 */
function cacheColor(rate: number): (text: string) => string {
  return rate < 0.5 ? theme.yellow : theme.muted
}

function formatRate(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1)
}
