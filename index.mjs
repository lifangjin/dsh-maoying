/**
 * dsh-maoying — cordis 插件（启动安装器）
 *
 * 机制（照搬 dsh-paoding 已验证路径，MIT，同作者）：
 * `dsh plugin --profile <name> add dsh-maoying` 时，包内 cordis.patch.yml 的
 * bundle insert（id: maoying-installer / name: dsh-maoying）由宿主
 * reconcilePlugins 并入该 profile 的 dsh.profile.bundles；boot 时 cordis 挂载
 * 本文件（main: index.mjs），apply() 里做一次幂等的 ensurePresetInstalled：
 *
 *   1) 解析 dsh home：process.env.DSH_HOME，缺省 os.homedir()/.dsh；
 *   2) 把 presets/maoying/ 四个源文件（preset.yml / agent.cordis.yml /
 *      restrict.mjs / delegation-labels.mjs）复制到 <home>/.agent-presets/maoying/
 *      ——逐字节比较，内容一致不写（避免无谓的 mtime 抖动）；复制完落
 *      .installed-version 标记（本包版本号，从 package.json 读）；
 *   3) 在 <home>/cordis.patch.yml 维护托管块（起止标记见 MANAGED_BEGIN /
 *      MANAGED_END），块内是一条 dsh-agent-preset 声明行——preset.yml 的
 *      name/description/order 与 agent.cordis.yml 解析出的完整 plugins 数组
 *      全部内联。DSH 0.1.7 起宿主靠这条声明行发现预设；不写它，预设选择器里
 *      就不会出现「毛颖创作 (Maoying)」。
 *
 * 幂等语义：托管块已存在、.installed-version 与当前版本一致、且块内容与本次
 *   生成的文本逐字节一致 → 跳过；任一不符 → 保住块外用户内容，整块替换；块
 *   不存在 → 文末追加（文件不存在则创建，带一行头注释说明这是 home 级 patch
 *   层）。内容比对是版本比对之外的兜底：开发检出（link 安装）改了预设源而没
 *   改版本号时，重启照样换新，不会带着旧组合过夜。
 *
 * YAML：解析与序列化都从 <home>/node_modules 惰性加载 yaml 包（dsh 自带 v2，
 *   本包零 npm 依赖）。agent.cordis.yml 解析前先中和 `!!js` 表达式——本仓库
 *   只有 process.platform 两处（tool-bash / tool-pwsh 的 disabled），直接
 *   replaceAll 成 true/false。yaml 包不可用时：序列化回退为整段 JSON 单行
 *   （YAML 1.2 是 JSON 超集，合法）并 warn；解析没有可靠回退（plugins 数组
 *   结构深，手写子集解析器得不偿失），此时只落预设文件、跳过声明行并 warn
 *   ——下次宿主启动（yaml 可用）自动补写，自愈。
 *
 * 宿主版本检查：从 <home>/node_modules require('@deepseek-ai/dsh/package.json')
 *   取宿主版本，≥ 0.2.1-rc.2 时 warn 一条——该版本起 dsh-tool-subagent 拒绝
 *   内联 persona/toolFilter 形状的委派行（见 README「兼容面」）。semver 比较手
 *   写（major.minor.patch-rc.N），零依赖。
 *
 * 失败面：全程 try/catch，任何失败只 warn 不抛——安装器绝不能弄死宿主启动。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'maoying-installer'

/** 插件包根（本文件所在目录）。 */
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 预设 id：目录名与声明行 config.id 同名。 */
export const PRESET_ID = 'maoying'

/** home patch 托管块起止标记（成对出现；只认首对）。 */
export const MANAGED_BEGIN = '# --- dsh-maoying preset managed (auto-generated; do not edit) ---'
export const MANAGED_END = '# --- end dsh-maoying preset managed ---'

/** 声明行挂载的宿主 preset 包名（0.1.7+ 的 agent-preset-registry 组件包）。 */
const PRESET_ROW_NAME = '@deepseek-ai/dsh-agent-preset'

/** 需要落盘的预设源文件（与 presets/maoying/ 一一对应）。 */
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml', 'restrict.mjs', 'delegation-labels.mjs']

/** 新建 <home>/cordis.patch.yml 时的一行头注释：说明这是 home 级 patch 层。 */
const HOME_PATCH_HEADER =
  '# DeepSeek Harness home 级 patch 层（作用于所有 profile）：手工条目可直接追加，各插件的托管块由起止标记维护。'

// ── 解析 dsh home ───────────────────────────────────────────────────────────

/** DSH_HOME 环境变量优先，缺省 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 本包版本号（package.json 的 version）；读不到返回 null。 */
export function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 从 <home>/node_modules 惰性加载 yaml 包（dsh 自带 v2，见 paoding loadYaml
 * 同款做法）。主路径失败再试插件包自身解析（开发检出偶然落在有 yaml 的目录
 * 里时白捡）；两处都没有返回 null——调用方走回退分支。
 */
export function loadYamlLib(dshHome) {
  for (const base of [
    path.join(dshHome, 'node_modules', 'package.json'),
    path.join(PLUGIN_ROOT, 'package.json'),
  ]) {
    try {
      const mod = createRequire(base)('yaml')
      if (mod && typeof mod.parse === 'function' && typeof mod.stringify === 'function') return mod
    } catch {
      /* 该路径没有 yaml 包——试下一个 */
    }
  }
  return null
}

/**
 * 中和 cordis 的 `!!js` 表达式（preprocessPatchText 式）。本仓库的
 * agent.cordis.yml 只有 process.platform 两处，直接 replaceAll；未来若新增
 * 其他 `!!js` 表达式，必须同步扩充这里，否则 yaml.parse 会告 unresolved tag。
 */
export function preprocessPatchText(text) {
  const isWin = process.platform === 'win32'
  return text
    .replaceAll("!!js process.platform === 'win32'", isWin ? 'true' : 'false')
    .replaceAll("!!js process.platform !== 'win32'", isWin ? 'false' : 'true')
}

// ── semver（手写，零依赖）────────────────────────────────────────────────────

/** 解析 major.minor.patch[-prerelease][+build]；解析不了返回 null。 */
export function parseSemver(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(text ?? '').trim(),
  )
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null }
}

/** prerelease 逐 token 比较（数字 token 按数值，其余按字典序，数字恒小于字母）。 */
function comparePrereleaseTokens(a, b) {
  const as = String(a).split('.')
  const bs = String(b).split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1 // 前缀更短 = 更小（1.0.0-rc < 1.0.0-rc.1）
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * semver 全序比较：a<b → -1，a=b → 0，a>b → 1；任一侧解析失败返回 null。
 * prerelease 按 semver 规则：正式版 > 同号 prerelease（0.2.1 > 0.2.1-rc.2）。
 */
export function compareSemver(a, b) {
  const va = parseSemver(a)
  const vb = parseSemver(b)
  if (!va || !vb) return null
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1
  }
  if (va.prerelease === vb.prerelease) return 0
  if (va.prerelease === null) return 1
  if (vb.prerelease === null) return -1
  return comparePrereleaseTokens(va.prerelease, vb.prerelease)
}

/**
 * 该宿主版本是否已落地内联委派行守卫（≥ 0.2.1-rc.2，含 0.2.1-rc.2 这个
 * prerelease 本身与之后的正式版）：dsh-tool-subagent 自该版起拒绝 config 里
 * 的 persona / toolFilter 键。版本解析不了返回 false（保守侧：不惊扰）。
 */
export function hostRejectsInlineDelegation(version) {
  const c = compareSemver(version, '0.2.1-rc.2')
  return c !== null && c >= 0
}

/** 宿主包版本：从 <home>/node_modules require('@deepseek-ai/dsh/package.json')。 */
export function readHostVersion(dshHome) {
  try {
    const req = createRequire(path.join(dshHome, 'node_modules', 'package.json'))
    const pkg = req('@deepseek-ai/dsh/package.json')
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return null
  }
}

// ── 预设源解析 ──────────────────────────────────────────────────────────────

/**
 * 解析 preset.yml 的显示元数据（name / description / order）。description 在
 * 源文件里是折叠多行纯量，yaml.parse 自动拼成单值。字段缺失返回 null——
 * 它们在声明行 config 里都是宿主可选键。
 */
export function parsePresetMeta(yaml, presetYmlText) {
  const data = yaml.parse(presetYmlText)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('preset.yml 顶层不是键值映射')
  }
  return {
    name: typeof data.name === 'string' && data.name !== '' ? data.name : null,
    description: typeof data.description === 'string' && data.description !== '' ? data.description : null,
    order: Number.isInteger(data.order) ? data.order : null,
  }
}

/**
 * 解析 agent.cordis.yml 为完整 plugins 数组。`!!js` 先中和（见
 * preprocessPatchText）；顶层必须是数组。
 */
export function parseAgentPlugins(yaml, agentYmlText) {
  const data = yaml.parse(preprocessPatchText(agentYmlText))
  if (!Array.isArray(data)) throw new Error('agent.cordis.yml 顶层不是数组')
  return data
}

/**
 * 组装声明行（insert 列表元素）：id 固定 preset-maoying，config 内联 preset
 * 元数据与 plugins 全量数组。name/description/order 缺省时不写（宿主可选键）。
 */
export function buildPresetRow({ meta, plugins }) {
  const config = { id: PRESET_ID }
  if (meta.name !== null) config.name = meta.name
  if (meta.description !== null) config.description = meta.description
  if (meta.order !== null) config.order = meta.order
  config.plugins = plugins
  return {
    insert: [
      {
        id: `preset-${PRESET_ID}`,
        name: PRESET_ROW_NAME,
        config,
      },
    ],
  }
}

/**
 * 序列化声明行为托管块正文（不含起止标记）：yaml 可用走 YAML 块形态；
 * yaml 不可用回退为整段 JSON 单行（YAML 1.2 是 JSON 超集，宿主解析无感）。
 */
export function stringifyManagedBlock(yaml, row) {
  if (yaml) {
    // lineWidth: 0 关掉自动折行——plain 标量折行虽合法但产物不可读、diff 噪音大
    return `${MANAGED_BEGIN}\n${yaml.stringify([row], { lineWidth: 0 }).replace(/\n+$/, '')}\n${MANAGED_END}`
  }
  return `${MANAGED_BEGIN}\n${JSON.stringify([row])}\n${MANAGED_END}`
}

// ── home patch 托管块手术 ───────────────────────────────────────────────────

/**
 * 在行数组里定位托管块 [begin, end]（闭区间下标）。无起始标记返回 null；
 * 有起始无结束（托管块损坏，多半是手工删了半截）throw——拒绝写盘，绝不覆盖
 * 手工内容，与 paoding 同一口径。
 */
export function findManagedSpan(lines) {
  const begin = lines.findIndex((l) => l.trim() === MANAGED_BEGIN)
  if (begin === -1) return null
  for (let i = begin + 1; i < lines.length; i++) {
    if (lines[i].trim() === MANAGED_END) return { begin, end: i }
  }
  throw new Error(
    `cordis.patch.yml 的 dsh-maoying 托管块已损坏（只有起始标记、找不到结束标记 "${MANAGED_END}"）：` +
      '请手工补回结束标记，或把整个托管块删除后重试；已拒绝写盘以免覆盖手工内容',
  )
}

/**
 * 把托管块文本 upsert 进 <home>/cordis.patch.yml。返回动作：
 *   'skipped' — 托管块已在且内容与版本标记都一致，零写盘；
 *   'updated' — 整块替换（块外用户内容一字节不动）；
 *   'created' — 原无托管块，文末追加（文件不存在则连头注释一起新建）。
 */
export function upsertManagedBlock(dshHome, blockText, { versionMarkerCurrent }) {
  const patchPath = path.join(dshHome, 'cordis.patch.yml')
  let text = null
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const eol = text !== null && text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text !== null ? text.split(/\r?\n/) : [HOME_PATCH_HEADER, '']
  const incoming = blockText.replace(/\r?\n/g, '\n')

  const span = findManagedSpan(lines) // 损坏块 throw，直接中止（未写任何盘）
  if (span !== null) {
    const existing = lines.slice(span.begin, span.end + 1).join('\n')
    if (versionMarkerCurrent && existing === incoming) return 'skipped'
    lines.splice(span.begin, span.end - span.begin + 1, ...incoming.split('\n'))
  } else {
    // 文末追加。非空文件先补尾换行（若缺）——split 出的末尾 '' 元素正好兼任
    // 块前空行分隔；刚补的 '' 同理。文件为空（text === null）时前面已有头注释。
    if (text !== null && text.trim() !== '' && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(...incoming.split('\n'), '')
  }
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(patchPath, lines.join(eol), 'utf8')
  return span !== null ? 'updated' : 'created'
}

// ── 安装主流程 ──────────────────────────────────────────────────────────────

/**
 * 幂等安装毛颖预设。步骤彼此独立、各自可失败：
 *   1) 预设文件落盘（不依赖 yaml，任何情况都先做）；
 *   2) .installed-version 标记（内容与当前版本一致即不重写）；
 *   3) home patch 托管块（依赖 yaml；yaml 缺席时跳过并 warn，下次启动自愈）。
 * 返回 { status, home, presetDir, copied, blockAction, reason }，status 取
 * 'ok'（全链路完成）| 'partial'（托管块未写，原因见 reason）。
 */
export function ensurePresetInstalled(ctx = {}) {
  const logger = ctx?.logger ?? console
  const home = resolveDshHome()
  const version = pluginVersion() ?? '0.0.0'
  const sourceDir = path.join(PLUGIN_ROOT, 'presets', PRESET_ID)
  const presetDir = path.join(home, '.agent-presets', PRESET_ID)

  // 1) 预设文件：内容一致不写（逐字节比较），变化才覆盖
  const copied = []
  mkdirSync(presetDir, { recursive: true })
  for (const file of PRESET_FILES) {
    const src = path.join(sourceDir, file)
    const dst = path.join(presetDir, file)
    let same = false
    try {
      same = existsSync(dst) && readFileSync(dst).equals(readFileSync(src))
    } catch {
      same = false
    }
    if (!same) {
      copyFileSync(src, dst)
      copied.push(file)
    }
  }

  // 2) 版本标记：一致不重写（mtime 也是产物，少动一次是一次）
  const markerPath = path.join(presetDir, '.installed-version')
  let markerCurrent = false
  try {
    markerCurrent = existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === version
    if (!markerCurrent) writeFileSync(markerPath, `${version}\n`, 'utf8')
  } catch (err) {
    logger.warn?.(`maoying-installer: .installed-version 标记写入失败（不影响预设本体）: ${err?.message ?? err}`)
  }

  // 3) home patch 托管块
  const yaml = loadYamlLib(home)
  if (!yaml) {
    logger.warn?.(
      'maoying-installer: <home>/node_modules 下找不到 yaml 包，无法解析预设组合——' +
        '预设文件已复制，但 cordis.patch.yml 声明行本次跳过，下次宿主启动自动补写',
    )
    return { status: 'partial', home, presetDir, copied, blockAction: null, reason: 'yaml-unavailable' }
  }

  const meta = parsePresetMeta(yaml, readFileSync(path.join(sourceDir, 'preset.yml'), 'utf8'))
  const plugins = parseAgentPlugins(yaml, readFileSync(path.join(sourceDir, 'agent.cordis.yml'), 'utf8'))
  const blockText = stringifyManagedBlock(yaml, buildPresetRow({ meta, plugins }))
  const blockAction = upsertManagedBlock(home, blockText, { versionMarkerCurrent: markerCurrent })

  if (copied.length > 0) {
    logger.info?.(`maoying-installer: 预设文件已更新 ${PRESET_ID}: ${copied.join(', ')}`)
  }
  if (blockAction === 'skipped') {
    logger.info?.(`maoying-installer: 预设 ${PRESET_ID} 已就绪（v${version}，声明行与文件均无变化）`)
  } else if (blockAction === 'updated') {
    logger.info?.(`maoying-installer: cordis.patch.yml 托管块已按 v${version} 重写`)
  } else if (blockAction === 'created') {
    logger.info?.(`maoying-installer: cordis.patch.yml 托管块已写入（v${version}）`)
  }
  return { status: 'ok', home, presetDir, copied, blockAction, reason: null }
}

/**
 * cordis 插件入口。任何失败只 warn 不抛——安装器绝不能弄死宿主启动。
 * @param {{ logger?: object, effect?: Function }} ctx - cordis context
 * @param {object} _config - 预留（一期无配置键）
 */
export function apply(ctx = {}, _config = {}) {
  const logger = ctx?.logger ?? console
  try {
    ensurePresetInstalled({ logger })
  } catch (error) {
    logger.warn?.(`maoying-installer: 预设安装失败（已跳过，不影响宿主启动）: ${error?.message ?? error}`)
  }

  // 宿主版本检查（独立于安装，失败静默）：0.2.1-rc.2 起内联委派行形状被拒
  try {
    const hostVersion = readHostVersion(resolveDshHome())
    if (hostVersion !== null && hostRejectsInlineDelegation(hostVersion)) {
      logger.warn?.(
        `maoying-installer: 检测到宿主 DSH ${hostVersion}——毛颖的委派行是内联形状，` +
          'DSH 0.2.1-rc.2+ 的 dsh-tool-subagent 拒绝该形状，请降级宿主或等毛颖适配版（详见 README「兼容面」）',
      )
    }
  } catch {
    /* 版本探测失败不提示——检查本身就是锦上添花 */
  }
}
