/**
 * `/setting` 那一屏。**只管画和认键**,一条设置都不认识。
 *
 * ── 为什么要有这么一屏 ──
 * 到今天为止,每一项设置都有一条自己的斜杠命令,而那意味着两件事:
 *   · 想改一样东西,先得知道它叫什么。`/agentflow`、`/check`、`/think`、
 *     `/trust`、`/view` —— 记不住的人只能一条条 `/help` 翻过去,而 help 是
 *     一大段文字,不是一张清单。
 *   · **看不到全貌**。「我这个仓库现在到底是什么状态」这个问题,今天要敲
 *     六七条命令才拼得出来,而它恰恰是用户最常问自己的那一个。
 *
 * 一屏之后这两件事都是免费的:每一项都写着现在是什么,光标扫过去就改。
 * 斜杠命令一条不撤 —— 打字快的人照旧最快,而这一屏是给"我知道有这么个东西
 * 但不记得叫什么"的时候用的。
 *
 * ── 页是宿主给的,不是这里写死的 ──
 * 这个模块拿到的是一棵已经算好的树(SettingsPage),它不知道什么是 agentflow、
 * 什么是 provider。真值源在 cli/settings.ts —— 那边才认识 config、认识注册表。
 * 分开是因为**这一屏每一帧都要重算**:值必须是现取的,而"现取"这件事只有
 * 宿主做得到。
 *
 * ── 密钥那一格 ──
 * 有一种行是**要打字**的(粘一个 API key 进来)。它在这里只是 kind === "secret",
 * 打的字由 App 管着(见 tui/app.ts 的 settings.typed),画出来永远是圆点 ——
 * 这个程序里任何时候都不显示完整密钥,这一条没有例外(见 config/auth.ts)。
 */
import type { Key } from "../../cli/keys.ts"
import { theme } from "../../cli/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../../cli/width.ts"
import { t } from "../../i18n/index.ts"

export type SettingKind =
  /** 左右键在几个值之间转 */
  | "choice"
  /** 回车进下一页 */
  | "page"
  /** 回车就干活(换模型、删一个凭据、现在检查一遍) */
  | "action"
  /** 回车开始打字,打完回车提交。画出来是圆点 */
  | "secret"

export interface SettingChoice {
  value: string
  label: string
}

export interface SettingRow {
  id: string
  label: string
  /**
   * 右边那一格现在是什么。
   *
   * ★ choice 行存的是**值**(`session`),画出来的是它在 choices 里对应的
   *   那条 label(`conversation`)。存 label 的话左右键就得反查一遍文字,
   *   而两处一旦不一致,按左右键会跳到一个用户没选过的值上。
   */
  value: string
  /** 选中时底下那条说明 */
  hint: string
  kind: SettingKind
  /** kind === "choice" 时轮着换的那几个值。当前值就是 value */
  choices?: SettingChoice[]
  tone?: "warn" | "good" | "bad"
  /**
   * 看得见但动不了。
   *
   * ★ 不是"藏起来"。环境变量压着的那个模型、没有 key 的那个 provider ——
   *   把它们从清单里抠掉的话,用户会以为自己没配过;写在这儿并且说清为什么,
   *   才回答得了"我改了怎么不生效"。
   */
  locked?: boolean
}

export interface SettingSection {
  title: string
  rows: SettingRow[]
}

export interface SettingsPage {
  id: string
  title: string
  sections: SettingSection[]
  /** 一条都没有时写这句。空白的一页比一句"这里还没有东西"难懂得多 */
  empty?: string
  /**
   * 刚翻到这一页时光标落在第几条。缺省第一条。
   *
   * ★ 换模型那一页要用它落在**当前那个**上。清单里十几行长得差不多的模型名,
   *   光标停在第一行的话,用户第一件事是先找自己在哪 —— 而那正是这一页
   *   已经用 `●` 标出来的东西。让光标停在那儿,他要做的就只剩上下几格。
   */
  selected?: number
}

/** 选完一条之后宿主要说的话 */
export interface SettingsResult {
  /** 状态行上那句回执 */
  note?: string
  /** 出错了。红的,而且这一屏不关 */
  error?: string
  /** 跳到另一页(换完模型回到上一层就是它) */
  back?: boolean
}

export interface SettingsSource {
  page(id: string): SettingsPage | undefined
  /**
   * 动了一条。
   *
   * @param value choice 行是新值,action 行是它自己的 id,secret 行是打的那串字。
   */
  choose(pageID: string, rowID: string, value: string): SettingsResult
}

/** 左边标签那一栏多宽。四个字的标签和二十个字的标签要对齐在同一列上 */
const LABEL_WIDTH = 30

export function flatRows(page: SettingsPage): SettingRow[] {
  return page.sections.flatMap((section) => section.rows)
}

/**
 * 一页画成一屏。
 *
 * @param selected 第几条**可选的行**(分节标题不算)
 * @param typed 密钥行正在打的字。undefined = 没在打
 */
export function renderSettings(
  page: SettingsPage,
  options: { selected: number; width: number; height: number; typed?: string },
): string[] {
  const width = Math.max(24, options.width)
  const rows = flatRows(page)
  /**
   * 值那一栏从第几列起。
   *
   * ★ 整页都没有值可写的时候(换模型那一页、一页动作),**标签占满整行**。
   *   固定在 30 列的话,`anthropic/claude-sonnet-4-5` 会被截成
   *   `anthropic/claude-sonnet-4…` —— 而那一页存在的全部意义就是让人认出
   *   自己要哪一个,末尾那几位恰恰是两代模型唯一的差别。
   */
  const valueColumn = rows.some((row) => displayWidth(row.value) > 0 || row.kind === "secret") ? LABEL_WIDTH : 0
  const body: string[] = []
  /** 每一条可选行画在 body 的第几行 —— 滚动要靠它把选中项框进窗口 */
  const at: number[] = []

  if (rows.length === 0) {
    body.push("", theme.dim(" " + truncateToWidth(page.empty ?? "", width - 2)))
  }
  for (const [index, section] of page.sections.entries()) {
    if (section.rows.length === 0) continue
    if (index > 0) body.push("")
    if (section.title.length > 0) body.push(sectionHead(section.title, width))
    for (const row of section.rows) {
      at.push(body.length)
      const picked = rows.indexOf(row) === options.selected
      body.push(rowLine(row, width, picked, picked ? options.typed : undefined, valueColumn))
    }
  }

  // 底下那三行是**固定的**:一条线、选中项的说明、键位。说明跟着高亮走而
  // 位置不动 —— 位置也跟着走的话,每按一次上下整块都要重读一遍
  const footer = [
    theme.dim("─".repeat(Math.max(0, width))),
    theme.dim(" " + truncateToWidth(hintOf(rows[options.selected], options.typed), width - 2)),
    theme.dim(" " + truncateToWidth(keyHint(rows, options.typed), width - 2)),
  ]
  const room = Math.max(1, options.height - footer.length)

  // 选中项框进窗口。整页装得下时 from 恒为 0 —— 不做无谓的滚动
  const anchor = at[options.selected] ?? 0
  let from = 0
  if (body.length > room) from = Math.max(0, Math.min(anchor - Math.floor(room / 2), body.length - room))
  const shown = body.slice(from, from + room)
  while (shown.length < room) shown.push("")
  return [...shown, ...footer]
}

/**
 * 底下那行键位提示。
 *
 * 一页里一条能左右切的都没有(换模型、删密钥)时不写「←→ change」——
 * 一条按了没反应的提示,比不写更让人怀疑是不是自己按错了。
 */
function keyHint(rows: SettingRow[], typed: string | undefined): string {
  if (typed !== undefined) return t.settingsSecretKeys
  return rows.some((row) => row.kind === "choice") ? t.settingsKeys : t.settingsPickKeys
}

function sectionHead(title: string, width: number): string {
  const head = ` ${title} `
  return theme.dim(theme.bold(head)) + theme.dim("─".repeat(Math.max(0, width - displayWidth(head) - 1)))
}

function hintOf(row: SettingRow | undefined, typed: string | undefined): string {
  if (typed !== undefined) return t.settingsSecretHint
  return row?.hint ?? ""
}

function rowLine(
  row: SettingRow,
  width: number,
  selected: boolean,
  typed: string | undefined,
  valueColumn: number,
): string {
  const mark = selected ? theme.cyan("▸") : " "
  const labelRoom = valueColumn > 0 ? valueColumn - 2 : Math.max(4, width - 6)
  const label = padToWidth(truncateToWidth(row.label, labelRoom), labelRoom)
  // ★ 打字的时候画的是圆点,不是字。这个程序任何时候都不显示完整密钥,
  //   而"就显示一下让他核对"正是那条规矩要挡的东西(见 config/auth.ts)
  const label_ = row.choices?.find((one) => one.value === row.value)?.label ?? row.value
  const shown = typed !== undefined ? "•".repeat(Math.min(typed.length, 32)) + theme.cyan("▌") : label_
  const paint = row.locked
    ? theme.dim
    : row.tone === "bad"
      ? theme.red
      : row.tone === "warn"
        ? theme.yellow
        : row.tone === "good"
          ? theme.green
          : selected
            ? theme.bold
            : (text: string) => text
  // 能进下一层的那几条右端画一个 `›`。方括号是"能点",这个是"还有一层"
  const tail = row.kind === "page" ? theme.dim(" ›") : ""
  const room = Math.max(0, width - labelRoom - 4 - displayWidth(tail))
  const value = truncateToWidth(shown, room)
  const line =
    ` ${mark} ` + (selected ? theme.bold(label) : theme.dim(label)) + paint(value) + " ".repeat(Math.max(0, room - displayWidth(value))) + tail
  return truncateToWidth(line, width)
}

export type SettingsKeyResult =
  | { kind: "move"; delta: number }
  | { kind: "cycle"; delta: number }
  | { kind: "enter" }
  | { kind: "back" }
  | { kind: "close" }
  | { kind: "type"; text: string }
  | { kind: "erase" }
  | { kind: "submit" }
  | { kind: "pass" }

/**
 * 按键。**打字的时候是另一套** —— 那时候 `q` 是一个字符,不是"关掉这一屏"。
 *
 * ⚠ 这就是这一屏没有 `q` 关闭键的原因(复制单子那边有)。一屏里只要存在
 *   一个会收字符的格子,任何"某个字母 = 命令"的约定都会在那个格子里咬人,
 *   而"我打的字被当成命令了"是最难自己看出来的一种 bug。
 */
export function settingsKey(key: Key, options: { editing: boolean }): SettingsKeyResult {
  if (options.editing) {
    if (key.name === "escape") return { kind: "back" }
    if (key.ctrl && (key.name === "c" || key.name === "d")) return { kind: "back" }
    if (key.name === "enter" || key.name === "return") return { kind: "submit" }
    if (key.name === "backspace") return { kind: "erase" }
    // 粘贴块整段收下 —— 一个 API key 是粘进来的,没人会手打
    if (key.name === "paste") return { kind: "type", text: key.text ?? "" }
    if (!key.ctrl && !key.meta && [...key.name].length === 1) return { kind: "type", text: key.name }
    return { kind: "pass" }
  }

  if (key.ctrl && (key.name === "c" || key.name === "d")) return { kind: "close" }
  switch (key.name) {
    case "escape":
      return { kind: "back" }
    case "up":
      return { kind: "move", delta: -1 }
    case "down":
      return { kind: "move", delta: 1 }
    case "pageup":
      return { kind: "move", delta: -8 }
    case "pagedown":
      return { kind: "move", delta: 8 }
    case "left":
      return { kind: "cycle", delta: -1 }
    case "right":
      return { kind: "cycle", delta: 1 }
    case "enter":
    case "return":
    case "space":
      return { kind: "enter" }
    case "backspace":
      return { kind: "back" }
    default:
      return { kind: "pass" }
  }
}

/** 一条 choice 行按左右键之后的新值。转圈 —— 三个值的开关不该有"到头了" */
export function cycleValue(row: SettingRow, delta: number): string | undefined {
  const choices = row.choices ?? []
  if (choices.length === 0) return undefined
  const at = choices.findIndex((one) => one.value === row.value)
  const next = (((at === -1 ? 0 : at) + delta) % choices.length + choices.length) % choices.length
  return choices[next]?.value
}
