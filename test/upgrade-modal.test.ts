/**
 * 升级浮层的内容。
 *
 * 守的是那条进度条的算术,以及**每一档状态都得说出点什么** —— 一个停在
 * "downloading" 上不动的框,和用户抱怨的那个"我不知道它在下载"是同一个毛病,
 * 只是换了个地方发生。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { renderUpgrade, type UpgradeState } from "../src/tui/panes/upgrade.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { currentInterfaceLanguage, setInterfaceLanguage } from "../src/i18n/index.ts"

// 颜色码会把断言变成一堆转义序列,这里只关心字
setColorEnabled(false)
const started = currentInterfaceLanguage()
setInterfaceLanguage("en")
afterAll(() => setInterfaceLanguage(started))

const body = (state: UpgradeState, width = 60) => renderUpgrade(state, width).join("\n")

describe("升级浮层", () => {
  test("查版本那一档:写着当前版本和在干什么", () => {
    const text = body({ from: "0.4.1", phase: "checking" })
    expect(text).toContain("0.4.1")
    expect(text.toLowerCase()).toContain("checking")
  })

  test("★ 下载中要有进度条、百分比和 MB —— 这三样是这个浮层存在的全部理由", () => {
    const text = body({ from: "0.4.1", to: "0.4.2", phase: "downloading", received: 48_000_000, total: 96_000_000 })
    expect(text).toContain("0.4.2")
    expect(text).toContain("50%")
    expect(text).toContain("45.8MB / 91.6MB")
    expect(text).toContain("█")
    // 跑着的时候必须写出唯一的出口:这个框独占按键
    expect(text).toContain("esc")
  })

  test("★ 拿不到总大小就不画假进度条 —— 一个不动的条比没有条更像卡住了", () => {
    const text = body({ from: "0.4.1", phase: "downloading", received: 12_582_912 })
    expect(text).toContain("12.0MB")
    expect(text).not.toContain("█")
    expect(text).not.toContain("%")
  })

  test("进度条填充跟着比例走", () => {
    const empty = body({ from: "0.4.1", phase: "downloading", received: 0, total: 100 })
    const full = body({ from: "0.4.1", phase: "downloading", received: 100, total: 100 })
    expect(empty).toContain("  0%")
    expect(full).toContain("100%")
    expect((full.match(/█/g) ?? []).length).toBeGreaterThan((empty.match(/█/g) ?? []).length)
  })

  test("校验和安装各自是一档 —— 用户要看得出它已经不在下载了", () => {
    expect(body({ from: "0.4.1", phase: "verifying" }).toLowerCase()).toContain("verif")
    expect(body({ from: "0.4.1", phase: "installing" }).toLowerCase()).toContain("install")
  })

  test("★ 装完那句必须写「重启」 —— 换掉的是磁盘上那个文件,跑着的还是老的", () => {
    const text = body({ from: "0.4.1", to: "0.4.2", phase: "done", detail: "0.4.2" })
    expect(text).toContain("0.4.1 → 0.4.2")
    expect(text.toLowerCase()).toContain("restart")
  })

  test("取消和失败是两句话 —— 报成失败的话用户会去找一个不存在的错误", () => {
    expect(body({ from: "0.4.1", phase: "cancelled" }).toLowerCase()).toContain("cancel")
    expect(body({ from: "0.4.1", phase: "failed", detail: "checksum mismatch" })).toContain("checksum mismatch")
  })

  test("结束之后不再提 esc,改说怎么关掉", () => {
    const running = body({ from: "0.4.1", phase: "downloading", received: 1, total: 2 })
    const over = body({ from: "0.4.1", phase: "done", detail: "0.4.2" })
    expect(running).toContain("esc cancel")
    expect(over).toContain("close")
  })

  test("窄屏也画得出来,不炸", () => {
    const text = body({ from: "0.4.1", phase: "downloading", received: 5, total: 10 }, 20)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain("50%")
  })
})
