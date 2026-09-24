/**
 * The one tip in the empty input box, from launch until the first message is sent.
 *
 * ── Why only then, and why labelled ──
 * The first version rotated a tip into the empty box every turn. In use it read as the
 * user's own input: a line like `/effort sets how hard it reasons` sitting after the `›`
 * while the model worked looked exactly like something typed and not yet sent. So the
 * tip now carries a `tips` label in its own colour (drawn by Shell), and it is gone for
 * good once the first message goes out — mid-conversation the box is either what the
 * user typed or empty, nothing else. The launch screen is the moment a hint helps:
 * the user is deciding what to type first, and the box has nothing else to say.
 *
 * ── Which tip ──
 * Chosen once, at the first paint, so it never changes under the reader. A nearly full
 * context (a resumed session) and situational facts (old sessions piling up, the strictest
 * permission mode) win; otherwise a third of launches teach `/`
 * and `@` — every other tip assumes the user knows commands exist — and the rest draw
 * from the pool. One exception to "never changes": an update found after the first paint
 * replaces the tip, since it's the one fact that is worth the flicker.
 *
 * ⚠ Every tip names something that exists **today** — verified against commands.ts and
 * the key handling, not against DESIGN.md (which still mentions removed commands). A
 * tip about a missing command teaches the user the tips can't be trusted. Keep each under
 * ~48 columns: the box truncates without an ellipsis.
 */
import { t, uiText } from "../i18n/index.ts"
import type { PermissionMode } from "../permission/mode.ts"

/** Matches the auto-compaction threshold's run-up: warn before 90% does it for you. */
export const TIP_CONTEXT_AT = 0.7
const MANY_STALE = 10

export interface TipSignals {
  /** Context fill, 0–1 */
  ratio: number
  /** Newer version available, if the startup check found one */
  update?: string
  mode?: PermissionMode
  /** Conversations old enough for /history-clean's default window */
  staleSessions: number
}

const FIRST = (): string => t.placeholder

const POOL: (() => string)[] = [
  () => uiText("/resume picks up an earlier session", "/resume 继续以前的会话", "/resume で前の会話を再開"),
  () => uiText("/model shows or switches the model", "/model 查看或切换模型", "/model でモデルを切替"),
  () => uiText("/context shows what fills the window", "/context 查看上下文由什么占用", "/context でコンテキストの内訳"),
  () => uiText("/compact folds history to free context", "/compact 压缩历史释放上下文", "/compact で履歴を圧縮"),
  () => uiText("/setting — model, theme, permissions", "/setting 管理模型、主题与权限", "/setting でモデル・テーマ・権限"),
  () => uiText("Shift-Tab cycles the permission mode", "Shift-Tab 切换权限模式", "Shift-Tab で権限モード切替"),
  () => uiText("Enter while it works slips your note in", "运行中按 Enter，消息会插进当前任务", "実行中の Enter で指示を差し込めます"),
  () => uiText("Ctrl-J or Alt-Enter adds a new line", "Ctrl-J 或 Alt-Enter 换行", "Ctrl-J か Alt-Enter で改行"),
  () => uiText("Ctrl-V pastes a clipboard image", "Ctrl-V 粘贴剪贴板里的图片", "Ctrl-V でクリップボード画像を貼付"),
  () => uiText("/agentflow runs subagents in parallel", "/agentflow 让子代理并行干活", "/agentflow でサブエージェント並列化"),
  () => uiText("/agents lists subagents, running or suspended", "/agents 查看运行中与挂起的子代理", "/agents で実行中・一時停止中を確認"),
  () => uiText("/jobs lists background processes", "/jobs 查看后台进程", "/jobs でバックグラウンド処理を確認"),
  () => uiText("/detail <id> shows a tool's full output", "/detail <id> 查看工具完整输出", "/detail <id> でツールの全出力"),
  () => uiText("/think toggles extended thinking", "/think 开关深度思考", "/think で拡張思考を切替"),
  () => uiText("/effort sets how hard it reasons", "/effort 设置推理强度", "/effort で推論の強さを設定"),
  () => uiText("/cache-hit shows the prompt cache hit rate", "/cache-hit 查看缓存命中率", "/cache-hit でキャッシュヒット率"),
  () => uiText("/init writes AGENTS.md for this repo", "/init 为本项目生成 AGENTS.md", "/init で AGENTS.md を作成"),
  () => uiText("/mcp manages connected MCP servers", "/mcp 管理已连接的 MCP 服务", "/mcp で MCP サーバーを管理"),
  () => uiText("/skills lists the playbooks it can open", "/skills 查看可用技能", "/skills で使えるスキル一覧"),
  () => uiText("/language switches UI or reply language", "/language 切换界面或回复语言", "/language で表示・返答言語を切替"),
  () => uiText("/history-clean removes old sessions", "/history-clean 清理旧会话", "/history-clean で古い履歴を削除"),
]

export class Tips {
  private chosen: (() => string) | undefined
  private dismissed = false

  constructor(private readonly random: () => number = Math.random) {}

  /** The first message went out: from now on the box stays empty. */
  dismiss(): void {
    this.dismissed = true
  }

  /** The tip to show, or undefined once a message has been sent. */
  current(signals: TipSignals): string | undefined {
    if (this.dismissed) return undefined
    if (signals.update) return updateTip(signals.update)
    this.chosen ??= this.pick(signals)
    return this.chosen()
  }

  private pick(signals: TipSignals): () => string {
    if (signals.ratio >= TIP_CONTEXT_AT) {
      return () => uiText("Context is filling up — /compact frees it", "上下文快满了，/compact 可释放空间", "残りわずか — /compact で空きを確保")
    }
    const situational = situationalTips(signals)
    if (situational.length > 0) return situational[0]!
    const roll = this.random()
    if (roll < 1 / 3) return FIRST
    return POOL[Math.min(POOL.length - 1, Math.floor(((roll - 1 / 3) / (2 / 3)) * POOL.length))]!
  }
}

function updateTip(version: string): string {
  return uiText(`${version} is out — /upgrade installs it`, `新版本 ${version}，/upgrade 升级`, `${version} が公開 — /upgrade で更新`)
}

function situationalTips(signals: TipSignals): (() => string)[] {
  const tips: (() => string)[] = []
  if (signals.staleSessions >= MANY_STALE) {
    tips.push(() => uiText("Old sessions piling up? /history-clean", "旧会话很多？/history-clean 清理", "古い履歴が多い？/history-clean"))
  }
  if (signals.mode === "confirm") {
    tips.push(() => uiText("Shift-Tab leaves ask-every-step mode", "Shift-Tab 可退出逐步确认模式", "Shift-Tab で毎回確認モードを解除"))
  }
  return tips
}

/** Exposed for the test that keeps every tip inside the box. */
export function allTips(): string[] {
  const signals = { ratio: 0, mode: "confirm" as const, staleSessions: 99 }
  return [FIRST(), ...POOL.map(tip => tip()), ...situationalTips(signals).map(tip => tip()), updateTip("0.99.99")]
}

/** The label drawn before the tip, in its own colour, so it can't be taken for typed text. */
export function tipLabel(): string {
  return uiText("tips", "tips", "ヒント")
}
