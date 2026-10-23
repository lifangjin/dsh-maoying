/**
 * panel-core —— 毛颖创作台的业务层（Node 侧）
 *
 * 路由层（index.mjs 的 registerCreatorRoutes）只做围栏与分发，全部读写语义
 * 都收在这里，方便 node:test 直接对函数断言：
 *
 *   读取面
 *     listWorkspaces(registry)     工作区清单 + 是否已有 novel 项目
 *     resolveNovelRoot(root, reg)  把 path 参数钉死在注册表白名单内的根上
 *     parseStateSnapshot(novelDir) docs/creator-panel.md §3 的全量快照
 *                                  （五期起含 outlines 章纲清单）
 *     readChapter(novelDir, file)  章节正文全文（抽屉用；五期起带对应章纲
 *                                  outline 字段，二者各带原文 sha256 hash——
 *                                  面板正文/章纲编辑保存的 base_hash 基线）
 *     readOutlineFile(novelDir, file) 章纲全文（章纲弹层用；0.1.15 起按单
 *                                  写作的未建章章纲可看全文）
 *     projectFileHash(novelDir)    project.yml 原文 sha256 hex（快照
 *                                  project_hash / 保存旧版检测共用基线）
 *     readStyleState(novelDir)     写作风格基准 novel/style.md 全文 + 指纹 +
 *                                  插件模板全文（面板「写作风格」tab 取数，
 *                                  found:false 表示文件尚未创建、不是错误）
 *
 *   写入面（行级原地替换三件套：读原文 → 手术 → 写后校验替换计数 === 1；
 *   计数不符或目标行缺失一律 409 拒写不落盘，把对 git diff 的扰动压到最小。
 *   createChapterFromOutline 是例外之一——它从章纲落一个全新章节文件，不动
 *   任何既有文件的字节；saveStyleText 是例外之二——style.md 是纯 markdown
 *   基准文档、无 frontmatter/行级键位可言，整文件覆写就是它的最小手术；
 *   mutateChapterBody 是例外之三——正文是自由形态文本，写原语是「frontmatter
 *   围栏定位 + 围栏后整段替换」，围栏（含）之前逐字节保留；mutateOutlineBody
 *   是例外之四——章纲纯 markdown，整文件替换。后四者写前都读原文比对
 *   baseHash（人工改动保护与 mutateProject 同口径））
 *     mutateChapterStatus     章节 frontmatter 的 status 行
 *     mutateForeshadowStatus  foreshadows.yml 对应 id 条目块内的 status 行
 *     mutatePhase             project.yml 的 phase 行
 *     rebuildIndex            复用 lib/novel-parse 的 buildIndexYaml 重建
 *     createChapterFromOutline   从章纲建章（chapters/ 落 pending 空章，0.1.15）
 *     saveStyleText           写作风格基准整文件覆写（novel/style.md，0.1.19）
 *     mutateChapterBody       章节正文整段替换（面板正文编辑态保存）
 *     mutateOutlineBody       章纲整文件替换（面板章纲对照栏编辑态保存）
 *
 *   受管文件面（0.2.x「全量可编辑写面」：白名单内的账本 yml / md 实体卡 /
 *   章纲 / 章节删除走通用通道；白名单与结构校验口径见文末该节注释）
 *     managedRelCheck         rel 白名单校验（按操作分类）
 *     validateManagedText     保存/新建前的结构校验（解析失败/缺围栏 422）
 *     readManagedFile         读全文 + 指纹（file-source）
 *     saveManagedFile         整文件覆写 + 409 过期基线保护（file-save）
 *     createManagedFile       新建（已存在 409）（file-create）
 *     deleteManagedFile       删除（不存在 404，UI 层二次确认）（file-delete）
 *
 * 错误约定：本模块抛 PanelError（带 statusCode），路由层按 statusCode 回
 * JSON（403 拒绝 / 404 找不到 / 409 拒写 / 422 入参不合法）；未带状态码的
 * 异常一律按 500 兜底。绝不静默吞错。
 *
 * 解析口径：yaml 包（lib/yaml-loader.mjs 从 dsh home 借）可用时走真解析；
 * 不可用回退到 lib/novel-parse 的极简子集解析。任何单个坏文件只记 warnings，
 * 绝不让它炸掉整个快照。
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { buildIndexYaml, canonicalVolume, chapterSortKey, collectChapters, countCjk, FIVE_DIM_KEYS, parseFlatYamlArray, parseScalarText, sha256Hex, splitFrontmatter, stripInlineComment } from './novel-parse.mjs'
import { loadYamlLib, resolveDshHome } from './yaml-loader.mjs'

/** 章节状态机（与 lib/novel-parse 的表同源：只取键）。 */
export const CHAPTER_STATUS_KEYS = ['pending', 'writing', 'review', 'accepted']

/** 伏笔状态机（foreshadows.yml 的 status 枚举）。 */
export const FORESHADOW_STATUS_KEYS = ['planted', 'progressing', 'resolved', 'abandoned']

/** 七阶段工作流（project.yml 的 phase 枚举）。 */
export const PHASE_KEYS = ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export']

/** 带状态码的请求语义错误：路由层按 statusCode 回 JSON，未带按 500。 */
export class PanelError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'PanelError'
    this.statusCode = statusCode
  }
}

/** 抛出带状态码的业务错误。 */
function fail(statusCode, message) {
  throw new PanelError(statusCode, message)
}

// ── 字段缺省口径：标量缺省 null，数组缺省 []（§3 契约）─────────────────────

function strOrNull(value) {
  return typeof value === 'string' ? value : null
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

/**
 * 字符串数组字段（markers / tags / references）：数组取字符串元素；其余形状
 * 一律空数组——回退解析器极端情况下可能给出折行字符串，不把脏形状漏给面板。
 */
function strArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

/** slug 兜底名：lin-waner.md → lin-waner（world / science 条目的 name 来源）。 */
function slugName(file) {
  return String(file ?? '').replace(/\.md$/i, '')
}

// ── 工作区清单与路径安全 ────────────────────────────────────────────────────

/**
 * 工作区清单：registry.list() 逐根探测 <root>/novel/project.yml。返回
 * [{ path, name, hasNovel }]；list 不可用视为空注册表（全部 403 由
 * resolveNovelRoot 兜住），不在本层放大成崩溃。
 */
export function listWorkspaces(workspaceRegistry) {
  let entries = []
  try {
    const listed = workspaceRegistry?.list?.()
    if (Array.isArray(listed)) entries = listed
  } catch {
    entries = []
  }
  return entries.flatMap((entry) => {
    const root = typeof entry?.path === 'string' && entry.path.trim() !== '' ? entry.path : null
    if (root === null) return []
    const resolved = path.resolve(root)
    const name =
      typeof entry.title === 'string' && entry.title !== '' ? entry.title
      : typeof entry.name === 'string' && entry.name !== '' ? entry.name
      : path.basename(resolved)
    return [{ path: resolved, name, hasNovel: existsSync(path.join(resolved, 'novel', 'project.yml')) }]
  })
}

/**
 * path 参数的安全校验：resolve 后与注册表里的某个根严格相等才放行（不做
 * 子路径、不做 ~ 展开）；放行时返回该工作区的 novel 目录，否则 403。
 */
export function resolveNovelRoot(root, workspaceRegistry) {
  if (typeof root !== 'string' || root.trim() === '') fail(422, '缺少 path 参数（workspace 根目录绝对路径）')
  const wanted = path.resolve(root)
  const allowed = new Set(listWorkspaces(workspaceRegistry).map((w) => w.path))
  if (!allowed.has(wanted)) fail(403, `path 不在已注册工作区内，已拒绝：${wanted}`)
  return path.join(wanted, 'novel')
}

/**
 * file 参数的安全校验：只认纯文件名——带任何路径分隔符或 `.`/`..` 片段的
 * 一律 403（穿越防护在入口处一刀切，不靠后续 resolve 兜底）。
 */
function safeFileName(file, label) {
  if (typeof file !== 'string' || file.trim() === '') fail(422, `缺少 ${label} 参数（文件名）`)
  if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') {
    fail(403, `${label} 只接受 chapters/ 下的纯文件名，已拒绝：${file}`)
  }
  return file
}

/**
 * 章节文件定位：name 已过 safeFileName，这里再做一道 resolve 包含校验
 * （dirname 必须恰好是 chapters/），双保险防符号形状的意外。
 */
function locateChapter(novelDir, file) {
  const name = safeFileName(file, 'file')
  const dir = path.resolve(path.join(novelDir, 'chapters'))
  const target = path.resolve(dir, name)
  if (path.dirname(target) !== dir) fail(403, `章节路径越界，已拒绝：${name}`)
  return { name, target }
}

/** 读工作区内的文本文件；不存在 404，其他读失败原样带码上抛。 */
function readTarget(target, label) {
  let text = null
  try {
    text = readFileSync(target, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') fail(404, `${label} 不存在：${path.basename(target)}`)
    fail(500, `${label} 读取失败（${err?.code ?? err?.message ?? err}）`)
  }
  return text
}

/**
 * 单行替换手术：lineRe 每次全新按多行模式匹配，命中计数必须恰好为 1，
 * 否则 409 拒写（0 处 = 目标行缺失；多处 = 文件形状不明，宁可不写）。
 */
function replaceLineOnce(text, lineRe, replacement, { what }) {
  const re = new RegExp(lineRe.source, 'gm')
  const hits = text.match(re) ?? []
  if (hits.length !== 1) fail(409, `${what} 应恰有一处，实得 ${hits.length} 处——已拒绝写入`)
  return text.replace(re, replacement)
}

/** 还原换行风格：原文以 \r\n 为主就用 \r\n 拼回，否则 \n。 */
function joinLines(lines, originalText) {
  const eol = originalText.includes('\r\n') ? '\r\n' : '\n'
  return lines.join(eol)
}

/**
 * 原子落盘：先写同目录临时文件，再 renameSync 原子替换——truncate+write
 * 直写期间并发读会看到半截文件，rename 在同一文件系统上不存在中间态。
 * 临时文件藏在同目录（保证 rename 跨设备语义成立），失败时扫尾后原样上抛。
 */
function writeAtomic(target, data) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 临时文件没立起来就没什么可扫 */ }
    throw err
  }
}

// ── frontmatter 解析（yaml 可用走真解析，否则正则平键 + 条目块）───────────

/**
 * frontmatter 的回退解析：逐行平键 + `key:` 空值后跟缩进 `- 项` 的条目块。
 * 覆盖本项目数据规范里的全部形状（标量 / markers、tags、references 这类
 * 一层列表）；规范禁止深嵌套，超出形状的行原样忽略。
 */
function parseFrontmatterFallback(raw) {
  const meta = Object.create(null) // 无原型对象：__proto__ 键只进自身属性，改写不了原型
  let listKey = null
  for (const line of raw.split(/\r?\n/)) {
    const clean = stripInlineComment(line).replace(/\s+$/, '')
    if (clean.trim() === '') continue
    const listItem = /^[ \t]+-[ \t]+(.*)$/.exec(clean)
    if (listItem !== null && listKey !== null) {
      if (!Array.isArray(meta[listKey])) meta[listKey] = [] // 空值键遇到首项再升级成数组
      meta[listKey].push(parseScalarText(listItem[1]))
      continue
    }
    const kv = /^([^:#]+):[ \t]*(.*)$/.exec(clean.trim())
    if (kv === null || clean.match(/^[ \t]*/)[0].length > 0) continue // 只认顶层平键，嵌套形状不认
    const key = kv[1].trim().replace(/^['"]|['"]$/g, '')
    if (key === '') continue
    const value = kv[2]
    if (value === '') {
      meta[key] = '' // 先按空串记；紧跟的列表项会把它升级成数组
      listKey = key
    } else {
      meta[key] = parseScalarText(value)
      listKey = null
    }
  }
  return meta
}

/**
 * 解析 frontmatter：yamlLib 给出非映射结果或抛错时逐级回退，永不抛出。
 * 返回 { meta, body }（meta 恒为普通对象）。
 */
function parseFrontmatterMeta(text, yamlLib) {
  const { raw, body } = splitFrontmatter(text)
  if (raw === null) return { meta: {}, body }
  if (yamlLib) {
    try {
      const parsed = yamlLib.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { meta: parsed, body }
      }
    } catch {
      /* yaml 真解析不认——落到极简回退 */
    }
  }
  return { meta: parseFrontmatterFallback(raw), body }
}

/** 面板侧的 yaml 包解析：参数未指定时按 dsh home 现场惰性加载（可传 null 强制回退）。 */
function yamlLibOf(options) {
  return options?.yamlLib !== undefined ? options.yamlLib : loadYamlLib(resolveDshHome())
}

// ── state 快照 ──────────────────────────────────────────────────────────────

/**
 * 章纲节选原料（五期「按单写作」取数）：折叠全部空白字符后取前 120 字；
 * 面板侧展示时再截 60 字，这里多留余量供 title 悬浮。
 */
function outlineExcerpt(text) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed
}

/**
 * outlines/ 章纲清单（五期，docs/design.md §9.3）：扫 <novel>/outlines/*.md，
 * 只收 stem 合乎 v{vol}-c{num} 规范的文件，chapter 指向同 stem 的章节文件名；
 * words 为章纲全文 CJK 计数（章纲纯 markdown 无 frontmatter）；excerpt 为
 * 面板「按单写作」区块的节选原料（契约 §3 之外的增量字段，见验收报告）。
 * 目录不存在按空表、不告警（老项目兼容）；stem 不合规范的散文件不列（无法
 * 映射章节）；孤儿章纲（无对应章节文件）照列——「章纲先于正文」是共创常态，
 * 与章节的联交由面板侧做。输出按 chapterSortKey（卷、章号）升序。
 */
function collectOutlines(novelDir, warnings) {
  const dir = path.join(novelDir, 'outlines')
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`outlines: 遍历失败（${err?.code ?? err?.message ?? err}）`)
    return []
  }
  const rows = []
  for (const name of names) {
    const stem = name.replace(/\.md$/i, '')
    const key = chapterSortKey(stem)
    if (key === null) continue
    let text = null
    try {
      text = readFileSync(path.join(dir, name), 'utf8')
    } catch (err) {
      warnings.push(`outlines/${name}: 读取失败（${err?.code ?? err?.message ?? err}）`)
      continue
    }
    rows.push({ key, row: { file: name, chapter: `${stem}.md`, words: countCjk(text), excerpt: outlineExcerpt(text) } })
  }
  rows.sort((a, b) => (a.key.vol !== b.key.vol ? a.key.vol - b.key.vol : a.key.num - b.key.num))
  return rows.map(({ row }) => row)
}

/**
 * 读取一个 md 实体目录（characters / world / science / research）：逐文件
 * 解析 frontmatter；目录不存在视为无实体（不算坏）；单个文件读不动只记
 * warnings，绝不拖垮快照。
 */
function collectMdEntities(novelDir, sub, yamlLib, warnings) {
  const dir = path.join(novelDir, sub)
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
  const entities = []
  for (const name of names) {
    try {
      const text = readFileSync(path.join(dir, name), 'utf8')
      const { meta, body } = parseFrontmatterMeta(text, yamlLib)
      entities.push({ file: name, meta, body })
    } catch (err) {
      warnings.push(`${sub}/${name}: 读取失败（${err?.code ?? err?.message ?? err}）`)
    }
  }
  return entities
}

/**
 * 读取顶层数组形态的 yml（relations / foreshadows / timeline / memories /
 * clue-board）：文件缺失按空表（模板允许删空）；解析失败或条目形状不对只记
 * warnings 并跳过该条。
 */
function collectArrayYml(novelDir, fileName, yamlLib, warnings) {
  const target = path.join(novelDir, fileName)
  let text = null
  try {
    text = readFileSync(target, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    warnings.push(`${fileName}: 读取失败（${err?.code ?? err?.message ?? err}）`)
    return []
  }
  let data = null
  if (yamlLib) {
    try {
      data = yamlLib.parse(text)
    } catch {
      data = null
    }
  }
  if (data === null || data === undefined) data = parseFlatYamlArray(text)
  if (!Array.isArray(data)) {
    warnings.push(`${fileName}: 顶层不是数组，已按空表处理`)
    return []
  }
  const rows = []
  data.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`${fileName}: 第 ${index + 1} 条不是键值映射，已跳过`)
      return
    }
    rows.push(item)
  })
  return rows
}

/** project.yml 平键读取：缺文件/坏文件都按 null 兜底，字段逐个补 null。 */
function readProject(novelDir, yamlLib, warnings) {
  const target = path.join(novelDir, 'project.yml')
  let data = null
  try {
    const text = readFileSync(target, 'utf8')
    if (yamlLib) {
      try {
        const parsed = yamlLib.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
      } catch {
        data = null
      }
    }
    if (data === null) {
      const fallback = parseFlatYamlArray(text)
      if (fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)) data = fallback
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`project.yml: 读取失败（${err?.code ?? err?.message ?? err}）`)
  }
  return {
    title: strOrNull(data?.title),
    author: strOrNull(data?.author),
    genre: strOrNull(data?.genre),
    length: strOrNull(data?.length),
    language: strOrNull(data?.language),
    phase: strOrNull(data?.phase),
    mode: strOrNull(data?.mode),
    description: strOrNull(data?.description),
  }
}

/** sha256 hex（小写）：从 novel-parse 引全仓库唯一实现，本文件不再私有手搓。 */

/**
 * project.yml 原文指纹（sha256 hex）：面板「人工改动保护」的基线。快照带出
 * project_hash，保存时回传 base_hash 比对——表单载入后文件被外部（作者手改
 * / agent 推进 phase）动过就能查觉，拒绝静默覆盖。读不到/读失败返回 null
 * （与「无 project.yml」同口径，不炸快照）。
 */
export function projectFileHash(novelDir) {
  let text = null
  try {
    text = readFileSync(path.join(path.resolve(novelDir), 'project.yml'), 'utf8')
  } catch {
    return null
  }
  return sha256Hex(text)
}

/**
 * 插件内置写作风格模板（templates/novel/style.md）全文：readStyleState 的
 * template 字段原料——style.md 尚未创建时，面板用它在编辑器里预填默认基线。
 * 每次现读（35 行小文件，不值得缓存）；读不到返回 null，面板据此禁用
 * 「用默认基线创建」按钮，不炸面板。
 */
function styleTemplateText() {
  try {
    return readFileSync(new URL('../templates/novel/style.md', import.meta.url), 'utf8')
  } catch {
    return null
  }
}

/**
 * 写作风格基准读取（0.1.19，面板「写作风格」tab 取数）：novel/style.md 存在
 * 则读全文 + sha256 指纹（hash 即保存路由 base_hash 的基线，口径与
 * projectFileHash 一致）；不存在返回 found:false、text/hash 为 null——文件
 * 尚未创建是常态不是错误，路由照 200 回，客户端空态引导创建。读失败不炸
 * （照 projectFileHash 的宽容口径，读不动一律按不存在处理）。template 恒为
 * 插件模板全文（读不到为 null）。
 */
export function readStyleState(novelDir) {
  const template = styleTemplateText()
  let text = null
  try {
    text = readFileSync(path.join(path.resolve(novelDir), 'style.md'), 'utf8')
  } catch {
    return { found: false, text: null, hash: null, template }
  }
  return { found: true, text, hash: sha256Hex(text), template }
}

/**
 * 写作风格基准保存（0.1.19，面板「写作风格」tab 的编辑态）：novel/style.md
 * 整文件覆写——纯 markdown 基准文档，无行级键位可言，整文件替换即最小手术
 * （「行级原地替换」纪律的例外，与 agent 的写法兼容：写前读、原子写）。
 *
 * 校验：text 非 string 422。人工改动保护与 mutateProject 同口径：options.
 * baseHash 是面板载入编辑器时的原文指纹，与写入前现读不一致 → 409 拒写；
 * 文件不存在且 baseHash 非 null 同样 409（调用方声称基于既有版本改，磁盘却
 * 无文件，宁可不写）；未传 baseHash 跳过检查（创建路径：文件不存在时直接
 * 落盘）。空文本允许保存（空文件 = 无风格基准，agent 侧优雅降级）。
 * 返回写后新指纹 hash，客户端下一轮 base_hash 直接取它。
 */
export function saveStyleText(novelDir, text, options = {}) {
  if (typeof text !== 'string') fail(422, 'text 必须是字符串（style.md 全文）')
  const target = path.join(path.resolve(novelDir), 'style.md')
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    current = null // 不存在（读不动也按不存在处理，宽容口径同 readStyleState）
  }
  const baseHash = typeof options.baseHash === 'string' ? options.baseHash.trim().toLowerCase() : ''
  if (baseHash !== '' && (current === null || baseHash !== sha256Hex(current))) {
    fail(409, 'style.md 已被外部修改，请刷新面板后基于最新内容重改再存')
  }
  writeAtomic(target, text)
  // 返回写后指纹：客户端下一轮保存的 base_hash 直接取它，不必再拉一次快照。
  return { ok: true, hash: sha256Hex(text) }
}

/**
 * 全量快照（docs/creator-panel.md §3，字段名冻结）。novelDir 为工作区的
 * novel 目录；project.yml 不在 = 未初始化（found: false，其余字段缺省）。
 * options.yamlLib 可显式指定 yaml 包或传 null 强制走极简回退（测试钉两路）。
 */
export function parseStateSnapshot(novelDir, options = {}) {
  const yamlLib = yamlLibOf(options)
  const dir = path.resolve(novelDir)
  const root = path.dirname(dir)
  const warnings = []

  if (!existsSync(path.join(dir, 'project.yml'))) {
    return { ok: true, root, novelDir: dir, found: false, project_hash: null, warnings }
  }

  const project = readProject(dir, yamlLib, warnings)
  // 人工改动保护基线：快照顶层带 project.yml 原文指纹，客户端保存时原样回传
  // （project-save 的 base_hash）；读不到为 null（不影响快照其余字段）。
  const projectHash = projectFileHash(dir)

  const chaptersRaw = (() => {
    try {
      return collectChapters(dir) ?? []
    } catch (err) {
      warnings.push(`chapters: 遍历失败（${err?.message ?? err}）`)
      return []
    }
  })()
  const chapters = chaptersRaw.map((ch) => ({
    file: ch.file,
    volume: ch.volume !== '' ? ch.volume : null,
    num: intOrNull(ch.num),
    title: ch.title,
    status: ch.status,
    words: ch.words,
    summary: ch.summary,
    cognitive_frame: ch.cognitive_frame !== '' ? ch.cognitive_frame : null,
    emotional_anchor: ch.emotional_anchor !== '' ? ch.emotional_anchor : null,
    world_texture: ch.world_texture !== '' ? ch.world_texture : null,
    suspense: ch.suspense !== '' ? ch.suspense : null,
    interpersonal_tension: ch.interpersonal_tension !== '' ? ch.interpersonal_tension : null,
  }))

  const characters = collectMdEntities(dir, 'characters', yamlLib, warnings).map(({ file, meta }) => ({
    file,
    name: strOrNull(meta.name) ?? slugName(file),
    age: intOrNull(meta.age),
    gender: strOrNull(meta.gender),
    role: strOrNull(meta.role),
    appearance: strOrNull(meta.appearance),
    personality: strOrNull(meta.personality),
    background: strOrNull(meta.background),
    motivation: strOrNull(meta.motivation),
    arc: strOrNull(meta.arc),
    markers: strArray(meta.markers),
  }))

  // 关系端点归一：契约规定 relations.yml 的 a/b 是角色 slug（characters/ 目录名），
  // 而关系图客户端按角色 name（卡 frontmatter name，缺省回落 slug）找节点——不出
  // 快照侧归一，带中文名的角色卡必然端点对不上、一条边都画不出。对得上角色卡的
  // 端点改写成 name；对不上的（已死亡/未建档角色，或历史条目直接写了 name）原样
  // 保留。novel-parse 侧（protagonistCards、relations 校验）仍按 slug 契约，不动。
  const nameBySlug = Object.fromEntries(
    characters.map((c) => [String(c.file ?? '').replace(/\.md$/i, ''), c.name])
  )

  const relations = collectArrayYml(dir, 'relations.yml', yamlLib, warnings).map((r) => ({
    a: strOrNull(r.a),
    b: strOrNull(r.b),
    type: strOrNull(r.type),
    description: strOrNull(r.description),
    intensity: intOrNull(r.intensity),
    started: strOrNull(r.started),
    ended: strOrNull(r.ended),
  })).map((r) => ({ ...r, a: nameBySlug[r.a] ?? r.a, b: nameBySlug[r.b] ?? r.b }))

  const foreshadows = collectArrayYml(dir, 'foreshadows.yml', yamlLib, warnings).map((f) => ({
    id: strOrNull(f.id),
    title: strOrNull(f.title),
    status: strOrNull(f.status),
    priority: strOrNull(f.priority),
    planted_chapter: strOrNull(f.planted_chapter),
    expected_resolve: strOrNull(f.expected_resolve),
    resolved_chapter: strOrNull(f.resolved_chapter),
    notes: strOrNull(f.notes),
    // source（五期账本回填，docs/design.md §9.4）：枚举 plan|backfill，
    // 合法 backfill 之外（含缺省）一律归 plan，字段恒落在契约枚举内。
    source: f.source === 'backfill' ? 'backfill' : 'plan',
  }))

  const timeline = collectArrayYml(dir, 'timeline.yml', yamlLib, warnings).map((t) => ({
    year: strOrNull(t.year),
    title: strOrNull(t.title),
    description: strOrNull(t.description),
    importance: intOrNull(t.importance),
    chapter: strOrNull(t.chapter),
  }))

  const memories = collectArrayYml(dir, 'memories.yml', yamlLib, warnings).map((m) => ({
    category: strOrNull(m.category),
    content: strOrNull(m.content),
    source_chapter: strOrNull(m.source_chapter),
  }))

  const clues = collectArrayYml(dir, 'clue-board.yml', yamlLib, warnings).map((c) => ({
    kind: strOrNull(c.kind),
    content: strOrNull(c.content),
    related_chapter: strOrNull(c.related_chapter),
    resolved: boolOrNull(c.resolved),
  }))

  const world = collectMdEntities(dir, 'world', yamlLib, warnings).map(({ file, meta, body }) => ({
    file,
    category: strOrNull(meta.category),
    tags: strArray(meta.tags),
    name: strOrNull(meta.name) ?? slugName(file),
    description: typeof body === 'string' ? body.trim() : '',
  }))

  const science = collectMdEntities(dir, 'science', yamlLib, warnings).map(({ file, meta, body }) => ({
    file,
    label: strOrNull(meta.label),
    name: strOrNull(meta.name) ?? slugName(file),
    description: typeof body === 'string' ? body.trim() : '',
    references: strArray(meta.references),
  }))

  const research = collectMdEntities(dir, 'research', yamlLib, warnings).map(({ file, meta, body }) => ({
    file,
    topic: strOrNull(meta.topic),
    sources: strArray(meta.sources),
    description: typeof body === 'string' ? body.trim() : '',
  }))

  const volumes = collectArrayYml(dir, 'volumes.yml', yamlLib, warnings).map((v) => ({
    id: strOrNull(v.id),
    title: strOrNull(v.title),
    summary: strOrNull(v.summary),
    chapters: strOrNull(v.chapters),
  }))

  const outlines = collectOutlines(dir, warnings)

  const byStatus = Object.fromEntries(CHAPTER_STATUS_KEYS.map((s) => [s, 0]))
  let words = 0
  for (const ch of chapters) {
    byStatus[ch.status] = (byStatus[ch.status] ?? 0) + 1
    words += ch.words
  }

  return {
    ok: true,
    root,
    novelDir: dir,
    found: true,
    project_hash: projectHash,
    project,
    chapters,
    characters,
    relations,
    foreshadows,
    timeline,
    memories,
    clues,
    volumes,
    world,
    science,
    research,
    outlines,
    totals: { chapters: chapters.length, words, byStatus },
    generatedAt: new Date().toISOString(),
    warnings,
  }
}

// ── 读路由的正文读取 ────────────────────────────────────────────────────────

/**
 * 章纲定位（readChapter 的 outline 字段，五期）：outlines/ 下与章节同 stem
 * 的文件。章纲纯 markdown 无 frontmatter，words 为全文 CJK 计数、body 为
 * 原文、hash 为原文 sha256（面板章纲编辑保存的 base_hash 基线，与 body 同源
 * 同刻读出——拆开读会有被外部改动的窗口）；无对应文件（含 outlines/ 目录不
 * 存在）返回 null——无章纲是常态，不告警。stem 已过 safeFileName，拼接结果
 * 不可能越出 novel 根。
 */
function readOutline(novelDir, stem) {
  let text = null
  try {
    text = readFileSync(path.join(path.resolve(novelDir), 'outlines', `${stem}.md`), 'utf8')
  } catch {
    return null
  }
  return { file: `${stem}.md`, words: countCjk(text), body: text, hash: sha256Hex(text) }
}

/**
 * 章节全文（抽屉用）：路径校验同写路由；frontmatter 以对象返回（yaml 可用
 * 走真解析，否则平键回退），body 为原文正文，hash 为章节文件原文 sha256
 * （人工改动保护：正文编辑态保存时作 base_hash 回传，外部改动 409 拒写）；
 * outline 为同 stem 章纲（{ file, words, body, hash }，无对应章纲时 null），
 * 章节抽屉的章纲对照栏取数。
 */
export function readChapter(novelDir, file, options = {}) {
  const { name, target } = locateChapter(novelDir, file)
  const text = readTarget(target, `章节 ${name}`)
  const { meta, body } = parseFrontmatterMeta(text, yamlLibOf(options))
  const outline = readOutline(novelDir, name.replace(/\.md$/i, ''))
  return { ok: true, file: name, frontmatter: meta, body, hash: sha256Hex(text), outline }
}

/**
 * 章纲文件名解析（readOutlineFile / createChapterFromOutline 共用的入口
 * 校验）：file 过 safeFileName 后必须 .md 结尾且 stem 合乎 vXX-cXXX 规范
 * （与 collectOutlines 的收录口径一致——不合规范的面板本就不列，路由侧
 * 一律 422 拒掉，不给穿越/探测留口子）。
 */
function outlineStemOf(file) {
  const name = safeFileName(file, 'file')
  if (!/\.md$/i.test(name)) fail(422, `非章纲文件名（只认 .md）：${name}`)
  const stem = name.replace(/\.md$/i, '')
  if (chapterSortKey(stem) === null) fail(422, `非章纲文件名（stem 不合 vXX-cXXX 规范）：${name}`)
  return stem
}

/**
 * 章纲全文（0.1.15 起面板「章纲弹层」用）：按单写作兼容未建章章纲后，
 * 孤儿章纲也要能看全文。章纲纯 markdown 无 frontmatter，body 即原文；
 * words 为全文 CJK 计数（口径与快照 outlines 一致）。章纲不存在 404。
 */
export function readOutlineFile(novelDir, file) {
  const stem = outlineStemOf(file)
  const outline = readOutline(novelDir, stem)
  if (outline === null) fail(404, `章纲不存在：outlines/${stem}.md`)
  return { ok: true, file: outline.file, words: outline.words, body: outline.body }
}

/**
 * 章纲标题提取（createChapterFromOutline 用）：取章纲正文首条 `#` 标题行
 * 文本，去结尾「章纲」二字（大纲师标题惯用后缀）后 trim；空则「（无标题）」
 * （与 collectChapters 的缺省标题同形）。
 */
function outlineTitleOf(body) {
  const hit = /^#[ \t]+(.+?)[ \t]*$/m.exec(String(body ?? ''))
  const title = (hit === null ? '' : hit[1]).replace(/章纲$/, '').trim()
  return title !== '' ? title : '（无标题）'
}

/**
 * 从章纲建章（0.1.15，面板「按单写作」的孤儿章纲一键建章）：在 chapters/
 * 下落一个 status=pending 的空章节——frontmatter 按 templates/novel/README.md
 * 的章节模板（volume/num/title/status/summary + 五维五键，值待写留空），
 * 正文留空。title 取章纲首条标题行（outlineTitleOf）。目标章节已存在 409
 * （先到先建，绝不覆盖既有正文）；章纲不存在 404。写前确保 chapters/ 目录
 * 在（手工项目 / 测试夹具可能还没建目录）。建章后走既有 pending 流转。
 */
export function createChapterFromOutline(novelDir, file) {
  const stem = outlineStemOf(file)
  const key = chapterSortKey(stem)
  const target = path.join(path.resolve(novelDir), 'chapters', `${stem}.md`)
  if (existsSync(target)) fail(409, `章节已存在：chapters/${stem}.md——无需重复建章`)
  const outline = readOutline(novelDir, stem)
  if (outline === null) fail(404, `章纲不存在：outlines/${stem}.md`)
  const title = outlineTitleOf(outline.body)
  const lines = [
    '---',
    `volume: ${canonicalVolume(key.vol)}`,
    `num: ${key.num}`,
    `title: ${yamlScalar(title)}`,
    'status: pending',
    `summary: ${yamlScalar('')}`,
    ...FIVE_DIM_KEYS.map((k) => `${k}: ${yamlScalar('')}`),
    '---',
  ]
  mkdirSync(path.dirname(target), { recursive: true })
  writeAtomic(target, `${lines.join('\n')}\n`)
  return { ok: true, file: `${stem}.md`, title }
}

// ── 正文/章纲写原语（面板编辑态保存）：自由形态 body，无行级键位可手术 ─────

/**
 * 章节正文保存（面板章节阅读页编辑态）：frontmatter 围栏（含闭合 --- 行）
 * 之前逐字节保留，围栏后整段替换——正文是自由形态文本，任何行级手术都会
 * 凭空改写作者的文字，整段替换才是最小干预；对 git diff 的扰动天然只落在
 * 正文段内。校验与拒写：
 *   - file 只认 chapters/ 下纯文件名（locateChapter 同款双保险，穿越 403）；
 *   - body 非 string 422；章节缺 frontmatter 围栏 422（先补齐再编辑）；
 *   - 章节不存在 404；
 *   - options.baseHash 是编辑态载入时的原文指纹（chapter 路由的 hash），
 *     归一（trim + 小写）后与写入前现读不一致 → 409 拒写不落盘（人工改动
 *     保护，与 mutateProject 同口径）；未传跳过检查（旧调用方兼容）。
 * 正文末尾无换行补一个 \n（ POSIX 文本文件惯例，textarea 草稿常缺尾换行）。
 * 返回 { ok, hash }——写后新指纹，客户端下一轮 base_hash 直接取它。
 */
export function mutateChapterBody(novelDir, file, body, options = {}) {
  if (typeof body !== 'string') fail(422, 'body 必须是字符串（章节正文全文）')
  const { name, target } = locateChapter(novelDir, file)
  const text = readTarget(target, `章节 ${name}`)
  const fence = splitFrontmatter(text)
  if (fence.raw === null) fail(422, `章节 ${name} 缺少 frontmatter 围栏，请先补齐再在面板编辑正文`)
  // 旧版检测在读原文之后、落笔之前：指纹不一致就地 409，一个字节都不动。
  const baseHash = typeof options.baseHash === 'string' ? options.baseHash.trim().toLowerCase() : ''
  if (baseHash !== '' && baseHash !== sha256Hex(text)) {
    fail(409, `章节文件已被外部修改，请刷新后基于最新内容重改再存：${name}`)
  }
  // 围栏闭合行从原文原样切出（与 splitFrontmatter 的闭合正则同形）——
  // CRLF/行尾空白等字节一字不动，改写它的刀不属于正文编辑。
  const cut = fence.index + fence.raw.length
  const closeM = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(cut))
  let preserved = text.slice(0, cut + closeM[0].length)
  // 退化形状：闭合 --- 是文件末行且无换行（罕见），补一个换行防正文黏上围栏行。
  if (!preserved.endsWith('\n')) preserved += '\n'
  const next = preserved + (body.endsWith('\n') ? body : `${body}\n`)
  writeAtomic(target, next)
  // 返回写后指纹：客户端下一轮保存的 base_hash 直接取它，不必重拉章节。
  return { ok: true, hash: sha256Hex(next) }
}

/**
 * 章纲保存（面板章节阅读页章纲对照栏编辑态）：章纲纯 markdown 无
 * frontmatter（spec §outlines），整文件替换即最小手术（与 saveStyleText
 * 同一判断）。file 接受章节文件名或 stem（v01-c001.md / v01-c001 皆可——
 * 调用方手里是章节上下文，不强迫换算），校验与 readOutlineFile 同口径：
 * safeFileName（穿越 403）+ chapterSortKey（stem 不合 vXX-cXXX 规范 422）；
 * 目标恒为 outlines/<stem>.md，章纲不存在 404（v1 不提供面板新建章纲）。
 * baseHash 人工改动保护与 mutateChapterBody 同口径，409 文案点名章纲。
 * 返回 { ok, hash }——写后新指纹。
 */
export function mutateOutlineBody(novelDir, chapterFile, body, options = {}) {
  if (typeof body !== 'string') fail(422, 'body 必须是字符串（章纲全文）')
  const name = safeFileName(chapterFile, 'file')
  const stem = name.replace(/\.md$/i, '')
  if (chapterSortKey(stem) === null) fail(422, `非章纲文件名（stem 不合 vXX-cXXX 规范）：${name}`)
  const target = path.join(path.resolve(novelDir), 'outlines', `${stem}.md`)
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') fail(404, `章纲不存在：outlines/${stem}.md`)
    fail(500, `章纲读取失败（${err?.code ?? err?.message ?? err}）`)
  }
  const baseHash = typeof options.baseHash === 'string' ? options.baseHash.trim().toLowerCase() : ''
  if (baseHash !== '' && baseHash !== sha256Hex(current)) {
    fail(409, `章纲文件已被外部修改，请刷新后基于最新内容重改再存：outlines/${stem}.md`)
  }
  const next = body.endsWith('\n') ? body : `${body}\n`
  writeAtomic(target, next)
  return { ok: true, hash: sha256Hex(next) }
}

// ── 写操作：行级原地替换 ────────────────────────────────────────────────────

/**
 * 保注释赋值刀：把一行 `缩进key: 旧值  # 行尾注释` 的值换成 newValue，行尾
 * 注释（连同值与注释间的空白）原样保留。值/注释切分复用 novel-parse 的
 * stripInlineComment——引号内的 # 不算注释（`长#夜` 是合法标量），避开
 * `(.*?)` 在值内第一个 # 提前截断、同值连存两次产出非法 YAML 的刀法损坏。
 * 行须命中 headRe（捕获组 1 = `缩进key:`），未命中返回 null 由调用方兜底。
 */
function rewriteValueKeepComment(line, headRe, newValue) {
  const body = stripInlineComment(line).replace(/\s+$/, '')
  const head = headRe.exec(body)
  if (head === null) return null
  return `${head[1]} ${newValue}${line.slice(body.length)}`
}

/**
 * 章节状态流转：只动 frontmatter 围栏内的 status 行，其余字节原样保留。
 * status 出枚举 422；文件不存在 404；无围栏 / status 行缺失或多处 409 拒写。
 */
export function mutateChapterStatus(novelDir, file, status) {
  if (!CHAPTER_STATUS_KEYS.includes(status)) fail(422, `status 非法「${String(status)}」——只认 ${CHAPTER_STATUS_KEYS.join(' / ')}`)
  const { name, target } = locateChapter(novelDir, file)
  const text = readTarget(target, `章节 ${name}`)
  const fence = splitFrontmatter(text)
  if (fence.raw === null) fail(409, `${name} 没有 frontmatter 围栏，无处替换 status 行`)
  const replaced = replaceLineOnce(
    fence.raw,
    /^status:[^\n]*?$/,
    // 保注释刀法：只换值，用户写在行尾的注释原样保留（与 mutatePhase 一致）
    (line) => rewriteValueKeepComment(line, /^(status:)/, status) ?? line,
    { what: `${name} frontmatter 的 status 行` },
  )
  const next = text.slice(0, fence.index) + replaced + text.slice(fence.index + fence.raw.length)
  writeAtomic(target, next)
  return { ok: true, file: name, status }
}

/**
 * 伏笔状态流转：在 foreshadows.yml 里按 id 定位条目块（`- id: <id>` 起、
 * 下一个顶层 `- ` 止），块内 status 行原地替换。id 出现在多个条目属文件
 * 形状异常，命中多处时按块边界取首个（账本约定 id 不复用）。
 */
export function mutateForeshadowStatus(novelDir, id, status) {
  if (!FORESHADOW_STATUS_KEYS.includes(status)) fail(422, `status 非法「${String(status)}」——只认 ${FORESHADOW_STATUS_KEYS.join(' / ')}`)
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    fail(422, `id 非法「${String(id)}」——只接受字母数字与 - _ 组合的条目编号`)
  }
  const target = path.join(novelDir, 'foreshadows.yml')
  const text = readTarget(target, 'foreshadows.yml')
  const lines = text.split(/\r?\n/)

  const idRe = new RegExp(`^-[ \t]+id:[ \t]*(["']?)${id}\\1[ \t]*(?:#.*)?$`)
  const start = lines.findIndex((line) => idRe.test(line))
  if (start === -1) fail(404, `foreshadows.yml 里没有 id 为 ${id} 的条目`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-([ \t]|$)/.test(lines[i])) {
      end = i
      break
    }
  }

  let hit = -1
  let hits = 0
  for (let i = start; i < end; i++) {
    if (/^[ \t]*status:[^\n]*$/.test(lines[i])) {
      hits += 1
      if (hit === -1) hit = i
    }
  }
  if (hits !== 1) fail(409, `foreshadows.yml 条目 ${id} 的 status 行应恰有一处，实得 ${hits} 处——已拒绝写入`)
  // 保注释刀法：只换值，行尾注释原样保留（headRe 弱于上方计数正则，兜底仅为防御）
  lines[hit] = rewriteValueKeepComment(lines[hit], /^([ \t]*status:)/, status) ?? lines[hit]
  writeAtomic(target, joinLines(lines, text))
  return { ok: true, id, status }
}

/**
 * 阶段推进：project.yml 顶层 phase 行替换。只换值、保住行尾注释
 * （模板行的注释是七态速查，没必要抹掉）。
 */
export function mutatePhase(novelDir, phase) {
  if (!PHASE_KEYS.includes(phase)) fail(422, `phase 非法「${String(phase)}」——七态只认 ${PHASE_KEYS.join(' / ')}`)
  const target = path.join(novelDir, 'project.yml')
  const text = readTarget(target, 'project.yml')
  const phaseRe = /^phase:[ \t]*.*?$/
  const hits = text.match(new RegExp(phaseRe.source, 'gm')) ?? []
  if (hits.length !== 1) fail(409, `project.yml 的 phase 行应恰有一处，实得 ${hits.length} 处——已拒绝写入`)
  const next = text.replace(new RegExp(phaseRe.source, 'm'), (line) =>
    line.replace(/^(phase:[ \t]*)(.*?)([ \t]*(?:#.*)?)$/, (_m, key, _value, comment) => `${key}${phase}${comment ?? ''}`),
  )
  writeAtomic(target, next)
  return { ok: true, phase }
}

const PROJECT_MODE_KEYS = ['ai-draft', 'co-write', 'author-draft']

/**
 * 书稿元信息保存：project.yml 平键批量改写（创作台「概览」的「编辑」态）。
 * 逐键做
 * 「单行值替换、行尾注释原样保留」（与 mutatePhase 同一保注释刀法）；文件里
 * 没有的键按模板顺序补在末尾（带模板注释）。校验：phase/mode 越枚举 422、
 * title 空白 422。值统一经 yamlScalar 规范成可回读的 YAML 标量。
 *
 * 人工改动保护：options.baseHash 是面板表单载入时的 project.yml 原文指纹
 * （快照 project_hash）。与写入前现读原文不一致 → 表单基线已过期（作者或
 * agent 在载入后改过文件），409 拒写——静默覆盖会丢人工改动。未传 baseHash
 * 跳过检查（旧调用方兼容）。返回值带写后新指纹 project_hash，客户端 reload
 * 前即可拿到下一轮基线。
 */
export function mutateProject(novelDir, values, options = {}) {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    fail(422, 'values 必须是键值对象')
  }
  const phase = typeof values.phase === 'string' ? values.phase : ''
  if (!PHASE_KEYS.includes(phase)) fail(422, `phase 非法「${phase}」——七态只认 ${PHASE_KEYS.join(' / ')}`)
  const mode = typeof values.mode === 'string' ? values.mode : ''
  if (!PROJECT_MODE_KEYS.includes(mode)) fail(422, `mode 非法「${mode}」——只认 ${PROJECT_MODE_KEYS.join(' / ')}`)
  const title = typeof values.title === 'string' ? values.title.trim() : ''
  if (title === '') fail(422, 'title 不能为空——书稿总得有个名字')
  const language = typeof values.language === 'string' && values.language.trim() !== '' ? values.language.trim() : 'zh'
  const textFields = ['author', 'genre', 'length', 'description']
  const next = { title, author: '', genre: '', length: '', language, phase, mode, description: '' }
  for (const k of textFields) next[k] = typeof values[k] === 'string' ? values[k].trim() : ''

  const target = path.join(novelDir, 'project.yml')
  const text = readTarget(target, 'project.yml')
  // 旧版检测在读原文之后、落笔之前：指纹不一致就地 409，一个字节都不动。
  // 客户端指纹归一到小写再比（指纹本身 hex，大小写宽容不构成安全口子）。
  const baseHash = typeof options.baseHash === 'string' ? options.baseHash.trim().toLowerCase() : ''
  if (baseHash !== '' && baseHash !== sha256Hex(text)) {
    fail(409, 'project.yml 已被外部修改，请刷新面板后基于最新内容重改再存')
  }
  const lines = text.split(/\r?\n/)
  const pending = new Map(Object.entries(next))
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)([A-Za-z][A-Za-z0-9_-]*):/.exec(lines[i])
    if (!m || !pending.has(m[2])) continue
    const [, indent, key] = m
    // 保注释刀法：值/注释切分走 stripInlineComment（引号内 # 不算注释），
    // 注释原样保留在行尾；键行形状异常时原样保留，宁缺毋写坏
    lines[i] = rewriteValueKeepComment(lines[i], /^([ \t]*[A-Za-z][A-Za-z0-9_-]*:)/, yamlScalar(next[key])) ?? lines[i]
    pending.delete(key)
  }
  // 模板补齐顺序：缺失键插在首个非注释内容行前，保持可读
  if (pending.size > 0) {
    const header = ['# project.yml —— 书稿元信息（平键，无嵌套）。phase 是七阶段工作流的状态机指针，', '# 每完成一个里程碑由主编推进并简报用户；mode 决定正文归谁写。']
    const missing = [...pending.entries()].map(([k, v]) => `${k}: ${yamlScalar(v)}`)
    let insertAt = lines.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    if (insertAt === -1) insertAt = lines.length
    if (lines.every((l) => l.trim() === '' || l.trim().startsWith('#'))) {
      lines.splice(insertAt, 0, ...header, ...missing)
    } else {
      lines.splice(insertAt, 0, ...missing)
    }
  }
  const nextText = joinLines(lines, text)
  writeAtomic(target, nextText)
  // 返回写后指纹：客户端下一轮保存的 base_hash 直接取它，不必再等一次快照。
  return { ok: true, project_hash: sha256Hex(nextText) }
}

/** YAML 平标量：安全字符裸写，含特殊字符（冒号空格/井号/引号/首尾空格等）
 *  时双引号包裹并转义；空串写成 ""。 */
function yamlScalar(v) {
  const s = String(v ?? '')
  if (s === '') return '""'
  // 类型漂移防护：形如布尔/数字/null 的字符串（《2046》这类书名）裸写会被
  // YAML 回读成 number/boolean/null，strOrNull 置 null 后面板显示「—」——
  // 一律双引号包裹，保住「回读仍是原字符串」（与 novel-parse 的 flowScalar 同口径）。
  if (/^(true|false|null|~|yes|no|on|off|-?\d+|-?\d*\.\d+)$/i.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  if (/^[\w\u4e00-\u9fff\u3000-\u303f\uff00-\uffef.,;:!?()（）【】《》「」『』·、—…·／/%+×\- ]+$/.test(s)
    && !/(^|[\s:])#/.test(s) && !/:\s/.test(s) && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) && !/\s$/.test(s)) {
    return s
  }
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * 重建 index.yml（与 CLI `maoying index` 同一实现）：chapters/ 缺失 404；
 * 成功返回章节数。
 */
export function rebuildIndex(novelDir) {
  const chapters = collectChapters(novelDir)
  if (chapters === null) fail(404, `找不到 ${path.join(novelDir, 'chapters')}——先按模板初始化 novel/`)
  let volumesRaw = null
  try {
    const text = readFileSync(path.join(novelDir, 'volumes.yml'), 'utf8')
    volumesRaw = parseFlatYamlArray(text)
  } catch {
    volumesRaw = null // volumes.yml 缺失/读不动：按无分卷重建，章节照收
  }
  const { text, chaptersCount } = buildIndexYaml(chapters, volumesRaw)
  writeAtomic(path.join(novelDir, 'index.yml'), text)
  return { ok: true, chapters: chaptersCount }
}

// ── 受管文件（0.2.x「全量可编辑写面」）：通用读/存/建/删 ────────────────────
//
// 边界口径（docs/creator-panel.md §0）：语义规则（状态机、必填章号、memories
// 不改旧账等）是 agent 纪律，不是人工编辑的禁区。人工编辑走「保存时结构校验
// （解析失败/缺围栏 422 拒存）+ 保存后语义体检（check 黄条 / CLI check）+
// git 回滚兜底」；所以这里的结构校验只管「面板存得进、快照就读得出」这一层，
// 其余语义一律不问——留给 check。
//
// 白名单按操作分类、集中一处定义（只此一份，路由层不做二次判断）：
//   - 读/存/建/删皆可：六个账本 yml + 四个 md 实体目录（slug 卡）+ outlines
//     章纲（stem 复用 chapterSortKey）。md 实体卡与账本是快照与 agent 共享的
//     数据源，人工改它们正是本次开放的目的。
//   - 仅删：chapters/<vXX-cXXX>.md。正文有 chapter-save 专用路由（frontmatter
//     围栏保护 + 状态机语义在那边），通用存若放开会绕过这层；删除是建章/重写
//     的前置动作，必须开放，且 chapter-create 一条路即可重建。
//   - 绝不进白名单：index.yml（派生文件，rebuild-index 覆盖，编辑无意义且
//     误导——改完下次重建就被冲掉）、project.yml（有 project-save 表单路由，
//     枚举/注释保留逻辑在那边）、novel/style.md（有 style-save 专用路由）。
//     这三个不在 yml 六件套里，靠枚举穷举天然挡住；chapters 通用存靠操作分类
//     挡住。rel 不在白名单一律 403——防穿越与防越权同码，不给探测回显差异。

/** 受管 md 实体目录（<slug>.md，slug 全小写）。 */
const MANAGED_MD_DIRS = ['characters', 'world', 'science', 'research']

/** 受管顶层账本 yml（六个，快照同源读取）。 */
const MANAGED_YML_FILES = ['relations.yml', 'timeline.yml', 'memories.yml', 'clue-board.yml', 'foreshadows.yml', 'volumes.yml']

/** md 实体卡 slug 规范：全小写字母/数字，`-` 连接，不以 `-` 开头。 */
const MANAGED_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * rel 白名单校验：op ∈ read|save|create|delete。校验不过（缺参/slug 或 stem
 * 不合规范）422，rel 不在白名单（含穿越形状与仅删目录的非删操作）403。返回
 * { dir, name, kind }——kind 供 validateManagedText 分派结构校验口径。
 */
export function managedRelCheck(rel, op) {
  if (typeof rel !== 'string' || rel.trim() === '') fail(422, '缺少 rel 参数（novel 根内的相对路径）')
  if (rel.includes('\\')) fail(403, `rel 含反斜杠，已拒绝：${rel}`) // Windows 分隔符一律不认，形状先钉死
  const segments = rel.split('/')
  if (segments.length > 2) fail(403, `rel 超出「目录/文件名」一层深度，已拒绝：${rel}`)
  const dir = segments.length === 2 ? segments[0] : ''
  const name = segments[segments.length - 1]
  if (dir === '' && MANAGED_YML_FILES.includes(name)) return { dir: '', name, kind: 'yml' }
  if (dir !== '' && MANAGED_MD_DIRS.includes(dir)) {
    if (!/\.md$/i.test(name) || !MANAGED_SLUG_RE.test(name.slice(0, -3))) {
      fail(422, `文件名不合 slug 规范（${MANAGED_SLUG_RE.source} + .md）：${rel}`)
    }
    return { dir, name, kind: 'md' }
  }
  if (dir === 'outlines') {
    const stem = name.replace(/\.md$/i, '')
    if (!/\.md$/i.test(name) || chapterSortKey(stem) === null) {
      fail(422, `章纲文件名不合 vXX-cXXX 规范：${rel}`)
    }
    return { dir, name, kind: 'outline' }
  }
  if (dir === 'chapters') {
    // 仅删：正文存/读各有专用路由（chapter-save / chapter），通用通道只放
    // 删除——放开通用存会绕过 frontmatter 围栏保护与状态机语义。
    if (op !== 'delete') fail(403, `chapters/ 只开放删除（正文编辑走 chapter-save），已拒绝：${rel}`)
    const stem = name.replace(/\.md$/i, '')
    if (!/\.md$/i.test(name) || chapterSortKey(stem) === null) {
      fail(422, `章节文件名不合 vXX-cXXX 规范：${rel}`)
    }
    return { dir, name, kind: 'chapter' }
  }
  fail(403, `rel 不在受管文件白名单内，已拒绝：${rel}`)
}

/** 白名单校验之后再来一道 resolve 包含校验：拼接结果必须落在 novel 根内
 * （双保险防符号形状的意外，与 locateChapter 同纪律）。 */
function managedTargetOf(novelDir, rel, op) {
  const check = managedRelCheck(rel, op)
  const root = path.resolve(novelDir)
  const target = path.resolve(root, rel)
  const within = path.relative(root, target)
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    fail(403, `受管路径越界，已拒绝：${rel}`)
  }
  return { ...check, target }
}

/**
 * 读受管文件（面板编辑态打开时取数）：不存在 404。hash 为原文 sha256，作
 * file-save 的 base_hash 基线——与 chapter 路由同口径（读与指纹同刻同源）。
 */
export function readManagedFile(novelDir, rel) {
  const { target } = managedTargetOf(novelDir, rel, 'read')
  const text = readTarget(target, `源文件 ${rel}`)
  return { ok: true, rel, text, hash: sha256Hex(text) }
}

/**
 * 受管文本的结构校验（保存/新建共一道门，服务端只验形状）：
 *   - 六个账本 yml：按快照同源口径解析（yamlLib 可用走真解析，否则
 *     parseFlatYamlArray 极简回退——两条路必须同一结论，否则面板存得进、快照
 *     读不出）；必须解析为顶层数组且条目全是平键对象（空数组/空文件允许）。
 *     快照会把 null/裸标量/数组条目/空对象条目静默丢弃——存得进却读不出等于
 *     丢数据，这里一并 422 带原因。
 *   - 四个 md 实体目录：必须含成对 frontmatter 围栏（其他语义一律不管，留给
 *     check）；outlines 章纲纯 markdown 无围栏，跳过此检查。
 */
export function validateManagedText(rel, text, yamlLib) {
  const { kind } = managedRelCheck(rel, 'save')
  if (kind === 'outline') return
  if (kind === 'yml') {
    // 空文件（含纯注释/空白）按空表放行：与快照「文件缺失按空表」同一宽容。
    if (String(text).trim() === '') return
    let data = null
    if (yamlLib) {
      try {
        data = yamlLib.parse(text)
      } catch {
        data = null // 真解析不认——与快照同款回退，不因 yaml 在场而更严
      }
    }
    if (data === null || data === undefined) data = parseFlatYamlArray(text)
    if (!Array.isArray(data)) fail(422, `${rel} 顶层不是数组——受管账本 yml 只接受「- key: value」条目列表`)
    data.forEach((item, index) => {
      const plain = item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0
      if (!plain) fail(422, `${rel} 第 ${index + 1} 条不是平键对象（快照会静默丢弃该条，请删掉或补全后再存）`)
    })
    return
  }
  // md 实体卡：只验围栏成对，卡内键值/枚举全不问（角色 role 越枚举这类语义
  // 由 check 标黄条，人工编辑不因此被挡）。
  if (splitFrontmatter(text).raw === null) fail(422, `${rel} 缺少成对的 frontmatter 围栏（--- … ---），请补齐后再存`)
}

/**
 * 存受管文件（编辑态保存）：目标不存在 404（新建走 file-create，一条路一个
 * 语义）；text 非 string 422；base_hash 过期 409 拒写不落盘（人工改动保护，
 * 与 project-save 同口径文案）；结构校验 422 带原因。写前读、原子写，尾无
 * 换行补一个 \n（POSIX 文本文件惯例，与正文/章纲保存同惯例）。返回写后新
 * 指纹 hash，客户端下一轮 base_hash 直接取它。
 */
export function saveManagedFile(novelDir, rel, text, options = {}) {
  if (typeof text !== 'string') fail(422, 'text 必须是字符串（文件全文）')
  validateManagedText(rel, text, yamlLibOf(options))
  const { target } = managedTargetOf(novelDir, rel, 'save')
  const current = readTarget(target, `源文件 ${rel}`)
  const baseHash = typeof options.baseHash === 'string' ? options.baseHash.trim().toLowerCase() : ''
  if (baseHash !== '' && baseHash !== sha256Hex(current)) {
    fail(409, `${rel} 已被外部修改，请刷新后基于最新内容重改再存`)
  }
  const next = text.endsWith('\n') ? text : `${text}\n`
  writeAtomic(target, next)
  return { ok: true, rel, hash: sha256Hex(next) }
}

/**
 * 新建受管文件：已存在 409（先到先建，绝不覆盖——与 chapter-create 同纪律）；
 * 结构校验同 saveManagedText（新角色卡/新章纲由客户端模板预填，服务端只验
 * 形状）。目录缺席先建（新 slug 落在还没建过的目录、测试夹具都可能出现）。
 */
export function createManagedFile(novelDir, rel, text, options = {}) {
  if (typeof text !== 'string') fail(422, 'text 必须是字符串（文件全文）')
  const { target } = managedTargetOf(novelDir, rel, 'create')
  if (existsSync(target)) fail(409, `${rel} 已存在——不覆盖既有文件，改名或改走编辑`)
  validateManagedText(rel, text, yamlLibOf(options))
  const next = text.endsWith('\n') ? text : `${text}\n`
  mkdirSync(path.dirname(target), { recursive: true })
  writeAtomic(target, next)
  return { ok: true, rel, hash: sha256Hex(next) }
}

/**
 * 删除受管文件：不存在 404。不可逆操作，服务端不做二次确认（UI 层强制确认
 * 弹层），白名单上它是最严的一档（见 managedRelCheck）。
 */
export function deleteManagedFile(novelDir, rel) {
  const { target } = managedTargetOf(novelDir, rel, 'delete')
  try {
    unlinkSync(target)
  } catch (err) {
    if (err?.code === 'ENOENT') fail(404, `源文件不存在：${rel}`)
    fail(500, `源文件删除失败（${err?.code ?? err?.message ?? err}）`)
  }
  return { ok: true, rel }
}
