/**
 * What `/sandbox` says back.
 *
 * ★ Two facts: what the user has set, and whether it can take effect. Auto used to
 *   override the setting, and `/sandbox on` in auto answered "OS sandbox: off", which
 *   users read as the switch not working. Auto no longer overrides it (see the header of
 *   security/access.ts), so the setting is in force in every mode and the only remaining
 *   gap between the two is a missing backend.
 */
import { uiText } from "../i18n/index.ts"

export interface SandboxState {
  /** The saved preference (`sandbox` in config.json) */
  preference: boolean
  /** Whether shell isolation applies to the next command */
  active: boolean
  backend: "seatbelt" | "bubblewrap" | "unavailable"
  /** bubblewrap is installed but can't run here (security/sandbox.ts bwrapBlocked) */
  blocked?: string
}

/** Installed but refused by the kernel/AppArmor: a different fix from "install one" */
function blockedText(detail: string): string {
  return uiText(
    `bubblewrap is installed but can't create a user namespace here (${detail}). On Ubuntu 23.10 and later AppArmor restricts this: give bwrap an AppArmor profile that allows userns (ask alfa how), or /sandbox off.`,
    `已安装 bubblewrap，但本机不允许它创建 user namespace（${detail}）。Ubuntu 23.10 及以后的 AppArmor 会限制这一点：给 bwrap 加一个允许 userns 的 AppArmor 配置（可以直接问 alfa 怎么做），或执行 /sandbox off。`,
    `bubblewrap は導入済みですが、ここでは user namespace を作成できません（${detail}）。Ubuntu 23.10 以降は AppArmor が制限しています。userns を許可する AppArmor プロファイルを bwrap に追加するか（手順は alfa に聞けます）、/sandbox off を実行してください。`,
  )
}

/** Off is the default and needs no startup banner. An opt-in must remain visible even
 * when the backend is unavailable, so saved and effective state cannot silently diverge
 * in the user's view. */
export function sandboxStartupMessage(state: SandboxState): string | undefined {
  if (!state.preference) return undefined
  if (state.backend === "unavailable" && state.blocked) return uiText("OS sandbox: enabled (experimental), but shell commands are blocked: ", "系统沙盒：已启用（功能不完整），但 Shell 命令会被阻止：", "OS サンドボックス：オン（実験的機能）ですが、Shell は実行できません：") + blockedText(state.blocked)
  if (state.backend === "unavailable") return uiText(
    "OS sandbox: enabled (experimental), but no backend is available; shell commands are blocked. Manage it in Settings.",
    "系统沙盒：已启用（功能不完整），但本机无可用后端，Shell 命令会被阻止。可在设置中调整。",
    "OS サンドボックス：オン（実験的機能）ですが、バックエンドがなく Shell を実行できません。設定で変更できます。",
  )
  return uiText(
    `OS sandbox: enabled (${state.backend}; experimental), in every permission mode including auto. Manage it in Settings.`,
    `系统沙盒：已启用（${state.backend}，功能不完整），所有权限模式都生效，包括 auto。可在设置中调整。`,
    `OS サンドボックス：オン（${state.backend}、実験的機能）。auto を含むすべての権限モードで有効です。設定で変更できます。`,
  )
}

export function sandboxMessage(state: SandboxState): string {
  if (!state.active) {
    return uiText(
      "OS sandbox: off. Shell commands run with host filesystem access; tool approvals and file-path authorization remain active.",
      "系统沙盒：关闭。Shell 命令可访问宿主文件系统；工具授权和文件路径授权仍然有效。",
      "OS サンドボックス：オフ。Shell コマンドはホストのファイルシステムへアクセスできます。ツールとファイルパスの許可は引き続き有効です。",
    )
  }
  if (state.backend === "unavailable" && state.blocked) {
    return uiText("OS sandbox: on, but shell commands are refused. ", "系统沙盒：开启，但 Shell 命令会被拒绝。", "OS サンドボックス：オンですが、Shell コマンドは拒否されます。") + blockedText(state.blocked)
  }
  if (state.backend === "unavailable") {
    return uiText(
      "OS sandbox: on, but this system has no supported backend (macOS sandbox-exec or Linux bwrap), so shell commands are refused. Install one, or /sandbox off.",
      "系统沙盒：开启，但本机没有可用的后端（macOS 的 sandbox-exec 或 Linux 的 bwrap），因此 Shell 命令会被拒绝。请安装后端，或执行 /sandbox off。",
      "OS サンドボックス：オンですが、対応するバックエンド（macOS の sandbox-exec または Linux の bwrap）がないため Shell コマンドは拒否されます。導入するか /sandbox off を実行してください。",
    )
  }
  return uiText(
    `OS sandbox: on (${state.backend}). Shell commands and checks can only reach the workspace and granted paths; tool approvals and file-path authorization remain active.`,
    `系统沙盒：开启（${state.backend}）。Shell 命令和检查只能访问工作区和已授权的路径；工具授权和文件路径授权仍然有效。`,
    `OS サンドボックス：オン（${state.backend}）。Shell コマンドとチェックはワークスペースと許可済みパスのみにアクセスできます。ツールとファイルパスの許可は引き続き有効です。`,
  )
}
