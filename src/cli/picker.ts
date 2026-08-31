/**
 * 启动时的会话挑选(`--resume`)。画在底部活动区里。
 *
 * ── 为什么不复用全屏那个浮层 ──
 * 这一步发生在**进全屏之前**:`--plain`、窄到画不出三栏、甚至只是想看一眼有
 * 哪些会话然后退出 —— 这些路径下都还没有合成器。活动区是这个阶段唯一能重画
 * 的地方,而它本来就为「一块会自己重画的底部内容」而生。
 *
 * 两边共用 sessions.ts 里的行和按键,所以差别只在"字往哪送"。
 *
 * ── 没有 TTY 就直接回没选 ──
 * 管道里没有人可以挑。这时候退回"开一场新的"是对的:一个跑在脚本里的
 * alfa 不该因为读不到按键就挂在那里等。
 */
import type { Keyboard } from "./keyboard.ts"
import type { Key } from "./keys.ts"
import type { LiveRegion } from "./live.ts"
import type { SessionInfo } from "../session/store.ts"
import { pickKey, renderList } from "./sessions.ts"

export interface PickerDeps {
  sessions: SessionInfo[]
  keyboard?: Keyboard
  region: LiveRegion
  /** 相对时间的基准。一屏之内所有行用同一个"现在" */
  now?: number
  /** 已经在里面的那一场(`/resume` 用;启动时没有) */
  currentID?: string
}

/** 挑一场。用户取消、没有 TTY、列表为空都返回 undefined。 */
export async function pickSession(deps: PickerDeps): Promise<SessionInfo | undefined> {
  if (deps.sessions.length === 0 || !deps.keyboard?.usable || !deps.region.active) return undefined

  const now = deps.now ?? Date.now()
  let selected = 0

  const paint = () => {
    deps.region.set(
      renderList(deps.sessions, {
        selected,
        width: deps.region.width,
        // 活动区最多占半屏:挑选界面把上面的输出全顶掉,等于"我刚才看的东西没了"
        height: Math.max(3, Math.floor(deps.region.rows / 2) - 3),
        now,
        ...(deps.currentID ? { currentID: deps.currentID } : {}),
      }),
    )
  }

  return new Promise<SessionInfo | undefined>((resolve) => {
    let settled = false
    let release: (() => void) | undefined

    const finish = (choice: SessionInfo | undefined) => {
      if (settled) return
      settled = true
      release?.()
      // 挑完就把列表擦掉:它是一次性的问题,留在屏幕上会和后面的会话内容混在一起
      deps.region.clear()
      resolve(choice)
    }

    const onKey = (key: Key) => {
      const result = pickKey(key)
      switch (result.kind) {
        case "move":
          selected = clamp(selected + result.delta, deps.sessions.length)
          return paint()
        case "accept":
          return finish(deps.sessions[selected])
        case "cancel":
          return finish(undefined)
        case "pass":
          return
      }
    }

    release = deps.keyboard!.push(onKey)
    // raw 模式拿不到就别硬来:逐行读会把用户的下一句话当成选择
    if (!deps.keyboard!.attached) return finish(undefined)
    paint()
  })
}

function clamp(next: number, length: number): number {
  return Math.max(0, Math.min(length - 1, next))
}
