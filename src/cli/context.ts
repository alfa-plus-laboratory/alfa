/**
 * Context stats are pulled up on demand via /context, no longer resident and crowding out
 * replies. Proportional bars compare body text, tool output and cache; fill level and
 * share use different color semantics.
 */
import type { ContextReport, ContextSnapshot, SliceKey } from "../agent/context.ts"
import { aggregateCacheDiagnostics } from "../llm/cache/index.ts"
import { summarizeDiagnostics, groupDiagnosticsByModelEffort, type DiagnosticSnapshot } from "../llm/diagnostics.ts"
import { t, uiText as tr } from "../i18n/index.ts"
import { compact } from "./render.ts"
import { color256, theme } from "./theme.ts"
import { displayWidth, padToWidth } from "./width.ts"

/**
 * Yellow line / red line. At the yellow line you should know `/compact` exists; at the red
 * line it's time for it to happen
 */
export const WARN_AT = 0.8
export const DANGER_AT = 0.95

/**
 * Green → yellow-green → yellow → orange-red → red → dark red. xterm-256 color numbers,
 * ordered from 0% to 100%.
 *
 * ── Why a gradient, not a three-state traffic light ──
 * Three states only signal once, at the moment a line is crossed, and at that moment the
 * user is most likely not looking. A gradient makes **every glance** carry position
 * information: leaning yellow means past half, turning orange means time to think of
 * `/compact` — no need to read the number or remember which line 80% is.
 *
 * The last two tiers (124/88) are "dark red": they only appear when it's truly up
 * against the top, and dimming at that point is exactly right — a full progress bar
 * shouldn't still be glowing and grabbing your eye; it should look burnt out.
 */
const RAMP = [46, 82, 118, 154, 190, 226, 220, 214, 208, 202, 196, 160, 124, 88] as const

/**
 * The color for a given position.
 *
 * When `readable` is true, **avoid the two darkest tiers** — text has to be legible. A
 * progress bar can burn down to near-black because its information is in its length; a
 * percentage written in color 88 is basically invisible on a dark terminal.
 */
export function rampPaint(ratio: number, readable = true): (text: string) => string {
  const last = RAMP.length - 1 - (readable ? 2 : 0)
  const at = Math.max(0, Math.min(last, Math.round(clamp01(ratio) * (RAMP.length - 1))))
  return color256(RAMP[at]!)
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

/**
 * Colors for the per-item bars in the report, and for the over-the-line warning.
 *
 * The per-item bars show **share**, not **fill level**, so a gradient means nothing there
 * ("this item is 60%" shouldn't turn red just because it's large — it's just large); the
 * over-the-line warning is a sentence, and yellow and red have that single meaning
 * throughout this UI. So these two still use three tiers.
 */
export function paintFor(ratio: number): (text: string) => string {
  if (ratio >= DANGER_AT) return theme.red
  if (ratio >= WARN_AT) return theme.yellow
  return theme.dim
}

/**
 * The gauge: `▓▓▓▓▓░░░░░░░░`.
 *
 * Solid/hollow blocks rather than graded blocks: graded blocks (▁▂▃) have uneven heights in
 * monospace fonts, and a row of them looks broken. These two are stable single-width
 * characters in every terminal.
 */
export function gauge(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  // Anything at all gets one cell: 0% and 0.4% make no difference to decisions, but "not a
  // single cell" makes people think it's broken
  const at = ratio > 0 && filled === 0 ? 1 : filled
  return "▓".repeat(at) + "░".repeat(Math.max(0, width - at))
}

/**
 * The colored gauge: **each cell is colored by its own position in the window**, not the
 * whole bar in one color.
 *
 * So the bar itself is the color ramp: whichever cell it reaches, that cell has the color
 * for that position. With a single color for the whole bar, 34% and 79% look identical
 * (both grey), and color is the dimension here that's easiest on the eyes. The empty cells
 * stay dim — they're "not there yet" and shouldn't have color.
 */
export function gradientGauge(ratio: number, width: number): string {
  const bar = gauge(ratio, width)
  let out = ""
  for (let at = 0; at < width; at++) {
    const char = bar[at] ?? "░"
    // Position is at/(width-1), not (at+1)/width: the first cell must land on the **head**
    // of the ramp and the last cell on the **tail**. With the latter, even a full bar never
    // reaches pure green or the two darkest tiers, and the shorter the bar the more it
    // loses — an eight-cell bar starts from the second tier and looks yellowish by itself
    const position = width > 1 ? at / (width - 1) : 1
    out += char === "▓" ? rampPaint(position, false)(char) : theme.dim(char)
  }
  return out
}

const LABEL_WIDTH = 20
const BAR_WIDTH = 14

/**
 * The body of `/context`.
 *
 * The width isn't supplied by the caller: a slash command's reply is a block of text
 * printed into the scrollback, at whatever width the terminal happens to be. So it's
 * drawn in a fixed layout that fits even a narrow terminal, so it never wraps — a table
 * mangled by wrapping is harder to read than a plain column of numbers.
 */
export function renderContextReport(report: ContextReport, model: string): string {
  const paint = paintFor(report.ratio)
  const percent = Math.round(report.ratio * 100)
  const lines: string[] = []

  lines.push(
    "  " +
      theme.bold(t.ctxTitle) +
      "  " +
      gradientGauge(report.ratio, 24) +
      "  " +
      // The percentage is **the same color as the end of the bar**: both say the same
      // thing, and mismatched colors read as saying two different things
      theme.bold(rampPaint(report.ratio)(`${report.estimated ? "~" : ""}${percent}%`)) +
      theme.dim(`   ${compact(report.used)} / ${compact(report.budget)}`),
  )
  lines.push("")

  for (const slice of report.slices) {
    // Items taking up nothing aren't listed. Leaving them out makes the items that really
    // take space stand out better than an extra 0 would
    if (slice.tokens <= 0) continue
    lines.push(row(sliceLabel(slice.key), slice.tokens, slice.tokens / report.budget, theme.cyan))
  }
  lines.push(row(t.ctxFree, report.free, report.free / report.budget, theme.dim))

  lines.push("")
  // Model name and window go together: the window size is a property of **this model**;
  // written separately, someone who switched models would read this report with the
  // previous model in mind
  lines.push(theme.dim(`  ${model} · ${t.ctxWindow(compact(report.limit), compact(report.budget))}`))
  if (report.limitSource === "default") lines.push(theme.dim(`  ${t.ctxWindowGuessed}`))
  lines.push(theme.dim(`  ${t.ctxMessages(report.messages)}${report.folded > 0 ? ` · ${t.ctxFolded(report.folded)}` : ""}`))
  // Spend: **not the same kind of thing** as the numbers above, so it gets its own line,
  // with an on-the-spot explanation of why it's so large. Without one, a number ten times
  // the window looks like a bug
  if (report.spent.total > 0) {
    const spent =
      "  " +
      t.ctxSpent(compact(report.spent.total), compact(report.spent.input), compact(report.spent.output)) +
      (report.spent.cached > 0 ? ` · ${t.ctxSpentCached(compact(report.spent.cached))}` : "")
    lines.push(theme.dim(spent))
    lines.push(theme.dim(`  ${t.ctxSpentWhy}`))
    lines.push(theme.dim(`  ${t.ctxSpentScope}`))
  }
  // These two sentences are the report's honesty statement: the total is real, the split
  // is estimated. Without them, the user takes a number like 251.0k as exact and makes
  // decisions on it
  lines.push(theme.dim(`  ${report.estimated ? t.ctxAllEstimated : t.ctxSplitEstimated}`))
  lines.push(theme.dim("  " + tr("/cache-hit shows cache usage for recent LLM calls", "/cache-hit 查看近期 LLM 调用缓存情况", "/cache-hit で最近の LLM 呼び出しのキャッシュ状況を確認")))
  if (report.ratio >= WARN_AT) lines.push(paint(`  ${t.ctxCompactHint}`))
  else lines.push(theme.dim(`  ${t.ctxCompactHint}`))

  return lines.join("\n")
}

function row(label: string, tokens: number, share: number, paint: (text: string) => string): string {
  const percent = Math.round(share * 100)
  // Taking up space yet showing 0% reads as "this item costs nothing". It does cost, just
  // under one percent
  const shown = percent === 0 && tokens > 0 ? "<1%" : `${percent}%`
  return (
    "  " +
    theme.dim(padToWidth(label, LABEL_WIDTH)) +
    padRight(compact(tokens), 8) +
    theme.dim(padRight(shown, 6)) +
    "  " +
    paint(gauge(share, BAR_WIDTH))
  )
}

/**
 * Right-align numbers. padToWidth left-aligns, and a left-aligned column of numbers isn't
 * aligned at all
 */
function padRight(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text))
  return " ".repeat(pad) + text
}

export function sliceLabel(key: SliceKey): string {
  switch (key) {
    case "system":
      return t.ctxSystem
    case "tools":
      return t.ctxTools
    case "mcp":
      return t.ctxMcpTools
    case "skills":
      return t.ctxSkills
    case "summary":
      return t.ctxSummary
    case "memory":
      return t.ctxMemory
    case "env":
      return t.ctxEnv
    case "user":
      return t.ctxUser
    case "handoff":
      return t.ctxHandoff
    case "reply":
      return t.ctxReply
    case "thinking":
      return t.ctxThinking
    case "call":
      return t.ctxCall
    case "result":
      return t.ctxResult
  }
}

/** Cache ratios have different denominators from context fill. Keep unknown gauges empty
 * of meaning (dashes), not a zero-percent bar, and mark structural estimates explicitly.
 * The user overview covers task agents only; debugger explicitly includes auxiliary calls
 * so a title or classifier using the same model cannot dilute task cache statistics.
 * Overall hit rate includes cold calls; the three comparison rates share one cohort. */
export function renderCacheMetrics(snapshot: DiagnosticSnapshot, scope: "tasks" | "all" = "tasks"): string {
  const entries = scope === "all" ? snapshot.entries : snapshot.entries.filter(entry =>
    entry.usage.execution?.requestKind === "main" || entry.usage.execution?.requestKind === "subagent")
  const coverage = (known: number, total: number) => theme.dim("  " + tr(`${known}/${total} requests`, `${known}/${total} 次请求`, `${known}/${total} 件`))
  const amount = (label: string, tokens: number | null, known: number, total: number) =>
    "  " + theme.dim(padToWidth(label, 32)) + padRight(tokens === null ? "—" : compact(tokens), 8) + coverage(known, total)
  const rate = (label: string, ratio: number | null, known: number, total: number, estimate = false) => {
    const value = ratio === null ? "—" : `${estimate ? "~" : ""}${Math.round(ratio * 100)}%`
    return "  " + theme.dim(padToWidth(label, 32)) + padRight(value, 8) +
      (ratio === null ? theme.dim("─".repeat(BAR_WIDTH)) : theme.cyan(gauge(ratio, BAR_WIDTH))) + coverage(known, total)
  }
  const lines = ["  " + theme.bold(tr("Cache hits for this invocation", "本次调用的缓存命中情况", "今回の呼び出しのキャッシュヒット状況"))]
  for (const group of groupDiagnosticsByModelEffort(entries)) {
    const actual = summarizeDiagnostics(group.entries)
    const structural = aggregateCacheDiagnostics(group.entries.flatMap(entry => entry.usage.cache ? [entry.usage.cache] : []))
    const normalizedInput = group.entries.some(entry => entry.usage.cache?.inputTokenSource === "sdk-normalized")
    const effort = group.effort
      ? group.effort.level ?? tr("provider default", "厂商默认", "プロバイダー既定")
      : tr("unknown", "未知", "不明")
    const thinking = group.effort?.thinking
    const budget = group.effort?.budgetTokens
    lines.push("", "  " + theme.bold(`${group.model.providerID}/${group.model.modelID}`) + theme.dim(` · effort: ${effort}${thinking ? ` · thinking: ${thinking}` : ""}${budget != null ? ` · budget: ${budget}` : ""}`),
      amount(tr("Total input", "总输入", "総入力"), actual.input.tokens, actual.input.known, actual.requests),
      amount(tr("Cached input", "缓存命中输入", "キャッシュ済み入力"), actual.read.tokens, actual.read.known, actual.requests),
      amount(tr("Total output", "总输出", "総出力"), actual.output.tokens, actual.output.known, actual.requests),
      rate(tr("Overall hit rate (incl. first)", "整体命中率（含首次请求）", "全体ヒット率（初回を含む）"), actual.hitRate, actual.hitRateKnown, actual.requests),
      "",
      theme.dim("  " + tr("Comparison below uses the same requests", "以下三项使用同一组有效请求", "以下の比較は同じリクエスト群を使用")),
      rate(tr("Actual cache hit rate", "实际缓存命中率", "実測キャッシュヒット率"), structural.comparison.hitRate, structural.comparison.requests, actual.requests),
      rate(tr("Maximum cache hit rate", "理论最大缓存命中率", "理論最大キャッシュヒット率"), structural.comparison.maximumHitRate, structural.comparison.requests, actual.requests, true),
      rate(tr("Cache hit efficiency", "缓存命中效率", "キャッシュヒット効率"), structural.comparison.efficiency, structural.comparison.requests, actual.requests, true),
    )
    if (normalizedInput) lines.push(theme.dim("  " + tr("Input total uses SDK normalization where cache-write usage is omitted", "未返回缓存写入量的请求，总输入采用 SDK 归一化值", "書込量が省略されたリクエストの総入力には SDK 正規化値を使用")))
  }
  if (!entries.length) lines.push(theme.dim("  " + tr("No completed requests in this scope", "此范围内暂无已结束请求", "この範囲に完了リクエストはありません")))
  lines.push("",
    theme.dim("  " + tr(`Process · ${scope === "tasks" ? "main/subagents" : "all calls"}: ${entries.length} · latest ${snapshot.entries.length}/${snapshot.totalRequests} sampled requests`, `本进程 · ${scope === "tasks" ? "主/子 agent" : "全部调用"} ${entries.length} 次 · 最近 ${snapshot.entries.length}/${snapshot.totalRequests} 次采样`, `プロセス · ${scope === "tasks" ? "主/子 agent" : "全呼出"} ${entries.length} 件 · 直近 ${snapshot.entries.length}/${snapshot.totalRequests} 件を採集`)),
    theme.dim("  " + tr("~ estimated · — unknown · each row uses its available requests", "~ 估计 · — 未知 · 各行按有数据的请求统计", "~ 推定 · — 不明 · 各行は観測できたリクエストのみ集計")),
    theme.dim("  " + tr("Details: /debugger → Cache", "详情：/debugger → 缓存", "詳細：/debugger → キャッシュ")),
  )
  return lines.join("\n")
}
