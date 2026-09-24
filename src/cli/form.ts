/**
 * Setup is a short-lived wizard: it can have one more layer of visual structure than chat,
 * but it doesn't take over the terminal's history.
 * ★ Take the keyboard first, then draw the fields; keys never go into echo, search or
 * history. Menus leave only the confirmed result in the scrollback.
 * Choosing, step headings and input are shared by first launch and /setting — there must
 * never again be two setup entry points that behave differently.
 */
import { Editor, renderBox } from "./editor.ts"
import type { Keyboard } from "./keyboard.ts"
import type { LiveRegion } from "./live.ts"
import { InputCancelled } from "./secret-input.ts"
import { theme } from "./theme.ts"
import { displayWidth, padToWidth, truncateToWidth, wrapToWidth } from "./width.ts"
import { uiText } from "../i18n/index.ts"
export interface Choice { value: string; label: string; description?: string; current?: string }
export interface ChooseOptions { receipt?: boolean; cancelHint?: string }
export interface Form {
  ask(label: string, secret?: boolean): Promise<string>
  say(text: string): void
  choose?(label: string, choices: Choice[], initial?: string, options?: ChooseOptions): Promise<string>
  section?(step: number, total: number, title: string, hint?: string): void
  repaint?(): void
}
export async function choose(form: Form, label: string, choices: Choice[], initial = choices[0]!.value, options?: ChooseOptions): Promise<string> {
  if (form.choose) return form.choose(label, choices, initial, options)
  for (;;) {
    const answer = (await form.ask(`${label}\n${choices.map((c,i) => `${i + 1}. ${c.label}`).join("\n")} [${initial}]`)).trim() || initial
    const match = choices.find(c => c.value === answer) ?? choices[Number(answer) - 1]
    if (match) return match.value
    form.say(uiText("Choose one of the listed options.", "请选择列表中的选项。", "一覧から選択してください。"))
  }
}
export function section(form: Form, step: number, total: number, title: string, hint?: string): void {
  if (form.section) form.section(step, total, title, hint)
  else form.say(`\n${step}/${total}  ${title}${hint ? `\n${hint}` : ""}`)
}
export function terminalForm(keyboard: Keyboard, region: LiveRegion): Form {
  let paint = () => {}
  const form: Form = {
    repaint: () => paint(),
    say: text => region.write(text + "\n"),
    section: (step, total, title, hint) => {
      region.clear()
      region.write(`\n${theme.cyan("─".repeat(Math.max(1, Math.min(54, region.width - 1))))}\n${theme.dim(`alfa  /  ${uiText("SETUP", "配置向导", "セットアップ")}  ${step}/${total}`)}\n${theme.bold(title)}\n${hint ? theme.dim(hint) + "\n" : ""}\n`)
    },
    ask: (label, secret = false) => new Promise((resolve, reject) => {
      const editor = new Editor([])
      paint = () => {
        if (secret) { region.set([theme.cyan("› ") + theme.dim(editor.text ? uiText("Key entered · hidden", "已输入密钥 · 不回显", "入力済み · 非表示") : uiText("Paste key here · hidden", "在这里粘贴密钥 · 不回显", "ここにキーを貼り付け · 非表示"))]); return }
        const box = renderBox({ text: editor.text, cursor: editor.cursor, width: region.width, maxRows: Math.max(1, Math.min(5, region.rows - 4)), framed: region.rows >= 9, style: { border: theme.border, marker: theme.accent, placeholder: theme.muted } })
        region.set(box.lines, box.cursor)
      }
      const finish = (text?: string) => {
        release(); region.clear(); paint = () => {}
        if (text === undefined) { reject(new InputCancelled()); return }
        region.write(theme.green("✓ ") + (secret ? uiText("Credential input received", "凭据输入已接收", "認証情報を受け取りました") : text || uiText("Default", "使用默认值", "デフォルト")) + "\n\n")
        resolve(text)
      }
      const release = keyboard.push(key => {
        if (key.name === "escape" || key.ctrl && ["c", "d"].includes(key.name)) { finish(); return }
        const action = editor.handle(key, Math.max(1, region.width - 2))
        if (action?.type === "submit") finish(action.text)
        else if (key.name === "enter" && !editor.text) finish("")
        else if (["escape", "interrupt", "eof"].includes(action?.type ?? "")) finish()
        else paint()
      })
      region.write(theme.bold(label) + "\n")
      paint()
    }),
    choose: (label, choices, initial, options) => new Promise((resolve, reject) => {
      let selected = Math.max(0, choices.findIndex(c => c.value === initial)), search = ""
      const matches = () => {
        const exact = choices.find(c => c.value.toLowerCase() === search.toLowerCase())
        return exact ? [exact] : choices.filter(c => !search || `${c.value} ${c.label}`.toLowerCase().includes(search.toLowerCase()))
      }
      paint = () => {
        const items = matches()
        selected = Math.max(0, Math.min(selected, items.length - 1))
        const count = Math.max(1, Math.min(10, region.rows - 9)), start = Math.max(0, selected - count + 1)
        const labelWidth = Math.min(Math.max(8, Math.floor(region.width * 0.45)), Math.max(...choices.map(c => displayWidth(c.label))))
        const lines = [theme.border("─".repeat(region.width)), theme.bold("  " + label), ""]
        for (const [i, c] of items.slice(start, start + count).entries()) {
          const active = i + start === selected
          const body = c.current === undefined ? c.label : padToWidth(truncateToWidth(c.label, labelWidth), labelWidth) + "  " + c.current
          const row = truncateToWidth((active ? "› " : "  ") + body, region.width)
          lines.push(active ? theme.selection(padToWidth(row, region.width)) : row)
        }
        if (!items.length) lines.push(uiText("No match · Backspace to edit", "无匹配 · 退格修改", "一致なし · Backspace で編集"))
        const item = items[selected]
        lines.push("")
        if (item?.description && region.rows >= 12) lines.push(...wrapToWidth(item.description, Math.max(1, region.width - 2)).slice(0, 2).map(line => theme.muted("  " + line)))
        lines.push(theme.muted(`  ${items.length ? selected + 1 : 0}/${items.length}` + (search ? `  / ${search}` : "")))
        const cancelHint = options?.cancelHint ?? uiText("Esc back", "Esc 返回", "Esc 戻る")
        lines.push(theme.muted(`${uiText("  ↑↓ select · Enter open · type to search", "  ↑↓ 选择 · Enter 确认 · 输入搜索", "  ↑↓ 選択 · Enter 決定 · 入力で検索")} · ${cancelHint}`))
        region.set(lines.map(line => truncateToWidth(line, region.width)))
      }

      const release = keyboard.push(key => {
        if (key.name === "escape" || key.ctrl && ["c", "d"].includes(key.name)) { release(); region.clear(); paint = () => {}; reject(new InputCancelled()); return }
        const items = matches()
        if (key.name === "up") selected = Math.max(0, selected - 1)
        else if (key.name === "down") selected = Math.min(items.length - 1, selected + 1)
        else if (key.name === "enter") {
          const item = items[selected]
          if (item) { release(); region.clear(); paint = () => {}; if (options?.receipt !== false) region.write(theme.success("✓ ") + label + " · " + item.label + "\n\n"); resolve(item.value); return }
        } else if (key.name === "backspace") { search = search.slice(0, -1); selected = 0 }
        else if (!key.ctrl && !key.meta && (key.name === "paste" || [...key.name].length === 1)) { search += key.name === "paste" ? (key.text ?? "").replace(/[\r\n]/g, "") : key.name; selected = 0 }
        paint()
      })
      paint()
    }),
  }
  return form
}
