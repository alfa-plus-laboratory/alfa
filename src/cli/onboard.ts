/**
 * First run and settings share one step-by-step form; the keyboard is taken over for the
 * whole thing, rather than toggling secret-input echo on and off between questions.
 */
import { configureProvider, providerProtocolChoices } from "./providers.ts"
import { InvalidProviderTypeError, repairProviderType, type ProviderType } from "../config/config.ts"
import { uiText } from "../i18n/index.ts"
import { InputCancelled } from "./secret-input.ts"
import { programName } from "./program.ts"
import { Keyboard } from "./keyboard.ts"
import { LiveRegion } from "./live.ts"
import { choose, terminalForm, type Form } from "./form.ts"
export interface OnboardResult { spec?: string; cancelled?: boolean; hinted?: boolean }
export async function onboard(_reason: "no-model" | "no-credentials"): Promise<OnboardResult> {
  const keyboard = new Keyboard()
  let form: Form | undefined
  let release: (() => void) | undefined
  const region = new LiveRegion({ onResize: () => form?.repaint?.() })
  try {
    if (!keyboard.open()) throw new Error("Cannot open an interactive terminal")
    release = keyboard.push(() => {})
    keyboard.onHangup = () => { region.close(); keyboard.close(); process.exit(130) }
    form = terminalForm(keyboard, region)
    const spec = await configureProvider(form, undefined, { startup: true })
    return spec ? { spec } : { cancelled: true }
  } catch (error) {
    if (error instanceof InputCancelled) return { cancelled: true }
    process.stderr.write(`${error instanceof Error ? error.message : "Configuration failed"}\n`)
    return { hinted: true }
  } finally { region.close(); release?.(); keyboard.close() }
}
export function manualSetupHint(): string { return `Run ${programName()} auth login, or start alfa interactively to configure a provider.\n` }

/**
 * Before the model registry is built, the regular `/settings` can't even start; yet a
 * broken type happens to need just one explicit choice to fix. Reuse the same terminal
 * form to open the Providers repair page directly, and write nothing to disk until the
 * user chooses — this is not a migration of old values, nor does it guess the protocol
 * from the name.
 */
export async function repairInvalidProviderType(error: InvalidProviderTypeError): Promise<boolean> {
  const keyboard = new Keyboard()
  let form: Form | undefined
  let release: (() => void) | undefined
  const region = new LiveRegion({ onResize: () => form?.repaint?.() })
  try {
    if (!keyboard.open()) throw new Error("Cannot open an interactive terminal")
    release = keyboard.push(() => {})
    keyboard.onHangup = () => { region.close(); keyboard.close(); process.exit(130) }
    form = terminalForm(keyboard, region)
    form.say(uiText(
      `Configuration error:\n${error.message}\n\nOpening Settings → Providers so you can choose the protocol.`,
      `配置有误：\n${error.message}\n\n正在打开“设置 → 厂商与凭据”，请选择正确协议。`,
      `設定エラー:\n${error.message}\n\n設定 → 接続と認証情報を開きます。正しいプロトコルを選んでください。`,
    ))
    const type = await choose(form, uiText(
      `Protocol for ${error.providerID}`,
      `${error.providerID} 使用的协议`,
      `${error.providerID} のプロトコル`,
    ), providerProtocolChoices()) as ProviderType
    repairProviderType(error.providerID, type, error.path)
    form.say(uiText("Saved. Continuing startup…", "已保存，继续启动…", "保存しました。起動を続けます…"))
    return true
  } catch (caught) {
    if (caught instanceof InputCancelled) return false
    process.stderr.write(`${caught instanceof Error ? caught.message : "Configuration repair failed"}\n`)
    return false
  } finally { region.close(); release?.(); keyboard.close() }
}
