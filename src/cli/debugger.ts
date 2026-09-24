/**
 * Debugger pages read the same bounded ledger as /cache-hit; opening a menu never calls a
 * model or changes permissions. Unknown counters stay visible rather than becoming zero.
 * Request detail is an explicit drill-down so large traces do not bury the chat by default.
 */
import { uiText as tr } from "../i18n/index.ts"
import { aggregateCacheDiagnostics } from "../llm/cache/index.ts"
import { CACHE_ADAPTERS } from "../llm/cache/protocols.ts"
import { renderCacheMetrics } from "./context.ts"
import { cacheObservation, summarizeDiagnostics, type DiagnosticSnapshot, type DiagnosticEntry } from "../llm/diagnostics.ts"
import { aggregateExecutionUsage } from "../llm/execution-usage.ts"
import { choose, type Form } from "./form.ts"
import { InputCancelled } from "./secret-input.ts"

const unknown = () => tr("unknown", "未知", "不明")
const number = (value: number | null | undefined) => value == null ? unknown() : String(value)
const percent = (value: number | null) => value === null ? unknown() : `${(value * 100).toFixed(2)}%`
const back = () => ({ value: "back", label: tr("Back", "返回", "戻る") })
const menu = (form: Form, title: string, items: Parameters<typeof choose>[2]) => choose(form, title, items, undefined, { receipt: false })
const scope = (snapshot: DiagnosticSnapshot) => tr(
  `This process since ${new Date(snapshot.startedAt).toISOString()}; latest ${snapshot.entries.length}/${snapshot.totalRequests} completed requests (limit ${snapshot.capacity}). All conversations and agent roles; active requests appear after completion.`,
  `本次进程自 ${new Date(snapshot.startedAt).toISOString()} 起；最近 ${snapshot.entries.length}/${snapshot.totalRequests} 次已结束请求（最多保留 ${snapshot.capacity} 次）。包含所有会话和代理角色；正在运行的请求结束后计入。`,
  `このプロセスの ${new Date(snapshot.startedAt).toISOString()} 以降。完了リクエストの直近 ${snapshot.entries.length}/${snapshot.totalRequests} 件（上限 ${snapshot.capacity}）。全会話とエージェントを含み、実行中は完了後に反映。`,
)

export function renderCacheSummary(snapshot: DiagnosticSnapshot): string {
  const s = summarizeDiagnostics(snapshot.entries)
  const count = (value: { tokens: number | null; known: number }) => `${number(value.tokens)} (${value.known}/${s.requests})`
  return [
    tr("Cache diagnostics", "缓存诊断", "キャッシュ診断"), scope(snapshot),
    tr(`Actual hit rate: ${percent(s.hitRate)} · observed ${s.hitRateKnown}/${s.requests} requests (token-weighted)`, `实际命中率：${percent(s.hitRate)} · 有效观测 ${s.hitRateKnown}/${s.requests} 次请求（按 token 加权）`, `実測ヒット率：${percent(s.hitRate)} · 観測 ${s.hitRateKnown}/${s.requests} 件（token 加重）`),
    tr(`Input / cache read / cache write / uncached tokens (known requests): ${count(s.input)} / ${count(s.read)} / ${count(s.write)} / ${count(s.uncached)}`, `输入 / 缓存读取 / 缓存写入 / 未缓存 token（括号内为已知请求数）：${count(s.input)} / ${count(s.read)} / ${count(s.write)} / ${count(s.uncached)}`, `入力 / キャッシュ読取 / 書込 / 非キャッシュ token（既知件数）：${count(s.input)} / ${count(s.read)} / ${count(s.write)} / ${count(s.uncached)}`),
    tr(`Structural capture: ${s.captured}/${s.requests} · inconsistent counters: ${s.invalid}`, `结构诊断覆盖：${s.captured}/${s.requests} · 计数异常：${s.invalid}`, `構造診断：${s.captured}/${s.requests} 件 · 不整合：${s.invalid} 件`),
    tr("Unknown is not zero. Structural diagnostics currently cover Responses, Chat and Anthropic; missing provider fields remain unknown. These totals describe retained requests, not the current context window.", "未知不等于零。结构诊断目前覆盖 Responses、Chat 和 Anthropic；供应商缺失的字段保持未知。以上统计仅覆盖保留的请求，不代表当前上下文窗口大小。", "不明はゼロではありません。構造診断は Responses・Chat・Anthropic に対応し、欠損値は不明です。保持したリクエストの集計であり、現在のコンテキスト容量ではありません。"),
    tr("More: /debugger → Cache → Overview / Requests / Models & task types", "更多详情：/debugger → 缓存 → 总览 / 逐次请求 / 模型与任务类型", "詳細：/debugger → キャッシュ → 概要 / リクエスト / モデルとタスク種別"),
  ].join("\n")
}

export function renderCacheOverview(snapshot: DiagnosticSnapshot): string {
  const detailed = aggregateCacheDiagnostics(snapshot.entries.flatMap(e => e.usage.cache ? [e.usage.cache] : []))
  return [renderCacheMetrics(snapshot, "all"), renderCacheSummary(snapshot),
    tr("Structural metrics (captured requests only; null = unknown)", "结构指标（仅覆盖已采集请求；null = 未知）", "構造指標（採取済みのみ、null = 不明）"),
    tr("ACHR = actual reads / input; SRC = structural ceiling / input; structuralUtilization = actual reads / structural ceiling, using paired observations with a positive ceiling. This is retrospective, not a future-hit forecast. Structural estimates reuse measured input prefixes or measured Anthropic cache boundaries. Growing history is supported; a partial changed segment without a measured boundary remains unknown. Estimates are not provider guarantees.", "ACHR = 实际缓存 / 输入；SRC = 结构上限 / 输入；structuralUtilization = 实际缓存 / 结构上限，仅汇总上限大于零且两项都已知的请求。这是事后利用率，不预测未来命中。结构估计复用已测量的历史输入前缀或 Anthropic 缓存断点，支持历史追加；变化片段内部缺少测量边界时仍为未知。估计不是供应商保证。", "ACHR = 実測読取 / 入力、SRC = 構造上限 / 入力、structuralUtilization = 実測読取 / 構造上限。正の上限と読取の両方が既知のリクエストで集計します。将来予測ではなく事後指標です。測定済み入力プレフィックスや Anthropic キャッシュ境界を再利用します。履歴追加に対応し、変更部分に測定境界がない場合は不明です。推定はプロバイダーの保証ではありません。"),
    JSON.stringify({ requests: detailed.requests, totalInput: detailed.totalInput, cacheRead: detailed.cacheRead, cacheWrite: detailed.cacheWrite, uncachedInput: detailed.uncachedInput, structuralReusable: detailed.structuralReusable, ACHR: detailed.ACHR, SRC: detailed.SRC, structuralUtilization: detailed.structuralUtilization }, null, 2),
  ].join("\n\n")
}

export function renderCacheRequest(entry: DiagnosticEntry): string {
  const r = entry.usage
  return [
    tr(`Request #${entry.sequence}`, `请求 #${entry.sequence}`, `リクエスト #${entry.sequence}`),
    tr("Raw measured fields; null means unknown. IDs are local trace IDs. No prompts, credentials or request headers are retained here.", "以下为完整观测字段；null 表示未知。ID 为本地追踪标识。这里不保存提示词、凭据或请求头。", "観測フィールドの詳細。null は不明、ID はローカル追跡用。プロンプト、認証情報、ヘッダーは保持しません。"),
    JSON.stringify({
      sequence: entry.sequence, completedAt: new Date(entry.completedAt).toISOString(),
      requestId: r.requestId ?? null, model: r.model, effort: r.effort ?? null, elapsedMs: r.elapsedMs,
      execution: r.execution ?? null, source: r.cache ? `raw-${r.cache.protocol ?? "openai-responses"}` : r.observedCache ? "sdk-usage" : "unavailable",
      actual: cacheObservation(r),
      inputTokenSource: r.cache?.inputTokenSource ?? null,
      rawActual: r.cache?.rawActual ?? null,
      outputTokens: r.measuredOutputTokens ?? null, reasoningTokens: r.tokens?.reasoning ?? null,
      sdkObservedCache: r.observedCache ?? null,
      diagnostic: r.cache ?? null,
    }, null, 2),
    tr("Reason codes are diagnostic clues, not proof of provider eviction or a cache miss. Structural ceilings have low confidence; unknown predictions remain null.", "原因代码是诊断线索，不是供应商驱逐或缓存未命中的证明。结构上限仅为低置信度估计，无法预测的字段保持 null。", "理由コードは手掛かりであり、プロバイダーの退避やミスの証明ではありません。構造上限は低確度、不明な予測は null です。"),
  ].join("\n\n")
}

export function renderCacheGroups(snapshot: DiagnosticSnapshot): string {
  const groups = new Map<string, DiagnosticEntry[]>()
  for (const entry of snapshot.entries) {
    const r = entry.usage
    const key = `${r.model.providerID}/${r.model.modelID} · effort: ${r.effort ? r.effort.level ?? "provider-default" : unknown()} · thinking: ${r.effort?.thinking ?? "—"} · budget: ${r.effort?.budgetTokens ?? "—"} · ${r.execution?.requestKind ?? unknown()}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const execution = aggregateExecutionUsage(snapshot.entries.map(e => e.usage))
  // The original root request may have fallen out of the ring. A new denominator would
  // make amplification look plausible but wrong, so do not publish it after truncation.
  if (snapshot.totalRequests > snapshot.entries.length) for (const session of execution.sessions) {
    session.contextAmplification = null
    session.rootInputTokens = null
  }
  return [scope(snapshot), tr("By model and task type", "按模型与任务类型", "モデルとタスク種別"),
    ...[...groups].map(([key, entries]) => `${key}\n${JSON.stringify(summarizeDiagnostics(entries), null, 2)}`),
    tr("Execution input totals include cache reads. Amplification is unknown after history truncation or missing measurements.", "执行输入统计包含缓存读取。历史被截断或测量缺失时，上下文放大倍数为未知。", "実行入力はキャッシュ読取を含みます。履歴切捨てや測定不足の場合、増幅率は不明です。"),
    JSON.stringify(execution, null, 2),
  ].join("\n\n")
}

async function requestMenu(form: Form, snapshot: () => DiagnosticSnapshot): Promise<void> {
  let page = 0
  for (;;) {
    const entries = [...snapshot().entries].reverse()
    page = Math.min(page, Math.max(0, Math.ceil(entries.length / 10) - 1))
    const visible = entries.slice(page * 10, page * 10 + 10)
    try {
      const selected = await menu(form, tr("Cache requests · newest first", "缓存请求 · 最新在前", "キャッシュリクエスト · 新しい順"), [
        ...visible.map(e => ({ value: String(e.sequence), label: `#${e.sequence} ${e.usage.model.providerID}/${e.usage.model.modelID}`, description: `${e.usage.execution?.requestKind ?? unknown()} · ${e.usage.elapsedMs} ms · ${new Date(e.completedAt).toISOString()}` })),
        ...(page > 0 ? [{ value: "previous", label: tr("Newer", "较新请求", "新しいリクエスト") }] : []),
        ...((page + 1) * 10 < entries.length ? [{ value: "next", label: tr("Older", "较早请求", "古いリクエスト") }] : []),
        { value: "refresh", label: tr("Refresh", "刷新", "更新") }, back(),
      ])
      if (selected === "back") return
      if (selected === "previous") page--
      else if (selected === "next") page++
      else { const entry = visible.find(e => String(e.sequence) === selected); if (entry) form.say(renderCacheRequest(entry)) }
    } catch (error) { if (error instanceof InputCancelled) return; throw error }
  }
}

export async function debuggerMenu(form: Form, snapshot: () => DiagnosticSnapshot): Promise<void> {
  for (;;) {
    try {
      const selected = await menu(form, tr("Debugger", "调试器", "デバッガー"), [
        { value: "cache", label: tr("Cache", "缓存", "キャッシュ"), description: tr("Usage, hit rates, request details and structural diagnostics.", "用量、命中率、逐次请求与结构诊断。", "用量、ヒット率、リクエスト詳細と構造診断。") }, back(),
      ])
      if (selected === "back") return
    } catch (error) { if (error instanceof InputCancelled) return; throw error }
    for (;;) {
      try {
        const selected = await menu(form, tr("Cache diagnostics", "缓存诊断", "キャッシュ診断"), [
          { value: "overview", label: tr("Overview", "总览", "概要") },
          { value: "requests", label: tr("Request details", "逐次请求详情", "リクエスト詳細") },
          { value: "groups", label: tr("Models & task types", "模型与任务类型", "モデルとタスク種別") },
          { value: "rules", label: tr("Adapter & limitations", "适配规则与限制", "アダプターと制限") }, back(),
        ])
        if (selected === "back") break
        if (selected === "overview") form.say(renderCacheOverview(snapshot()))
        else if (selected === "requests") await requestMenu(form, snapshot)
        else if (selected === "groups") form.say(renderCacheGroups(snapshot()))
        else if (selected === "rules") form.say([
          scope(snapshot()),
          tr("Collected automatically from process startup; no retroactive data after restart. Only metadata is kept in memory. Structural matching covers Responses, Chat and Anthropic, up to 32 prior candidates. Anthropic estimates exclude uncached suffixes and record explicit breakpoint positions. No verified tokenizer, TTL prediction, persistent reuse graph or price estimate. Use --report PATH on startup for the complete invocation report on exit.", "从进程启动时自动采集，重启后无法追溯旧记录；仅在内存保留元数据。结构匹配覆盖 Responses、Chat 和 Anthropic，比较最多 32 个历史候选。Anthropic 记录显式断点位置，上限估计不包含未缓存尾部。暂无经过验证的 tokenizer、TTL 预测、持久复用图或价格估算。启动时加 --report PATH，可在退出时保存完整运行报告。", "起動から自動採取し、再起動前の記録は復元しません。メタデータのみメモリ保持。Responses・Chat・Anthropic の過去最大 32 候補を比較。Anthropic は明示的なブレークポイントを記録し、非キャッシュ末尾を推定から除外します。検証済み tokenizer、TTL 予測、永続グラフ、料金推計は未対応。起動時 --report PATH で終了時に全実行レポートを保存できます。"),
          JSON.stringify(CACHE_ADAPTERS, null, 2),
        ].join("\n\n"))
      } catch (error) { if (error instanceof InputCancelled) break; throw error }
    }
  }
}
