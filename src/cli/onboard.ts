/**
 * 第一次跑的引导。
 *
 * ── 它替掉的是什么 ──
 * 之前没配模型时,程序在 stderr 上写一行 "No model configured. Run: alfa auth
 * login" 然后 exit 1。那句话每个字都对,而它把一个**刚装完、正满怀期待敲下命令**
 * 的人原地劝退:他得先退出、去读一条命令的用法、猜自己该填什么 type、再回来。
 * 第一次运行是这个程序唯一一次能假设"用户什么都还不知道"的时刻,把它用在
 * 打印一条错误上是浪费。
 *
 * ── 三条路,顺序就是推荐顺序 ──
 *   1. 订阅链接(**预留,还没上线**,见 SUBSCRIPTION)
 *   2. 贴一把 API key —— 现在唯一走得通的
 *   3. 先不弄 —— 打印手动办法,干净地退出
 *
 * ── 为什么第一条明写着"还没上线"而不是先藏起来 ──
 * 藏起来的话,等它上线那天,老用户不会知道有这条路。写出来但拦住,代价是
 * 一行灰字;而**一个点了没反应的入口**比没有入口更糟 —— 那是唯一一种会让人
 * 怀疑整个程序是不是半成品的交互。所以它不可选中之外还带一句"现在请走第 2 条"。
 *
 * ── 为什么引导完直接进主界面,而不是"配好了,请重新运行" ──
 * 他要的从来不是配置,是开始干活。
 *
 * ── 为什么这里是英文而不走 i18n ──
 * 它接下来交棒给 cli/auth.ts 的那几个提示(API key、Base URL),那一整套是英文。
 * 引导说日文、下一句提示说英文,比全英文糟。要改就两边一起改,不在这里开半个头。
 */
import { loadAuth, setCredential } from "../config/auth.ts"
import { configPath, loadConfig, saveConfig, type ProviderType } from "../config/config.ts"
import { authPath } from "../config/auth.ts"
import { buildRegistry } from "../llm/setup.ts"
import { discoverModels, type DiscoverResult } from "../llm/discover.ts"
import { verifyModel } from "./auth.ts"
import { programName } from "./program.ts"
import { InputCancelled, readLine, readSecret } from "./secret-input.ts"
import { theme } from "./theme.ts"

/**
 * 订阅制登录:打开一个 URL,在浏览器里登录/订阅,回来拿到一把密钥。
 *
 * ★ **还没上线**。这里留的是位置,不是实现 —— 落地时要做的是:换掉这个常量、
 *   实现 subscriptionLogin()(开浏览器 → 轮询/回调拿 key → 走 saveProvider 的
 *   同一条落盘路径),别的一个字不用动。密钥怎么存、怎么验、写在哪,这条路和
 *   贴 key 那条**必须完全一样**:两套存法迟早会出现"从 A 登进来的人 B 认不出"。
 */
type SubscriptionLogin = () => Promise<OnboardResult>

const SUBSCRIPTION: { available: boolean; login?: SubscriptionLogin } = { available: false }

/** 引导认得的几家。顺序就是列出来的顺序 */
const VENDORS: Array<{
  key: string
  label: string
  type: ProviderType
  /** provider id。用户可以改,但默认值要能直接回车 */
  id: string
  /** 官方端点不用填 baseURL */
  baseURL?: string
  /** 默认模型。填一个该家最稳的,用户回车就过 */
  model: string
  /** 去哪儿拿 key */
  keysAt: string
}> = [
  {
    key: "1",
    label: "Anthropic",
    type: "anthropic",
    id: "anthropic",
    model: "claude-sonnet-4-5",
    keysAt: "https://console.anthropic.com/settings/keys",
  },
  {
    key: "2",
    label: "OpenAI",
    type: "openai-compat",
    id: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keysAt: "https://platform.openai.com/api-keys",
  },
  {
    key: "3",
    label: "Something else",
    type: "openai-compat",
    id: "",
    model: "",
    keysAt: "",
  },
]

export interface OnboardResult {
  /** 配好了,用这个 spec 接着启动 */
  spec?: string
  /** 用户自己退出的(选了"先不弄"、Ctrl-C)。不是错误 */
  cancelled?: boolean
  /**
   * 已经在屏幕上说过"接下来怎么办"了,调用方别再印一遍。
   *
   * 同一句提示出现两遍,读的人会以为是两条不同的建议,回头去找区别在哪 ——
   * 而这一刻他本来就已经在处理一个失败了。
   */
  hinted?: boolean
}

/**
 * 跑一次引导。**只在交互式终端里调** —— 管道里没人可以问,那条路照旧打印
 * 一句话然后退出(见 cli/main.ts)。
 */
export async function onboard(reason: "no-model" | "no-credentials"): Promise<OnboardResult> {
  const out = process.stdout
  const me = programName()

  out.write("\n" + theme.bold(`  Welcome to ${me}.`) + "\n")
  out.write(
    theme.dim(
      reason === "no-model"
        ? "  It needs one model provider before it can do anything. This takes about a minute.\n\n"
        : "  A model is configured, but there is no key for it yet. Let's fix that.\n\n",
    ),
  )

  try {
    while (true) {
      const choice = await menu()
      if (choice === "subscription") {
        if (SUBSCRIPTION.available && SUBSCRIPTION.login) return await SUBSCRIPTION.login()
        // 拦住,而且必须说清"现在该走哪条" —— 一个只会说"暂不可用"的入口
        // 会把人卡在原地
        out.write(
          theme.yellow("\n  Not available yet.") +
            theme.dim(" A subscription sign-in will open your browser and hand back a key.\n") +
            theme.dim("  Until then, choose 2 and paste a key from your own provider account.\n\n"),
        )
        continue
      }
      if (choice === "later") return { cancelled: true }
      return await pasteKey()
    }
  } catch (error) {
    if (error instanceof InputCancelled) return { cancelled: true }
    throw error
  }
}

async function menu(): Promise<"subscription" | "key" | "later"> {
  const out = process.stdout
  // 第一条画成灰的:它不是"你可以选这个",而是"这里将来会有一条更省事的路"
  out.write(
    (SUBSCRIPTION.available ? theme.bold("  1  ") + "Sign in with a subscription link" : theme.dim("  1  ") +
      theme.dim("Sign in with a subscription link") +
      theme.dim("  (not available yet)")) +
      "\n" +
      theme.bold("  2  ") +
      "Paste an API key" +
      theme.dim("  (Anthropic, OpenAI, or any compatible endpoint)") +
      "\n" +
      theme.dim("  3  ") +
      "Not now" +
      theme.dim("  (shows how to do it later)") +
      "\n\n",
  )
  const answer = (await readLine(theme.bold("  Choose") + theme.dim(" [2]: "))).trim()
  if (answer === "1") return "subscription"
  if (answer === "3") return "later"
  return "key" // 空回车 = 推荐项。第一次跑的人最不该被"你没选对"挡一下
}

async function pasteKey(): Promise<OnboardResult> {
  const out = process.stdout

  out.write("\n")
  for (const vendor of VENDORS) out.write(theme.bold(`  ${vendor.key}  `) + vendor.label + "\n")
  out.write("\n")
  const picked = (await readLine(theme.bold("  Provider") + theme.dim(" [1]: "))).trim() || "1"
  const vendor = VENDORS.find((v) => v.key === picked) ?? VENDORS[0]!

  // ── 自定义那条要多问两句 ──
  const custom = vendor.id.length === 0
  const id = custom
    ? (await readLine(theme.bold("  Name for it") + theme.dim(" (letters, digits, dash): "))).trim()
    : vendor.id
  if (!id) return fail("a name is required")
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return fail(`invalid name "${id}" — letters, digits, dot, dash or underscore`)

  const type: ProviderType = custom
    ? ((await readLine(theme.bold("  API flavor") + theme.dim(" [anthropic | openai-compat] (default openai-compat): ")))
        .trim() as ProviderType) || "openai-compat"
    : vendor.type
  if (type !== "anthropic" && type !== "openai-compat") return fail(`unknown flavor "${type}"`)

  const baseURL = custom
    ? (await readLine(theme.bold("  Base URL") + theme.dim(": "))).trim()
    : (vendor.baseURL ?? "")

  if (vendor.keysAt) out.write(theme.dim(`\n  Get a key at ${vendor.keysAt}\n`))
  // 唯一一处读密钥。不回显、不回读、不进 shell history(见 cli/secret-input.ts)
  const apiKey = (await readSecret(theme.bold("  API key") + theme.dim(" (input hidden): "))).trim()
  if (!apiKey) return fail("an API key is required")
  if (/\s/.test(apiKey)) return fail("the key contains whitespace — check for a stray copy/paste artifact")

  // ── 先问端点有哪些模型,再让他挑 ──
  //
  // 顺序是有讲究的:发现放在**问模型名之前**,于是他看到的是一份真实清单,
  // 而不是一个要他去翻文档才填得出的空格。问不到就退回手填,少的只是便利
  const found = await discover(out, { type, apiKey, ...(baseURL ? { baseURL } : {}) })
  const suggested = found?.models.includes(vendor.model) ? vendor.model : (found?.models[0] ?? vendor.model)

  const model =
    (await readLine(theme.bold("  Model") + theme.dim(suggested ? ` [${suggested}]: ` : ": "))).trim() || suggested
  if (!model) return fail("a model id is required")

  // ── 窗口 ──
  //
  // 只在**我们确实不知道**的时候问。Anthropic 官方那几个查表就有,而一个
  // 明明能查到却还要人回答的问题,是在拿用户的时间换我们的省事。
  //
  // 不知道又不问的话,兜底是 100 万 —— 一个 20 万的模型按 100 万算,压缩永远
  // 不触发,表现是聊到一半突然被 provider 拒收(而他会以为是这个程序坏了)。
  const limit = knownLimit(type, baseURL, model) ? undefined : await askWindow(model)

  // ── 落盘。config 先写:它没有密钥,写坏了也不泄露什么 ──
  const spec = `${id}/${model}`
  const config = loadConfig()
  const models: Record<string, { limit?: { context: number; output: number } }> = {}
  for (const name of found?.models ?? []) models[name] = {}
  // 当面问出来的那个窗口挂在**这个模型**上,不挂在 provider 上:同一家的两代
  // 模型窗口经常差好几倍,而他刚才回答的只是眼前这一个
  if (limit) models[model] = { limit }
  config.providers = {
    ...config.providers,
    [id]: {
      type,
      ...(baseURL ? { baseURL } : {}),
      ...(Object.keys(models).length > 0 ? { models } : {}),
    },
  }
  config.model = spec
  saveConfig(config)
  setCredential(id, { apiKey })

  out.write("\n" + theme.green(`  ✓ saved ${id}`) + "\n")
  out.write(theme.dim(`    settings    ${configPath()}\n`))
  out.write(theme.dim(`    credential  ${authPath()}  (mode 600)\n`))

  // ★ 存下来不等于能用。401(key 错)和 404(baseURL 少了 /v1)在这一刻花两秒
  //   就能查出来,而放过去的话,用户看到的是他第一句话之后的一条报错 ——
  //   那时候他会以为是这个程序坏了
  const ok = await verifyModel(spec, buildRegistry({ config, auth: loadAuth() }))
  if (!ok) {
    process.stdout.write(
      theme.dim(`\n  The key was saved. Fix it and try again with: ${programName()} auth login --provider ${id}\n`),
    )
    return { cancelled: true, hinted: true }
  }

  out.write(theme.dim("\n  Starting…\n"))
  return { spec }
}

/**
 * 问一次端点有哪些模型,顺带把结果说给用户听。
 *
 * 说出来是必要的:这一步会停顿一两秒(一次网络请求),屏幕上不出声的话,
 * 用户不知道程序是在干活还是卡住了。砍掉和截断的条数也一并写出来 —— 一份
 * 安静地少了几行的清单,比一份带噪音的更难查。
 */
async function discover(
  out: NodeJS.WriteStream,
  input: { type: ProviderType; apiKey: string; baseURL?: string },
): Promise<DiscoverResult | undefined> {
  out.write(theme.dim("\n  Asking the endpoint which models it has … "))
  const found = await discoverModels(input)
  if (!found) {
    // 问不到完全正常(端点没实现 /models、返回了个登录页)。它不是失败,
    // 所以不画成红的,而且必须说清"那你可以自己填"
    out.write(theme.dim("not available\n"))
    out.write(theme.dim("  You can list them later under providers.<id>.models in the config.\n"))
    return undefined
  }
  const extra = [
    found.dropped > 0 ? `${found.dropped} non-chat skipped` : "",
    found.truncated > 0 ? `${found.truncated} more not listed` : "",
  ].filter(Boolean)
  out.write(
    theme.green(`${found.models.length} found`) + theme.dim(extra.length > 0 ? ` (${extra.join(", ")})\n` : "\n"),
  )
  for (const name of found.models.slice(0, 8)) out.write(theme.dim(`    ${name}\n`))
  if (found.models.length > 8) out.write(theme.dim(`    … and ${found.models.length - 8} more\n`))
  out.write("\n")
  return found
}

/**
 * 这个模型的窗口是不是已经知道了。
 *
 * 只有一种情况算知道:对着**官方 Anthropic 端点**、而且模型在内置表里。
 * 换了 baseURL 就不算 —— 那是别人家的兼容端点,同名模型完全可能是另一个窗口
 * (见 llm/providers/anthropic.ts)。
 */
function knownLimit(type: ProviderType, baseURL: string, model: string): boolean {
  if (type !== "anthropic" || baseURL.length > 0) return false
  return KNOWN_ANTHROPIC.has(model)
}

/** 和 providers/anthropic.ts 那张表对齐。只用来判"要不要问",不参与取值 */
const KNOWN_ANTHROPIC = new Set(["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"])

/**
 * 当面问窗口。
 *
 * 带一句**为什么要问** —— 一个不解释自己的问题,用户只会随便按个回车,
 * 而这个数按错了的后果要等到半小时后才出现。
 *
 * 默认值取一个保守的 128k:估小了的代价是压缩早了一点(烦),估大了的代价是
 * 请求被拒(会话直接进行不下去)。两种错不对称,所以往小了偏。
 */
async function askWindow(model: string): Promise<{ context: number; output: number } | undefined> {
  const out = process.stdout
  out.write(theme.dim(`  How big is ${model}'s context window? It decides when the history gets compacted.\n`))
  const answer = (await readLine(theme.bold("  Context tokens") + theme.dim(" [128000]: "))).trim()
  const context = answer.length === 0 ? 128_000 : Number(answer.replace(/[_,\s]/g, ""))
  if (!Number.isFinite(context) || context <= 0) {
    out.write(theme.yellow(`  "${answer}" is not a number — leaving it unset, edit the config later.\n`))
    return undefined
  }
  // 输出预算不单独问:它是"一次回答最多多长",而没有人知道自己想要多长。
  // 按窗口的八分之一取、卡在 4k–32k 之间,和内置表里那几个模型是同一个量级
  const output = Math.min(32_000, Math.max(4_000, Math.floor(context / 8)))
  return { context, output }
}

/** 选了"先不弄",或者引导中途失败。手动办法必须留在屏幕上 */
export function manualSetupHint(): string {
  const me = programName()
  return (
    theme.dim("\n  Set it up any time with: ") +
    theme.bold(`${me} auth login`) +
    theme.dim("\n  Or point it at an existing key:\n") +
    theme.dim(`    ALFA_KEY_ANTHROPIC=…  ${me} -m anthropic/claude-sonnet-4-5\n`)
  )
}

function fail(message: string): OnboardResult {
  process.stderr.write(theme.red(`\n  ✗ ${message}\n`))
  return { cancelled: true }
}
