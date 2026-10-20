/**
 * dsh-maoying — cordis 插件（启动安装器）
 *
 * 机制：
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
 *   3) 把包内 skills/ 的 maoying-* 技能目录复制到 <home>/skills/<name>/
 *      ——同样逐字节比较、一致不写，每个技能目录落 .installed-version 标记；
 *      只碰 maoying-* 前缀目录，用户自己的技能一个字节都不动；
 *   4) 在 <home>/cordis.patch.yml 维护托管块（起止标记见 MANAGED_BEGIN /
 *      MANAGED_END），块内是 dsh-agent-preset 声明行——preset.yml 的
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
 * 形态选择（双形状）：生成内容 = f(宿主版本, 插件版本)。宿主 ≤ 0.2.1-rc.1 用
 *   v1 内联形状（agent.cordis.yml，1 条声明行，委派行内联 persona/toolFilter）；
 *   ≥ 0.2.1-rc.2 用 v2 AgentPreset 形状（agent.cordis.v2.yml，6 条声明行——
 *   主编 preset + 5 张角色 preset，委派行以 agentPreset 指向角色 preset，该版
 *   本起 dsh-tool-subagent 拒绝内联形状）。宿主升降级后重启即整块切换，无需
 *   重装插件（见 composeManagedRows）。
 *
 * YAML：解析与序列化都从 <home>/node_modules 惰性加载 yaml 包（dsh 自带 v2，
 *   本包零 npm 依赖）。agent.cordis.yml / agent.cordis.v2.yml 解析前先中和
 *   `!!js` 表达式——两个文件都只有 process.platform 两种（tool-bash /
 *   tool-pwsh 的 disabled），直接 replaceAll 成 true/false。yaml 包不可用时：
 *   序列化回退为整段 JSON 单行（YAML 1.2 是 JSON 超集，合法）并 warn；解析没
 *   有可靠回退（plugins 数组结构深，手写子集解析器得不偿失），此时只落预设
 *   文件、跳过声明行并 warn——下次宿主启动（yaml 可用）自动补写，自愈。
 *
 * 失败面：全程 try/catch，任何失败只 warn 不抛——安装器绝不能弄死宿主启动。
 *
 * 三期追加（创作台面板，Node 侧）：本文件同时是 /api/maoying/* 前缀路由的
 *   注册点（inject webServer + workspaceRegistry，见 registerCreatorRoutes）。
 *   路由段与安装段彼此独立、各失败各的：路由注册/请求处理失败只 warn，
 *   安装器语义分毫不动。要点：信任围栏、duplicate prefix route 短重试、
 *   限额 JSON 读体、client.css 现读下发。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  listWorkspaces,
  mutateChapterStatus,
  mutateForeshadowStatus,
  mutatePhase,
  parseStateSnapshot,
  readChapter,
  rebuildIndex,
  resolveNovelRoot,
} from './lib/panel-core.mjs'
import { loadYamlLib, resolveDshHome } from './lib/yaml-loader.mjs'

// loadYamlLib / resolveDshHome 已迁至 lib/yaml-loader.mjs（创作台业务层与
// 安装器共用，避免 panel-core 反向 import 主入口）；这里再导出保住本入口的
// 既有公开 API。
export { loadYamlLib, resolveDshHome }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'maoying-installer'

/**
 * 需要宿主注入的服务：webServer 注册 /api/maoying 前缀路由，
 * workspaceRegistry 提供工作区白名单（path 参数的安全边界）。webRuntime
 * 不进 inject——非 web 部署没有它，经 ctx.get 每请求软探测（见
 * registerCreatorRoutes 内 trustedHostsOf）。
 */
export const inject = ['webServer', 'workspaceRegistry']

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

/** v2 组合源（AgentPreset 形状，仅宿主 ≥ 0.2.1-rc.2 解析；不落盘，包内直读）。 */
const AGENT_CORDIS_V2_FILE = 'agent.cordis.v2.yml'

/** 新建 <home>/cordis.patch.yml 时的一行头注释：说明这是 home 级 patch 层。 */
const HOME_PATCH_HEADER =
  '# DeepSeek Harness home 级 patch 层（作用于所有 profile）：手工条目可直接追加，各插件的托管块由起止标记维护。'

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
 * 中和 cordis 的 `!!js` 表达式（preprocessPatchText 式）。agent.cordis.yml 与
 * agent.cordis.v2.yml 都只有 process.platform 两种表达式（tool-bash / tool-pwsh
 * 的 disabled，v2 里 continuable 三角色的工具行各一对），直接 replaceAll；未来
 * 任一文件新增其他 `!!js` 表达式，必须同步扩充这里，否则 yaml.parse 会告
 * unresolved tag（test/composition.test.mjs 对 v2 有 grep 断言兜底）。
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
/** 从 start 向上最多 8 层找最近的 @deepseek-ai/dsh package.json，命中记轨迹 */
function anchorVersion(start, probe, trace) {
  let dir = path.dirname(path.resolve(start))
  for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string' && pkg.version !== '') {
        trace.push({ probe, hit: pkg.version, via: pkgPath })
        return pkg.version
      }
    } catch { /* 单个坏 package.json 跳过继续走 */ }
  }
  trace.push({ probe, hit: null })
  return null
}

/**
 * 宿主版本探测（带轨迹）。五级优先，前四级都锚定「当前进程的真实宿主」，
 * home 全局那份（老 CLI 残留，版本可能差几个大版本）只做最后兜底：
 *   ① argv[1]——CLI 下就是 @deepseek-ai/dsh 包内入口；
 *   ② 全 argv 扫描——Electron 主进程常见 argv 里带 app 入口或 .asar 路径；
 *   ③ app.asar 锚定——桌面应用 execPath 反推 Resources/app.asar/dsh（Electron
 *      主进程 fs 可透读 asar）；
 *   ④ Electron app.getVersion()——桌面应用版本即其内置 dsh 版本；
 *   ⑤ home 全局安装兜底。
 * 轨迹经 trace 数组透出（host-debug 路由用），方便现场诊断每级看到了什么。
 */
function collectHostVersion(dshHome, trace) {
  // ① argv[1]
  const argv1 = process.argv?.[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    const hit = anchorVersion(argv1, 'argv[1]', trace)
    if (hit) return hit
  } else {
    trace.push({ probe: 'argv[1]', hit: null, note: 'argv[1] 缺席' })
  }
  // ② 全 argv 扫描
  let scanned = 0
  for (const arg of process.argv ?? []) {
    if (typeof arg !== 'string' || arg === argv1 || arg.startsWith('-')) continue
    if (!/\.asar($|\/)|\.(mjs|cjs|js)$/.test(arg)) continue
    scanned++
    const hit = anchorVersion(arg, 'argv-scan', trace)
    if (hit) return hit
  }
  if (scanned === 0) trace.push({ probe: 'argv-scan', hit: null, note: '无可锚定的 argv 项' })
  // ③ app.asar 锚定（仅 Electron 进程内有意义；纯 Node 的 fs 读不了 asar）
  if (process.versions?.electron) {
    const execDir = path.dirname(process.execPath)
    const candidates = [
      path.resolve(execDir, '..', 'Resources', 'app.asar', 'dsh', 'package.json'),
      path.resolve(execDir, 'resources', 'app.asar', 'dsh', 'package.json'),
      path.resolve(execDir, '..', 'Resources', 'app.asar', 'package.json'),
      path.resolve(execDir, 'resources', 'app.asar', 'package.json'),
    ]
    let probed = false
    for (const pkgPath of candidates) {
      try {
        if (!existsSync(pkgPath)) continue
        probed = true
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string' && pkg.version !== '') {
          trace.push({ probe: 'asar', hit: pkg.version, via: pkgPath })
          return pkg.version
        }
      } catch { /* 单个候选坏掉换下一个 */ }
    }
    if (!probed) trace.push({ probe: 'asar', hit: null, note: 'execPath 反推的 asar 路径均不可读' })
  } else {
    trace.push({ probe: 'asar', hit: null, note: '非 Electron 进程' })
  }
  // ④ Electron app.getVersion()。纯 Node 下 require('electron') 得到路径字符串
  //    或直接找不到，类型守卫天然挡掉。
  try {
    const electron = createRequire(import.meta.url)('electron')
    if (electron && typeof electron === 'object' && typeof electron.app?.getVersion === 'function') {
      const v = electron.app.getVersion()
      const hit = typeof v === 'string' && v !== '' ? v : null
      trace.push({ probe: 'electron-api', hit })
      if (hit) return hit
    } else {
      trace.push({ probe: 'electron-api', hit: null, note: 'require 结果非 API 对象' })
    }
  } catch {
    trace.push({ probe: 'electron-api', hit: null, note: 'require 失败' })
  }
  // ⑤ home 全局兜底
  try {
    const req = createRequire(path.join(dshHome, 'node_modules', 'package.json'))
    const pkg = req('@deepseek-ai/dsh/package.json')
    const hit = typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
    trace.push({ probe: 'home-global', hit, note: hit ? '兜底命中——home 全局版本可能陈旧' : null })
    return hit
  } catch {
    trace.push({ probe: 'home-global', hit: null })
    return null
  }
}

export function readHostVersion(dshHome) {
  return collectHostVersion(dshHome, [])
}

/** host-debug 路由用：版本 + 每级探针轨迹 */
export function readHostVersionDebug(dshHome) {
  const trace = []
  return { version: collectHostVersion(dshHome, trace), trace }
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
 * 解析 agent.cordis.v2.yml（v2 组合源，patch 形态）为声明行数组。`!!js` 先
 * 中和（见 preprocessPatchText）；顶层必须是单元素数组、唯一元素带非空 insert
 * 数组（6 条 preset 声明行），不合形即抛——坏了宁可 fail-open 也不写半截块。
 */
export function parsePresetRows(yaml, agentCordisV2Text) {
  const data = yaml.parse(preprocessPatchText(agentCordisV2Text))
  if (!Array.isArray(data) || data.length !== 1 || data[0] === null || typeof data[0] !== 'object' || Array.isArray(data[0])) {
    throw new Error('agent.cordis.v2.yml 顶层必须是单元素数组，唯一元素为带 insert 键的映射')
  }
  const rows = data[0].insert
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('agent.cordis.v2.yml 缺少非空 insert 数组')
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || typeof row.name !== 'string') {
      throw new Error('agent.cordis.v2.yml 的 insert 数组里存在不合形的声明行（缺 id/name）')
    }
  }
  return rows
}

/**
 * 按宿主版本组装托管块声明行数组（双形态的唯一决策点）：
 *   - 宿主 ≥ 0.2.1-rc.2（hostRejectsInlineDelegation）→ 'v2'：解析
 *     agent.cordis.v2.yml，返回 6 条声明行（主编 preset + 5 张角色 preset，
 *     委派行 agentPreset 形状）；
 *   - 否则（含版本读不到的保守侧）→ 'v1'：现有单行组装路径原样（内联
 *     persona/toolFilter 形状）。
 * yaml 包不可用或组合源解析失败时 rows 返回 null（shape/hostVersion 照常带回，
 * reason 区分 'yaml-unavailable' / 'compose-failed'），由调用方走既有的「只落
 * 文件、跳过声明行并 warn、下次自愈」分支。
 */
export function composeManagedRows(home, logger = console) {
  const hostVersion = readHostVersion(home)
  const useV2 = hostVersion !== null && hostRejectsInlineDelegation(hostVersion)
  const shape = useV2 ? 'v2' : 'v1'
  const yaml = loadYamlLib(home)
  if (!yaml) return { shape, rows: null, hostVersion, yaml: null, reason: 'yaml-unavailable' }
  try {
    if (useV2) {
      const text = readFileSync(path.join(PLUGIN_ROOT, 'presets', PRESET_ID, AGENT_CORDIS_V2_FILE), 'utf8')
      return { shape, rows: parsePresetRows(yaml, text), hostVersion, yaml, reason: null }
    }
    const sourceDir = path.join(PLUGIN_ROOT, 'presets', PRESET_ID)
    const meta = parsePresetMeta(yaml, readFileSync(path.join(sourceDir, 'preset.yml'), 'utf8'))
    const plugins = parseAgentPlugins(yaml, readFileSync(path.join(sourceDir, 'agent.cordis.yml'), 'utf8'))
    // rows 统一为 insert 列表（stringifyManagedBlock 据此渲染同一 - insert: 结构；
    // 与 v1 历史产物逐字节同形，老 home 升级零抖动）
    return { shape, rows: buildPresetRow({ meta, plugins }).insert, hostVersion, yaml, reason: null }
  } catch (err) {
    logger.warn?.(`maoying-installer: 组合源解析失败（${shape} 形态，已跳过声明行）: ${err?.message ?? err}`)
    return { shape, rows: null, hostVersion, yaml, reason: 'compose-failed' }
  }
}

/**
 * 序列化声明行为托管块正文（不含起止标记）。参数 rows 是 insert 列表
 * （v1 一行 / v2 六行），统一渲染为同一 `- insert:` 列表结构；yaml 可用走
 * YAML 块形态，yaml 不可用回退为整段 JSON 单行（YAML 1.2 是 JSON 超集，
 * 宿主解析无感）。
 */
export function stringifyManagedBlock(yaml, rows) {
  const doc = [{ insert: Array.isArray(rows) ? rows : [rows] }]
  if (yaml) {
    // lineWidth: 0 关掉自动折行——plain 标量折行虽合法但产物不可读、diff 噪音大
    return `${MANAGED_BEGIN}\n${yaml.stringify(doc, { lineWidth: 0 }).replace(/\n+$/, '')}\n${MANAGED_END}`
  }
  return `${MANAGED_BEGIN}\n${JSON.stringify(doc)}\n${MANAGED_END}`
}

// ── home patch 托管块手术 ───────────────────────────────────────────────────

/**
 * 在行数组里定位托管块 [begin, end]（闭区间下标）。无起始标记返回 null；
 * 有起始无结束（托管块损坏，多半是手工删了半截）throw——拒绝写盘，绝不覆盖
 * 手工内容。
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

// ── 方法论技能落盘 ──────────────────────────────────────────────────────────

/** 技能源目录（包内 skills/）。 */
const SKILLS_SOURCE_DIR = path.join(PLUGIN_ROOT, 'skills')

/** 只搬 maoying-* 前缀的技能目录——<home>/skills 里用户自己的技能绝不触碰。 */
const SKILL_DIR_PREFIX = 'maoying-'

/**
 * 递归收集目录下全部文件的相对路径（POSIX 分隔）。目录打不开/不存在返回
 * []，由调用方兜底。
 */
function listSkillFiles(dir, relBase = '') {
  const files = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
    if (entry.isDirectory()) files.push(...listSkillFiles(path.join(dir, entry.name), rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

/**
 * 把包内 skills/ 的 maoying-* 技能目录复制到 <home>/skills/<name>/：
 *   - 文件逐字节比较（Buffer.equals），内容一致不写（保住 mtime，二跑零写盘）；
 *   - 每个技能目录落 .installed-version 标记（语义同预设标记：一致不重写）；
 *   - <home>/skills 不存在则递归创建；非 maoying-* 前缀的目录一概不看。
 * 返回本次有复制动作的技能目录名列表。单个技能失败只 warn 不拖累其余。
 */
export function installSkills(dshHome, { version, logger = console } = {}) {
  const copied = []
  let entries
  try {
    entries = readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true })
  } catch (err) {
    logger.warn?.(`maoying-installer: 读取包内技能目录 ${SKILLS_SOURCE_DIR} 失败（已跳过技能落盘）: ${err?.message ?? err}`)
    return copied
  }
  const skillsHome = path.join(dshHome, 'skills')
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith(SKILL_DIR_PREFIX)) continue
    const srcDir = path.join(SKILLS_SOURCE_DIR, entry.name)
    const dstDir = path.join(skillsHome, entry.name)
    let touched = false
    try {
      for (const rel of listSkillFiles(srcDir)) {
        const src = path.join(srcDir, rel)
        const dst = path.join(dstDir, rel)
        let same = false
        try {
          same = existsSync(dst) && readFileSync(dst).equals(readFileSync(src))
        } catch {
          same = false
        }
        if (!same) {
          mkdirSync(path.dirname(dst), { recursive: true })
          copyFileSync(src, dst)
          touched = true
        }
      }
      const markerPath = path.join(dstDir, '.installed-version')
      try {
        const current = existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === version
        if (!current) writeFileSync(markerPath, `${version}\n`, 'utf8')
      } catch (err) {
        logger.warn?.(`maoying-installer: 技能 ${entry.name} 的 .installed-version 标记写入失败（不影响技能本体）: ${err?.message ?? err}`)
      }
    } catch (err) {
      logger.warn?.(`maoying-installer: 技能 ${entry.name} 落盘失败（已跳过，不影响其他技能与预设）: ${err?.message ?? err}`)
    }
    if (touched) copied.push(entry.name)
  }
  return copied
}

// ── 创作台面板：/api/maoying/* 路由（三期）─────────────────────────────────
//
// 要点：
//   · 宿主路由自带信任围栏只挂在 /api 网关上；/api/maoying 前缀更长，
//     webserver 最长前缀优先会命中本插件而绕过网关围栏，故在此复刻同一
//     围栏语义（Host 回环或 webRuntime.trustedHosts + 拒 cross-site +
//     origin 同源校验）。
//   · 所有响应 JSON；错误形状统一 { ok: false, error }（读路由按契约可省
//     ok），状态码 403/404/409/413/422/500 语义见 docs/creator-panel.md §2。
//   · 业务读写全部在 lib/panel-core.mjs，这里只做围栏与分发。

function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

/** 回环地址判定：localhost、[::1] 与 127.0.0.0/8 全段。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** Host 头是否落在部署信任列表（精确 host:port，或裸 hostname 放行全端口）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts ?? []).some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return entryUrl.port === ''
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 信任围栏：Host 必须回环或在部署信任表里（防 DNS-rebinding），再拒绝
 * cross-site 浏览器请求；带了 origin 头的还须与 Host 同源。无认证部署的
 * 唯一一道门，任何一步拿不准都按不受信处理。
 */
function isTrustedApiRequest(req, trustedHosts) {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).hostname === hostUrl.hostname } catch { return false }
}

/**
 * 读 JSON 请求体（限额 5MB）。超限 413、非法 JSON 400——错误带 statusCode，
 * 外层 catch 据此回对应状态码；客户端提前断开时 reject（响应已发出的场景
 * Promise 已结算，reject 是无害 no-op）。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 5 * 1024 * 1024) {
        const err = new Error('request body too large')
        err.statusCode = 413
        reject(err)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        const err = new Error('invalid JSON body')
        err.statusCode = 400
        reject(err)
      }
    })
    req.on('error', reject)
    req.on('close', () => reject(new Error('request closed before body completed')))
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

function json(res, status, payload) {
  const text = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

// 错误原文（可能带本机绝对路径）只进日志；回给浏览器的 message 先把插件
// 安装根与 home 目录替换成 ~ 再说。
const SANITIZE_HOME_DIR = path.resolve(os.homedir())
const SANITIZE_PLUGIN_ROOT = PLUGIN_ROOT.replace(/[\\/]+$/, '')

function sanitizeMessage(message) {
  let text = String(message ?? '')
  // 先长后短：安装根通常是 home 的子路径，先替换更具体的
  text = text.split(SANITIZE_PLUGIN_ROOT).join('~')
  text = text.split(SANITIZE_HOME_DIR).join('~')
  return text
}

// 宿主热切换竞态兜底：「禁用→启用」等操作会重建插件条目纤维，新 apply 先
// 跑、旧实例的路由注销异步落地，注册瞬间旧路由常仍在表里，webServer.register
// 对同 (kind, path) 抛 duplicate。只对 duplicate prefix route 这一种错误短
// 重试等旧注销落地；其余错误原样抛出，真组合冲突不掩盖。
const DUPLICATE_PREFIX_ROUTE_RE = /^webserver: duplicate prefix route "/

/** 带兜底重试的路由注册：仅对 duplicate prefix route 错误重试，其余立即抛出。 */
export async function registerPrefixRouteWithRetry(webServer, route, { attempts = 8, delayMs = 30 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return webServer.register(route)
    } catch (err) {
      if (!DUPLICATE_PREFIX_ROUTE_RE.test(String(err?.message ?? ''))) throw err
      lastError = err
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

/**
 * 注册创作台全部路由（docs/creator-panel.md §2 的 8 条）。返回宿主 disposer；
 * webServer 缺席（非 web 部署）时抛错，由 apply 侧统一降级为 warn。
 */
export async function registerCreatorRoutes(ctx) {
  const webServer = ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('webServer 服务不可用（非 web 部署），创作台路由无处注册')
  }
  // webRuntime 由宿主 web-runtime 行提供；非 web 部署缺失时退化为仅回环信任。
  // 每请求实时读，trustedHosts 变化无需重启插件；读取自捕——围栏检查不能以
  // unhandled rejection 收场，读不到按空信任表继续。
  const trustedHostsOf = () => {
    try { return ctx.get('webRuntime')?.trustedHosts ?? [] } catch { return [] }
  }

  return registerPrefixRouteWithRetry(webServer, {
    kind: 'prefix',
    path: '/api/maoying',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHostsOf())) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url, 'http://dsh.internal')
      const route = url.pathname.replace(/^\/api\/maoying\/?/, '')
      try {
        // ── 静态样式：面板 CSS 正文（lib/base.css）按请求现读下发 ──────────
        // 客户端只注入 <link href="/api/maoying/client.css">，正文现读——
        // 改样式无需重启，GUI 刷新即生效（no-cache）。同前缀、已被围栏把关。
        if (route === 'client.css' && req.method === 'GET') {
          try {
            const css = await readFile(new URL('./lib/base.css', import.meta.url), 'utf8')
            res.writeHead(200, {
              'content-type': 'text/css; charset=utf-8',
              'content-length': Buffer.byteLength(css),
              'cache-control': 'no-cache',
            })
            res.end(css)
          } catch (err) {
            ctx.logger?.warn?.('maoying 创作台: client.css 读取失败: ' + String(err?.message ?? err))
            json(res, 500, { ok: false, error: sanitizeMessage(`client.css 不可用: ${err?.message ?? err}`) })
          }
          return
        }

        if (route === 'host-debug' && req.method === 'GET') {
          // 现场诊断：宿主版本五级探针轨迹 + 形状判定。与 client.css 同级信任
          // 围栏（loopback + 可信 Host 才放行），只暴露版本与路径类信息。
          const home = resolveDshHome()
          const dbg = readHostVersionDebug(home)
          let shape = null
          try { shape = composeManagedRows(home, ctx.logger).shape } catch { /* 诊断信息尽力而为 */ }
          json(res, 200, {
            ok: true,
            hostVersion: dbg.version,
            trace: dbg.trace,
            shape,
            runtime: {
              argv: process.argv,
              execPath: process.execPath,
              cwd: process.cwd(),
              electron: process.versions?.electron ?? null,
              node: process.version,
            },
          })
          return
        }

        if (route === 'workspaces' && req.method === 'GET') {
          // 工作区清单：宿主注册表逐根探测 novel/project.yml，面板顶部
          // 工作区选择器取数（hasNovel 的排前由客户端做，这里保序即可）。
          json(res, 200, { ok: true, workspaces: listWorkspaces(ctx.workspaceRegistry) })
          return
        }

        if (route === 'state' && req.method === 'GET') {
          // 全量快照（§3 契约）：path 钉死在注册表白名单内后才进解析层；
          // 单个坏文件进 warnings 不炸快照。
          const novelDir = resolveNovelRoot(url.searchParams.get('path'), ctx.workspaceRegistry)
          json(res, 200, parseStateSnapshot(novelDir))
          return
        }

        if (route === 'chapter' && req.method === 'GET') {
          // 章节正文全文（抽屉用）：file 只认 chapters/ 下纯文件名；响应组装
          // 直传 readChapter 结果（五期起含对应章纲 outline 字段，无章纲为
          // null），照 §2 契约 { ok, file, frontmatter, body, outline }。
          const novelDir = resolveNovelRoot(url.searchParams.get('path'), ctx.workspaceRegistry)
          json(res, 200, readChapter(novelDir, url.searchParams.get('file')))
          return
        }

        if (route === 'chapter-status' && req.method === 'POST') {
          const body = await readBody(req)
          const novelDir = resolveNovelRoot(body.path, ctx.workspaceRegistry)
          json(res, 200, mutateChapterStatus(novelDir, body.file, body.status))
          return
        }

        if (route === 'foreshadow-status' && req.method === 'POST') {
          const body = await readBody(req)
          const novelDir = resolveNovelRoot(body.path, ctx.workspaceRegistry)
          json(res, 200, mutateForeshadowStatus(novelDir, body.id, body.status))
          return
        }

        if (route === 'phase' && req.method === 'POST') {
          const body = await readBody(req)
          const novelDir = resolveNovelRoot(body.path, ctx.workspaceRegistry)
          json(res, 200, mutatePhase(novelDir, body.phase))
          return
        }

        if (route === 'rebuild-index' && req.method === 'POST') {
          const body = await readBody(req)
          const novelDir = resolveNovelRoot(body.path, ctx.workspaceRegistry)
          json(res, 200, rebuildIndex(novelDir))
          return
        }

        json(res, 404, { ok: false, error: `no such route: ${req.method} /api/maoying/${route}` })
      } catch (err) {
        // 错误原文（可能带本机绝对路径）留日志；对外 message 先脱敏。读体的
        // 413/400 带 statusCode，按其状态码回；其余业务错误自带码，裸异常 500。
        ctx.logger?.warn?.('maoying 创作台: 请求处理失败: ' + String(err?.message ?? err))
        json(res, Number.isInteger(err?.statusCode) ? err.statusCode : 500, {
          ok: false,
          error: sanitizeMessage(err?.message ?? String(err)),
        })
      }
    },
  })
}

// ── 安装主流程 ──────────────────────────────────────────────────────────────

/**
 * 幂等安装毛颖预设。步骤彼此独立、各自可失败：
 *   1) 预设文件落盘（不依赖 yaml，任何情况都先做）；
 *   2) .installed-version 标记（内容与当前版本一致即不重写）；
 *   3) 方法论技能落盘到 <home>/skills/maoying-*（不依赖 yaml，独立可失败）；
 *   4) home patch 托管块（依赖 yaml；形态随宿主版本，见 composeManagedRows；
 *      yaml 缺席或组合源坏时跳过并 warn，下次启动自愈）。
 * 返回 { status, home, presetDir, copied, skillsCopied, blockAction, reason,
 * shape, hostVersion }，status 取 'ok'（全链路完成）| 'partial'（托管块未写，
 * 原因见 reason）；shape 为本次所选委派行形态（'v1' | 'v2'）；skillsCopied 为
 * 本次有复制动作的技能目录名列表。
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

  // 3) 方法论技能落盘（与 yaml 无关；装不上不拖累预设，下次启动自愈）
  let skillsCopied = []
  try {
    skillsCopied = installSkills(home, { version, logger })
  } catch (err) {
    logger.warn?.(`maoying-installer: 技能落盘失败（已跳过，不影响预设本体）: ${err?.message ?? err}`)
  }

  // 4) home patch 托管块（v1 内联形状 / v2 AgentPreset 形状，随宿主版本切换）
  const composed = composeManagedRows(home, logger)
  const { shape, hostVersion } = composed
  if (composed.rows === null) {
    logger.warn?.(
      composed.reason === 'yaml-unavailable'
        ? 'maoying-installer: <home>/node_modules 下找不到 yaml 包，无法解析预设组合——' +
            '预设文件已复制，但 cordis.patch.yml 声明行本次跳过，下次宿主启动自动补写'
        : 'maoying-installer: 预设组合源解析失败——预设文件已复制，但 cordis.patch.yml 声明行本次跳过，' +
            '修复后下次宿主启动自动补写（详见上方 warn）',
    )
    return {
      status: 'partial',
      home,
      presetDir,
      copied,
      skillsCopied,
      blockAction: null,
      reason: composed.reason,
      shape,
      hostVersion,
    }
  }

  const blockText = stringifyManagedBlock(composed.yaml, composed.rows)
  const blockAction = upsertManagedBlock(home, blockText, { versionMarkerCurrent: markerCurrent })

  if (copied.length > 0) {
    logger.info?.(`maoying-installer: 预设文件已更新 ${PRESET_ID}: ${copied.join(', ')}`)
  }
  if (skillsCopied.length > 0) {
    logger.info?.(`maoying-installer: 方法论技能已落盘 <home>/skills: ${skillsCopied.join(', ')}`)
  }
  if (blockAction === 'skipped') {
    logger.info?.(`maoying-installer: 预设 ${PRESET_ID} 已就绪（v${version}，声明行与文件均无变化）`)
  } else if (blockAction === 'updated') {
    logger.info?.(`maoying-installer: cordis.patch.yml 托管块已按 v${version} 重写`)
  } else if (blockAction === 'created') {
    logger.info?.(`maoying-installer: cordis.patch.yml 托管块已写入（v${version}）`)
  }
  logger.info?.(
    shape === 'v2'
      ? `maoying-installer: 委派行形状 v2（AgentPreset，宿主 DSH ${hostVersion ?? '版本未知'}）`
      : `maoying-installer: 委派行形状 v1（内联 persona/toolFilter，宿主 DSH ${hostVersion ?? '版本未知'}）`,
  )
  return { status: 'ok', home, presetDir, copied, skillsCopied, blockAction, reason: null, shape, hostVersion }
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

  // 注：0.2.1-rc.2+ 的内联委派行守卫已由 v2 AgentPreset 形态适配（composeManagedRows
  // 按宿主版本自动选形状，所选形态带在安装日志里），不再需要降级提示。

  // 创作台路由（三期）：与安装段彼此独立——注册失败只 warn，面板不可用不
  // 拖累安装器语义。注册是异步的（含 duplicate 短重试），这里挂 .catch 兜住
  // 异步失败；同步抛错走外层 try/catch，两条路都不让异常冒出 apply。
  try {
    registerCreatorRoutes(ctx).catch((error) => {
      logger.warn?.(`毛颖创作台路由注册失败（面板不可用，其余功能不受影响）: ${error?.message ?? error}`)
    })
  } catch (error) {
    logger.warn?.(`毛颖创作台路由注册失败（面板不可用，其余功能不受影响）: ${error?.message ?? error}`)
  }
}
