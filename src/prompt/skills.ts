/**
 * Skills —— 按需加载的打法。
 *
 * ── 它和已有的两样东西的分工 ──
 *   AGENTS.md  这个仓库的**约定**。每一场都读,因为它管的是"什么不能破"。
 *   memory/    这个项目的**事实与决定**。自动装进上下文,因为忘了就要重推一遍。
 *   skills/    **怎么做一件事**。目录常驻、正文按需 —— 因为任何一条具体的打法,
 *              九成的轮次里都用不上。
 *
 * ── 为什么正文不进 system prompt ──
 * 量过一次:`prompt/config.ts` 那段「alfa 自己怎么配」是 5268 字符 ≈ 1300 token,
 * 无条件进每一场、每一次请求。它命中 prompt cache 所以便宜,但**缓存读到的 token
 * 照样占窗口**,而它真正有用的轮次是「用户问怎么配 provider」那百分之一。
 *
 * 同一把尺子 M16 已经用过一次(`context` 工具做成工具而不是每轮塞进去,理由写的是
 * "这个数字九成的轮次里用不上")。skills 是把那把尺子做成一条通路:**每一份知识
 * 只在目录里占一行,正文等它被点名时才来**。
 *
 * ── 三种来源,和它们各自的意思 ──
 *   builtin  编译进二进制的。alfa 关于**它自己**的知识住在这里 —— 配置怎么写、
 *            权限怎么回事。这类东西不该要求用户先装点什么才有。
 *   user     `~/.config/alfa/skills/`。这台机器上的人自己的打法,**处处生效**。
 *   project  `<仓库>/.alfa/skills/`。这个仓库的打法,跟着仓库走、进 git。
 *
 * 外加一层不在目录里的:**货架**(`~/.config/alfa/library/`)。存着但**不生效** ——
 * 攒下来的、别处抄来的、这个项目未必用得上的那些。它们不进目录(那一段每轮都发,
 * 一个人攒五十份的话,光目录就够呛),但翻得到、读得到,而**装**是把它写进项目的
 * `.alfa/skills/` —— 走普通的写盘那条路,过门卫、出 diff。刻意不给"复制一份"
 * 一条内部特权通道:多一个不经用户眼睛的写盘口,换来的只是省一次确认。
 * 同名时更具体的赢:project > user > builtin。和 MCP 配置同一条规矩,理由也一样 ——
 * 反过来很难解释:用户在仓库里明明写了一份,而生效的是别处那份看不见的。
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "../util/xdg.ts"
import { authPath } from "../config/auth.ts"
import { configPath } from "../config/config.ts"
import { ENV_PREFIX } from "../env/vars.ts"
import { ALFA_DIR } from "./init.ts"

/** 相对项目根 */
export const SKILLS_DIR = `${ALFA_DIR}/skills`

/** 货架的目录名(在用户配置目录下) */
export const LIBRARY_DIR = "library"

/**
 * 别家放 skill 的地方,相对项目根 / 相对家目录。
 *
 * ── 为什么读别人的目录 ──
 * skill 这套东西的格式**本来就是同一种**:`<name>/SKILL.md` + frontmatter 里的
 * `name:` / `description:`,正文按需加载。生态里现成的 skill 仓库全是照着
 * `.claude/skills/` 发的,而它们一个字都不用改就能在这儿跑 —— 不读它,用户
 * 得把每一份手工搬一遍,搬的过程里还会以为两边格式不一样(真机上就发生过)。
 *
 * 这也不是新口子:instructions.ts 早就在读 `CLAUDE.md` 和 `~/.claude/CLAUDE.md`,
 * 理由一模一样 —— 用户为一个仓库写过的东西,不该换个工具就得再写一遍。
 *
 * ★ 同名时**我们自己的目录赢**。理由不是护食,是可预期:一个人把 alfa 专属的
 *   那份写在 `.alfa/skills/` 里,他要的就是它盖住别处那份。
 */
export const CLAUDE_SKILLS_DIR = ".claude/skills"

/** 一份 skill 的正文上限。再长就不是"怎么做一件事",是一本手册 */
export const MAX_SKILL_BYTES = 32 * 1024
/**
 * 目录里最多列几条**盘上的**。目录是每轮都发的那一半,它必须小。
 *
 * ★ 预制的不算在里头。它们编译进二进制、条数由我们自己定,而且讲的是 alfa
 *   本身怎么回事 —— 一起排序切一刀的话,用户装到第 37 份就开始把「alfa 怎么
 *   配」挤出目录,而被挤掉的表现是模型开始现编配置格式。谁被挤掉还取决于**名字
 *   的字母序**,这是最难向人解释的一种消失。所以两边分开数:盘上的最多 40,
 *   预制的全在。
 */
export const MAX_SKILLS = 40
/** 目录里那一行的描述上限。一行就是一行 */
export const MAX_DESCRIPTION = 160

export type SkillOrigin = "builtin" | "user" | "project" | "library"

export interface Skill {
  name: string
  description: string
  /** 正文。发现的那一刻就是定死的字符串了 —— 见下面 BuiltinSkill */
  body: string
  origin: SkillOrigin
  /** 从哪读出来的。盘上的写路径,预制的写 "built in" */
  source: string
  /**
   * frontmatter 里的 `allowed-tools`(别家的字段,我们**不执行**)。
   *
   * 那边它是硬的:skill 生效期间工具表被收窄。这边没有"skill 生效期间"这个概念
   * —— 一份 skill 就是 `skill` 工具返回的一段文字,读完就在上下文里躺着了。
   * 所以这里只把它**原样带出来**,在打开时明说"声明了这个,但这儿不强制":
   * 假装执行了是最坏的一种,用户会以为有一道并不存在的栏。
   */
  allowedTools?: string
}

/**
 * 预制 skill:**一份 skill 文件的原文**,在编译时嵌进二进制。
 *
 * ── 为什么是文件,不是一段 TypeScript ──
 * 内置的和用户写的必须是**同一种东西**。写成函数的话会有两套:用户写
 * `.md` + frontmatter,我们写 TS —— 于是 frontmatter 解析器从来没被自己人用过
 * (它会在别人的文件上第一次出错),加一份内置知识的门槛是"改代码"而不是
 * "写一份 skill",而且内置的那些没法当**范例**看。现在它们走同一个解析器、
 * 同一套字段,`src/prompt/skills/*.md` 就是怎么写一份 skill 的活样本。
 *
 * 里面可以写 `{{program}}` `{{configFile}}` `{{authFile}}` `{{envPrefix}}`,
 * 在发现那一刻替换 —— 这台机器上的真实路径和用户实际敲的命令名编译期不知道,
 * 而它们恰恰是模型唯一猜不出来的东西。
 */
export interface BuiltinSkill {
  /** 文件原文(frontmatter + 正文) */
  text: string
  /** 出问题时报得出是哪一份 */
  source: string
}

/** 替换预制 skill 正文里的占位符。盘上的 skill **不做**替换 —— 见 discoverSkills */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([a-zA-Z]+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}

export interface SkillInput {
  /** 用户实际敲的那个命令名(通常是 `alfa`,也可能是软链/alias)。预制 skill 照着它写例子 */
  program: string
  root: string
  /** 注入用,测试里把路径固定住。不给就是这台机器上的真实路径 */
  configFile?: string
  authFile?: string
  /** 用户全局 skills 目录。DiscoverInput 里那个同名字段就是它 */
  userDir?: string
}

export interface SkillSet {
  skills: Skill[]
  /**
   * 货架上的那些。**不进目录、不进上下文**,只有被点名读的时候才花钱。
   *
   * 和 skills 分开一个字段而不是加个 origin 就完事:它们在每一处的待遇都不同 ——
   * 目录不列、`/context` 不算、装载不装。混在一个数组里的话,每一处都要记得过滤,
   * 而漏掉任何一处的表现都是"我明明没装它,它却在花我的 token"。
   */
  library: Skill[]
  /** 撞上限被挡在外面的条数 */
  dropped: number
  /** 读不出来的那些。**不抛** —— 一份写坏的 skill 不该让程序起不来 */
  problems: Array<{ source: string; why: string }>
}

/** 名字的形状:目录里要能被模型原样打回来,所以不留空格和大小写歧义 */
const NAME = /^[a-z0-9][a-z0-9_-]*$/

/**
 * 拼目录。**每轮都发的就是这一段**,所以一条 skill 一行,没有正文。
 *
 * 排序按名字,不按来源:同样的一组文件每次拼出同样的一段文本 —— 顺序一抖,
 * system prompt 的缓存前缀就作废(同 tool/registry.ts 那条)。
 */
export function skillCatalogue(set: SkillSet): string {
  if (set.skills.length === 0) return ""
  const lines = set.skills
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((one) => `- \`${one.name}\` — ${one.description}`)
  const shelf =
    set.library.length > 0
      ? [
          "",
          `${set.library.length} more sit on the user's shelf, not loaded here: \`skill\` with \`action: "library"\` lists them. A shelved one becomes part of this project by being written into \`.alfa/skills/\` — read it, then write it, the same as any other file.`,
        ]
      : []
  return [
    "# Skills",
    "",
    "Playbooks you can open when they apply. Each line is a name and what it covers; the text itself is not here. Call the `skill` tool with the name to read one — do that whenever the work at hand matches a line below, before working it out yourself. Reading one costs a step and some context, so open the one that fits, not the whole list.",
    "",
    ...lines,
    ...shelf,
  ].join("\n")
}

/**
 * 找一份。装上的优先,找不到再翻货架 —— 名字撞了以装上的为准(货架那边本来
 * 就把同名的滤掉了),而"读得到"和"装上了"是两件事。
 */
export function findSkill(set: SkillSet, name: string): Skill | undefined {
  const wanted = name.trim().toLowerCase()
  return set.skills.find((one) => one.name === wanted) ?? set.library.find((one) => one.name === wanted)
}

export interface DiscoverInput extends SkillInput {
  /** 用户全局那个目录。不给就只找项目里的 */
  userDir?: string
  /** 货架目录。不给就是没有货架 */
  libraryDir?: string
  /** `~/.claude/skills`。不给就不找别家的用户级目录 */
  claudeUserDir?: string
  /** 预制的那些。由调用方传进来,这个文件不认识它们的内容 */
  builtin?: BuiltinSkill[]
}

/**
 * 找齐三处的 skills。
 *
 * 一份读坏了就是少一份(记进 problems),不是抛 —— 和 MCP 配置同一条:别人写的
 * 文件出问题,代价不能是这个程序起不来。
 */
export function discoverSkills(input: DiscoverInput): SkillSet {
  const problems: SkillSet["problems"] = []
  const byName = new Map<string, Skill>()

  for (const one of input.builtin ?? []) {
    // ★ 和盘上那些走**同一个** parseSkill。内置的自己先过一遍这道关,坏掉的
    //   格式在我们自己的文件上就露馅了,而不是等用户写第一份时才发现
    const parsed = parseSkill(one.text, "", "builtin", one.source)
    if (typeof parsed === "string" || !parsed) {
      problems.push({ source: one.source, why: parsed || "is not a usable skill" })
      continue
    }
    byName.set(parsed.name, { ...parsed, body: substitute(parsed.body, placeholders(input)) })
  }

  const scan = (dir: string, origin: SkillOrigin): void => scanInto(dir, origin, byName, problems)

  // 顺序就是优先级,后扫的盖先扫的。按「具体压笼统、自己人压别家」排:
  // 项目 .alfa > 项目 .claude > 用户 .alfa > 用户 .claude > 预制
  if (input.claudeUserDir) scan(input.claudeUserDir, "user")
  if (input.userDir) scan(input.userDir, "user")
  scan(join(input.root, CLAUDE_SKILLS_DIR), "project")
  scan(join(input.root, SKILLS_DIR), "project")

  // 预制的先留出来,上限只切盘上那些(见 MAX_SKILLS)。同名被项目/用户盖掉的
  // 那份 origin 已经不是 builtin 了 —— 它是用户自己写的东西,当然要一起数
  const all = [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  const compiled = all.filter((one) => one.origin === "builtin")
  const onDisk = all.filter((one) => one.origin !== "builtin")
  const skills = [...compiled, ...onDisk.slice(0, MAX_SKILLS)].toSorted((a, b) => a.name.localeCompare(b.name))

  // 货架单独扫,而且**扫完就放在一边** —— 它不参与合并,也不参与上限:
  // 目录那道 MAX_SKILLS 挡的是"每轮发多少",而货架一个字都不发
  const shelf = new Map<string, Skill>()
  if (input.libraryDir) {
    scanInto(input.libraryDir, "library", shelf, problems)
  }
  const library = [...shelf.values()]
    .filter((one) => !byName.has(one.name))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  return { skills, library, dropped: Math.max(0, onDisk.length - MAX_SKILLS), problems }
}

function scanInto(
  dir: string,
  origin: SkillOrigin,
  into: Map<string, Skill>,
  problems: SkillSet["problems"],
): void {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return // 没这个目录 = 还没写过 skill,不是错
  }
  for (const entry of entries) {
    const found = readSkill(join(dir, entry), entry, origin)
    if (typeof found === "string") {
      problems.push({ source: join(dir, entry), why: found })
      continue
    }
    if (!found) continue
    into.set(found.name, found)
  }
}

/**
 * 一份 skill 可以是 `<name>.md`,也可以是 `<name>/SKILL.md`。
 *
 * 两种都认是因为它们各有各的正当用途:一段几十行的打法就该是一个文件;而一份要
 * 带脚本、带模板、带样例数据的,需要一个能放东西的文件夹。只认一种的话,另一种
 * 用法要么被逼着变形,要么就干脆不用了。
 */
function readSkill(path: string, entry: string, origin: SkillOrigin): Skill | undefined | string {
  let file = path
  let name = entry
  try {
    if (statSync(path).isDirectory()) {
      file = join(path, "SKILL.md")
      statSync(file)
    } else {
      if (!entry.endsWith(".md")) return undefined
      name = entry.slice(0, -3)
    }
  } catch {
    // 文件夹里没有 SKILL.md:那多半根本不是一份 skill,静静跳过
    return undefined
  }

  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    return `could not be read (${(error as Error).message})`
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) {
    text = text.slice(0, MAX_SKILL_BYTES)
  }

  return parseSkill(text, name, origin, file)
}

/**
 * 原文 → 一份 skill。内置的和盘上的都走这里。
 *
 * 返回字符串 = 哪儿不对(给 `/skills` 显示的那句话)。
 */
export function parseSkill(
  text: string,
  fallbackName: string,
  origin: SkillOrigin,
  source: string,
): Skill | string {
  const parsed = frontmatter(text)
  const finalName = (parsed.fields["name"] ?? fallbackName).trim().toLowerCase()
  if (!NAME.test(finalName)) {
    return `has an unusable name "${finalName}" — use lower-case letters, digits, - and _`
  }
  const description = clipDescription(parsed.fields["description"] ?? firstLine(parsed.body))
  if (description.length === 0) {
    // 没有描述的 skill 在目录里是一行废话,模型永远不会点开它
    return `needs a description — that one line is the only thing the model sees until it opens the skill`
  }
  // 别家的字段照单收下,不认识的一律忽略 —— 一份为别的 agent 写的 skill
  // 多带几个键是正常的,为此拒收整份是最没道理的一种失败
  const allowed = parsed.fields["allowed-tools"]?.trim()
  return {
    name: finalName,
    description,
    body: parsed.body,
    origin,
    source,
    ...(allowed ? { allowedTools: allowed } : {}),
  }
}

/**
 * 占位符的值。
 *
 * ★ 只喂给**内置**的那些。盘上的 skill 不做替换 —— 那是用户写的文本,里面出现
 *   一对花括号的正当理由太多了(模板语法、代码样例),而"我写的东西被悄悄改了"
 *   是最难查的一类问题。
 */
function placeholders(input: SkillInput & { libraryDir?: string }): Record<string, string> {
  return {
    program: input.program,
    root: input.root,
    envPrefix: ENV_PREFIX,
    // 真实绝对路径**现取**。它是模型唯一猜不出来的东西,而猜出来的答案听起来
    // 一样自信 —— 用户照着改完得到的是一个起不来的 config.json
    configFile: input.configFile ?? configPath(),
    authFile: input.authFile ?? authPath(),
    // 用户全局那个目录的真实路径。XDG 一变它就变,而"该往哪儿放"正是写一份
    // skill 时第一个要答对的问题 —— 答错的表现是它根本不出现
    skillsDir: input.userDir ?? join(configDir(), "skills"),
    libraryDir: input.libraryDir ?? join(configDir(), LIBRARY_DIR),
  }
}

/** 极小的 YAML 子集:`key: value`,只在开头那对 `---` 之间。够用,而且不引依赖 */
function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replaceAll("\r\n", "\n")
  if (!normalized.startsWith("---\n")) return { fields: {}, body: normalized.trim() }
  const end = normalized.indexOf("\n---", 3)
  if (end < 0) return { fields: {}, body: normalized.trim() }
  const head = normalized.slice(4, end)
  const fields: Record<string, string> = {}
  for (const line of head.split("\n")) {
    const at = line.indexOf(":")
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) fields[key] = value
  }
  const rest = normalized.slice(end + 4)
  return { fields, body: rest.replace(/^\n+/, "").trim() }
}

/**
 * 截到一行的长度。**按词截并留一个省略号** —— 半个单词读起来像程序坏了,
 * 而这一行正是模型判断"要不要点开它"的全部依据:它得看得出后面还有。
 */
function clipDescription(text: string): string {
  const one = text.trim()
  if (one.length <= MAX_DESCRIPTION) return one
  const cut = one.slice(0, MAX_DESCRIPTION - 1)
  const space = cut.lastIndexOf(" ")
  return (space > MAX_DESCRIPTION / 2 ? cut.slice(0, space) : cut).trimEnd() + "…"
}

function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^#+\s*/, "").trim()
    if (text.length > 0) return text
  }
  return ""
}
