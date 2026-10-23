#!/usr/bin/env node
/**
 * maoying — 毛颖网文创作项目 CLI（init / stats / index / export / brief / check）
 *
 * 零依赖：只用 node:fs / node:path / node:url / node:crypto，模板目录经
 * import.meta.url 定位，任意 cwd 可用。novel/ 目录的数据规范见
 * templates/novel/README.md（或已初始化项目里的 novel/README.md）。
 *
 *   maoying init [dir]    生成 novel/ 脚手架（默认 ./novel；已存在文件跳过，绝不覆盖）
 *   maoying stats [dir]   逐章字数（CJK 计数）、状态分布、当前 phase
 *   maoying index [dir]   从 volumes.yml + chapters/ 重建 index.yml（派生文件）
 *   maoying export [dir]  导出全书：--format md|txt|epub（默认 md）、--out <目录>
 *   maoying brief [dir] <chapter> [--out <文件>]
 *                         组装某章写作卡（章纲+前章结尾+出场角色卡+活跃伏笔）
 *   maoying check [dir]   静态体检（不调模型）：frontmatter/枚举/章号/伏笔引用/伏笔超期/章纲钩子/AI 味统计/阶段就绪判据等
 *
 * 子命令出错 exit 1，中文报错。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEpub } from '../lib/epub.mjs'
// 解析层与面板共用（lib/novel-parse.mjs）；parseFlatYamlArray 沿用旧名
// parseSimpleYaml，保持本文件其余代码原样不动。STATUSES / splitParagraphs
// 也改从 lib 取——状态机与分段逻辑只留 lib 一份，bin 不再各养一副拷贝。
import {
  buildBrief,
  buildIndexYaml,
  CHAPTER_STATUSES as STATUSES, // 章节状态机（原 bin 本地 STATUSES，展示用中文标签随 lib 走）
  checkProject,
  collectChapters,
  parseFlatYamlArray as parseSimpleYaml,
  readTextOrNull, // 读文本文件读不到返回 null（原 bin 本地拷贝，lib 导出后改 import）
  splitParagraphs, // 正文分段（原 bin 本地 bodyParagraphs 的同款实现）
} from '../lib/novel-parse.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_DIR = path.join(PLUGIN_ROOT, 'templates', 'novel')

/** 七阶段工作流（与 project.yml 的 phase 枚举一致）。 */
const PHASES = {
  idea: '选题',
  setting: '设定',
  outline: '大纲',
  writing: '写作',
  review: '审阅',
  consistency: '一致性',
  export: '导出',
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 中文报错 + exit 1。 */
function fail(message) {
  console.error(`maoying: ${message}`)
  process.exit(1)
}

/**
 * 同名输出不静默覆盖：目标文件已存在时在扩展名前加序号 -2、-3……直到找到
 * 未占用的名字。返回 { path, renamed }；renamed 为 true 时调用方向 stderr
 * 提示一句改写去向——绝不覆盖用户已有文件。
 */
function dedupeWritePath(target) {
  if (!existsSync(target)) return { path: target, renamed: false }
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${stem}-${n}${ext}`)
    if (!existsSync(candidate)) return { path: candidate, renamed: true }
  }
}

// ── init ────────────────────────────────────────────────────────────────────

/** 递归复制模板树；已存在文件跳过（绝不覆盖），返回 {created, skipped} 相对路径清单。 */
function copyTemplateTree(srcDir, destDir, relBase = '') {
  const created = []
  const skipped = []
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
    const src = path.join(srcDir, entry.name)
    const dst = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      const sub = copyTemplateTree(src, dst, rel)
      created.push(...sub.created)
      skipped.push(...sub.skipped)
    } else if (existsSync(dst)) {
      skipped.push(rel)
    } else {
      copyFileSync(src, dst)
      created.push(rel)
    }
  }
  return { created, skipped }
}

function cmdInit(targetArg) {
  if (!existsSync(TEMPLATE_DIR)) fail(`模板目录缺失：${TEMPLATE_DIR}（插件包不完整？）`)
  const dest = path.resolve(targetArg ?? 'novel')
  // 落盘点兜底：目录建不出来 / 模板拷不动（权限、只读盘等）报中文错，不甩英文栈
  let counts
  try {
    counts = copyTemplateTree(TEMPLATE_DIR, dest)
  } catch (error) {
    fail(`写入失败：${dest}（${error.message}）`)
  }
  const { created, skipped } = counts
  console.log(`毛颖脚手架 → ${dest}`)
  for (const rel of created) console.log(`  创建 ${rel}`)
  for (const rel of skipped) console.log(`  跳过 ${rel}（已存在，未覆盖）`)
  console.log(`完成：新建 ${created.length} 个文件，跳过 ${skipped.length} 个。`)
  console.log('数据规范见 novel/README.md；动手前先填 novel/project.yml。')
}

// ── stats ───────────────────────────────────────────────────────────────────

function cmdStats(targetArg) {
  const root = path.resolve(targetArg ?? 'novel')
  const chapters = collectChapters(root)
  if (chapters === null) fail(`找不到 ${path.join(root, 'chapters')}——先跑 maoying init ${root}`)

  const project = parseSimpleYaml(readTextOrNull(path.join(root, 'project.yml')))
  const phase = project !== null && typeof project.phase === 'string' && project.phase !== '' ? project.phase : null
  const phaseText = phase === null ? '未设置（缺 project.yml 或 phase 键）' : `${phase}（${PHASES[phase] ?? '未知阶段'}）`

  console.log(`小说统计：${root}`)
  console.log(`阶段：${phaseText}`)
  console.log('')

  if (chapters.length === 0) {
    console.log('章节（0）：chapters/ 下还没有章节文件')
  } else {
    console.log(`章节（${chapters.length}）：`)
    for (const ch of chapters) {
      const statusLabel = STATUSES.find(([s]) => s === ch.status)?.[1] ?? ch.status
      // 文件名合规范时 stem（v01-c001）即唯一标识；不合规范再补 meta 卷号/章号
      const id = ch.sortKey !== null ? ch.stem : `${ch.volume || 'v??'} c${String(ch.num ?? 0).padStart(3, '0')}`
      console.log(`  ${ch.stem.padEnd(10)} ${id !== ch.stem ? `(${id}) ` : ''}${ch.title}  [${statusLabel}]  ${ch.words} 字`)
    }
  }

  const counts = Object.fromEntries(STATUSES.map(([s]) => [s, 0]))
  let total = 0
  for (const ch of chapters) {
    counts[ch.status] += 1
    total += ch.words
  }
  console.log('')
  console.log(`状态分布：${STATUSES.map(([s, label]) => `${s}（${label}）${counts[s]}`).join(' · ')}`)
  console.log(`总字数：${total}（CJK 计数）`)
}

// ── index ───────────────────────────────────────────────────────────────────

// index.yml 的拼装逻辑在 lib/novel-parse.mjs 的 buildIndexYaml（与创作台
// rebuild-index 路由共用），这里只负责读卷表、落盘与汇报。

function cmdIndex(targetArg) {
  const root = path.resolve(targetArg ?? 'novel')
  const chapters = collectChapters(root)
  if (chapters === null) fail(`找不到 ${path.join(root, 'chapters')}——先跑 maoying init ${root}`)
  const volumesRaw = parseSimpleYaml(readTextOrNull(path.join(root, 'volumes.yml')))
  const { text, volumesCount, chaptersCount, orphansCount, totalWords } = buildIndexYaml(chapters, volumesRaw)
  const indexPath = path.join(root, 'index.yml')
  // 落盘点兜底：写不进（权限/只读盘等）报中文错，不甩英文栈
  try {
    writeFileSync(indexPath, text, 'utf8')
  } catch (error) {
    fail(`写入失败：${indexPath}（${error.message}）`)
  }
  console.log(`已重建 ${indexPath}：${volumesCount} 卷、${chaptersCount} 章（总字数 ${totalWords}）、未归卷 ${orphansCount} 章。`)
}

// ── export ──────────────────────────────────────────────────────────────────

/** 支持的导出格式（--format 取值）。 */
const EXPORT_FORMATS = ['md', 'txt', 'epub']

/**
 * 导出文件名里的书名清洗：路径非法字符 /\\:*?"<>| 一律替换掉，再去首尾
 * 空白与点（Windows 上尾点会吞扩展名）。清完为空兜回「未命名书稿」。
 */
function sanitizeTitleForFile(title) {
  const cleaned = String(title ?? '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return cleaned !== '' ? cleaned : '未命名书稿'
}

/** 卷标题映射：volumes.yml 的 id → title；文件缺失/不合规返回空映射。 */
function volumeTitleMap(root) {
  const raw = parseSimpleYaml(readTextOrNull(path.join(root, 'volumes.yml')))
  const list = Array.isArray(raw) ? raw.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v)) : []
  const map = new Map()
  for (const v of list) {
    const id = String(v.id ?? '')
    if (id !== '' && typeof v.title === 'string' && v.title !== '') map.set(id, v.title)
  }
  return map
}

/** 卷号还原：'v01' → 1；不合规范的卷 id 返回 null（该卷跳过卷层）。 */
function volumeNumber(volume) {
  const m = /^v(\d+)$/.exec(String(volume ?? ''))
  return m === null ? null : Number(m[1])
}

/**
 * 章节展示信息（md/txt/epub 三格式共用）：卷层、章标题、分段正文。
 * 章标题形如「卷X-章Y 章节标题」；卷 id 不合规范或章节无卷信息时退为
 * 「章Y 章节标题」，卷层记 null（导出时跳过卷层）。章号缺省用全书序号。
 */
function chapterDisplay(ch, ordinal, volTitles) {
  const volNum = volumeNumber(ch.volume)
  const chNum = Number.isInteger(ch.num) ? ch.num : ordinal
  const volPart = volNum !== null ? `卷${volNum}-章${chNum}` : `章${chNum}`
  return {
    volume: volNum !== null ? { num: volNum, title: volTitles.get(ch.volume) ?? '' } : null,
    heading: `${volPart} ${ch.title}`.trim(),
    body: ch.body,
    paragraphs: splitParagraphs(ch.body),
  }
}

/** 按相邻同卷分组（保持章序）：[{ volume, chapters: [display] }]，无卷组 volume 为 null。 */
function groupByVolume(chapters, volTitles) {
  const groups = []
  let current = null
  chapters.forEach((ch, i) => {
    const display = chapterDisplay(ch, i + 1, volTitles)
    const rawVolume = ch.volume ?? ''
    if (current === null || current.rawVolume !== rawVolume) {
      current = { rawVolume, volume: display.volume, chapters: [] }
      groups.push(current)
    }
    current.chapters.push(display)
  })
  return groups
}

/** 卷层标题：`卷1 卷名`；无卷名只留 `卷1`。 */
function volumeHeading(volume) {
  return volume.title !== '' ? `卷${volume.num} ${volume.title}` : `卷${volume.num}`
}

/** md：`# 书名` + 卷层 `## 卷N 卷名` + 每章 `### 卷X-章Y 标题` + 正文原文。 */
function renderMarkdown(title, groups) {
  const lines = [`# ${title}`, '']
  for (const group of groups) {
    if (group.volume !== null) lines.push(`## ${volumeHeading(group.volume)}`, '')
    for (const display of group.chapters) {
      lines.push(`### ${display.heading}`, '', display.body.trim(), '')
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/** txt：纯文本；书名/卷名/章标题独立成行（章标题前空一行），段间空行。 */
function renderText(title, groups) {
  const lines = [title]
  for (const group of groups) {
    if (group.volume !== null) lines.push('', volumeHeading(group.volume))
    for (const display of group.chapters) {
      lines.push('', display.heading, '', display.paragraphs.join('\n\n'))
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function cmdExport(args) {
  let dirArg = null
  let format = 'md'
  let outArg = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--format' || arg === '--out') {
      const value = args[++i]
      if (value === undefined) fail(`选项 ${arg} 缺参数——--format 取 md|txt|epub，--out 取输出目录`)
      if (arg === '--format') format = value
      else outArg = value
    } else if (arg.startsWith('--format=')) {
      format = arg.slice('--format='.length)
    } else if (arg.startsWith('--out=')) {
      outArg = arg.slice('--out='.length)
    } else if (arg.startsWith('-')) {
      fail(`未知选项「${arg}」——export 只认 --format md|txt|epub 与 --out <目录>`)
    } else if (dirArg === null) {
      dirArg = arg
    } else {
      fail(`多余的位置参数「${arg}」——export 只接受一个项目目录`)
    }
  }
  if (!EXPORT_FORMATS.includes(format)) fail(`未知导出格式「${format}」——支持 ${EXPORT_FORMATS.join(' / ')}`)
  // 显式拒绝空串：`--out=` 经 path.resolve 会静默落成 cwd，属意外行为
  if (outArg !== null && outArg.trim() === '') fail('选项 --out 不能是空串——--out 取导出目录路径')

  const root = path.resolve(dirArg ?? 'novel')
  const chapters = collectChapters(root)
  if (chapters === null) fail(`找不到 ${path.join(root, 'chapters')}——先跑 maoying init ${root}`)
  if (chapters.length === 0) fail('没有可导出的章节')

  const project = parseSimpleYaml(readTextOrNull(path.join(root, 'project.yml')))
  const rawTitle =
    project !== null && typeof project.title === 'string' && project.title.trim() !== '' ? project.title.trim() : ''
  const title = rawTitle !== '' ? rawTitle : '未命名书稿'
  const author =
    project !== null && typeof project.author === 'string' && project.author.trim() !== ''
      ? project.author.trim()
      : '佚名'

  const groups = groupByVolume(chapters, volumeTitleMap(root))
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const outDir = path.resolve(outArg ?? path.join(root, 'exports'))
  const outPath = path.join(outDir, `${sanitizeTitleForFile(rawTitle)}-${stamp}.${format}`)
  // 同名输出不静默覆盖：目标已存在时自动加序号（书名-20250101-2.epub）并提示
  const target = dedupeWritePath(outPath)
  if (target.renamed) console.error(`提示：${outPath} 已存在，本次导出改写到 ${target.path}`)

  let content
  if (format === 'md') {
    content = renderMarkdown(title, groups)
  } else if (format === 'txt') {
    content = renderText(title, groups)
  } else {
    content = buildEpub({
      title,
      author,
      uuid: randomUUID(),
      chapters: groups.flatMap((group) => group.chapters),
    })
  }

  // 落盘点兜底：目录建不出 / 文件写不进（权限、只读盘等）报中文错，不甩英文栈
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(target.path, content)
  } catch (error) {
    fail(`写入失败：${target.path}（${error.message}）`)
  }
  const totalWords = chapters.reduce((sum, ch) => sum + ch.words, 0)
  console.log(`导出完成：${path.resolve(target.path)}`)
  console.log(`格式 ${format}；${chapters.length} 章，总字数 ${totalWords}（CJK 计数）。`)
}

// ── brief ───────────────────────────────────────────────────────────────────

/**
 * maoying brief [dir] <chapter> [--out <文件>]
 *
 * 组装某章写作卡（章纲 + 前章结尾 + 出场角色卡 + 活跃伏笔 + 本章状态），
 * 给作者带去任意编辑器/其他 AI。不带 --out 时写卡打到 stdout，提示与提醒
 * 走 stderr，重定向出去的就是干净的卡；带 --out 落盘。组装逻辑在
 * lib/novel-parse.mjs 的 buildBrief（与面板共用解析层）。
 */
function cmdBrief(args) {
  let dirArg = null
  let chapterArg = null
  let outArg = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') {
      const value = args[++i]
      if (value === undefined) fail('选项 --out 缺参数——--out 取输出文件路径')
      outArg = value
    } else if (arg.startsWith('--out=')) {
      outArg = arg.slice('--out='.length)
    } else if (arg.startsWith('-')) {
      fail(`未知选项「${arg}」——brief 只认 --out <文件>`)
    } else if (chapterArg !== null) {
      fail(`多余的位置参数「${arg}」——brief 只接受 [dir] <chapter> 两个位置参数`)
    } else if (dirArg === null) {
      dirArg = arg
    } else {
      chapterArg = arg
    }
  }
  if (dirArg === null && chapterArg === null) {
    fail('用法：maoying brief [dir] <chapter> [--out <文件>]——chapter 可写文件名（v01-c002.md）、stem（v01-c002）、「卷-章」（1-2）或裸章号（2）')
  }
  // 显式拒绝空串：`--out=` 经 path.resolve 会静默落成 cwd，属意外行为
  if (outArg !== null && outArg.trim() === '') fail('选项 --out 不能是空串——--out 取输出文件路径')
  // 只给一个位置参数时把它当章号用（dir 走默认 ./novel），这是常用路径
  const root = path.resolve(chapterArg === null ? 'novel' : dirArg)
  const brief = buildBrief(root, chapterArg ?? dirArg)
  if (!brief.ok) fail(brief.reason)
  for (const warning of brief.warnings) console.error(`提醒：${warning}`)
  if (outArg !== null) {
    const outPath = path.resolve(outArg)
    // 同名输出不静默覆盖：目标已存在时自动加序号 -2、-3……改写到新路径
    const target = dedupeWritePath(outPath)
    if (target.renamed) console.error(`提示：${outPath} 已存在，本次写作卡改写到 ${target.path}`)
    // 落盘点兜底：目录建不出 / 文件写不进（权限、只读盘等）报中文错，不甩英文栈
    try {
      mkdirSync(path.dirname(target.path), { recursive: true })
      writeFileSync(target.path, brief.text, 'utf8')
    } catch (error) {
      fail(`写入失败：${target.path}（${error.message}）`)
    }
    console.log(`写作卡已写入：${target.path}`)
    console.log('拿去写，写完丢回给主编收稿。')
  } else {
    process.stdout.write(brief.text)
    console.error('—— 写作卡到这儿为止。拿去写，写完丢回给主编收稿。')
  }
}

// ── check ───────────────────────────────────────────────────────────────────

/**
 * maoying check [dir]
 *
 * 静态体检：只查文件规范，不调模型（LLM 审校走主编）。检查逻辑在
 * lib/novel-parse.mjs 的 checkProject。有 error 退出码 1，只有 warn 退出码 0。
 */
function cmdCheck(targetArg) {
  const root = path.resolve(targetArg ?? 'novel')
  const result = checkProject(root)
  console.log(`静态体检：${root}（只查文件规范，不调模型）`)
  if (result.problems.length === 0) {
    console.log('未发现问题。')
  } else {
    for (const p of result.problems) {
      console.log(`${p.level === 'error' ? '[错误]' : '[提醒]'} ${p.file}：${p.message}`)
    }
  }
  const { chapters, outlines, foreshadows, problems } = result.summary
  console.log(`汇总：${chapters} 章、${outlines} 章纲、${foreshadows} 条伏笔；错误 ${problems.error} 个，提醒 ${problems.warn} 个。`)
  if (!result.ok) process.exit(1)
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const HELP_TEXT = `毛颖（maoying）—— 网文创作项目 CLI

用法：
  maoying init [dir]     生成 novel/ 脚手架（默认 ./novel；已存在的文件一律跳过，绝不覆盖）
  maoying stats [dir]    逐章字数（CJK 计数）、状态分布、当前阶段
  maoying index [dir]    从 volumes.yml + chapters/ 重建 index.yml（派生文件）
  maoying export [dir]   导出全书：--format md|txt|epub（默认 md），--out <目录> 改输出位置
  maoying brief [dir] <chapter>
                         组装某章写作卡（章纲+前章结尾+出场角色卡+活跃伏笔）；--out <文件> 落盘，缺省打到 stdout
  maoying check [dir]    静态体检（不调模型）：frontmatter 完整性、枚举值、章号卷号一致、伏笔章号引用、伏笔超期、章纲钩子、时间线年份、关系卡引用、AI 味统计、phase 阶段就绪判据

说明：
  novel/ 目录的数据规范见 templates/novel/README.md（或项目内 novel/README.md）。
  export 输出目录默认 <dir>/exports/，文件名 <书名>-<YYYYMMDD>.<扩展名>。
  brief 的 chapter 可写文件名（v01-c002.md）、stem（v01-c002）、「卷-章」（1-2）或裸章号（2）。
  check 有 error 退出码 1，只有 warn 退出码 0。
  所有命令零依赖，任意 cwd 可用；出错时退出码 1。`

/** 只接受一个可选目录参数的子命令（目录参数不以 `-` 开头；--help/-h 由 main 先拦）。 */
const SINGLE_DIR_COMMANDS = ['init', 'stats', 'index', 'check']

/**
 * 单参命令的目录参数防线：至多一个位置参数，且不以 `-` 开头——以前
 * `maoying init --help` 把 --help 当目录名，静默建出 ./--help/。--help/-h 由
 * main 在派发前拦截显示帮助；其余 `-` 开头参数报未知选项，多余位置参数报错
 * （对照 export 的同款防线）。
 */
function singleDirTarget(command, rest) {
  let target = null
  for (const arg of rest) {
    if (arg.startsWith('-')) fail(`未知选项「${arg}」——${command} 只接受一个可选目录参数`)
    if (target !== null) fail(`多余的位置参数「${arg}」——${command} 只接受一个目录参数`)
    target = arg
  }
  return target
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP_TEXT)
    return
  }
  // 单参子命令自身也认 --help/-h（防 init --help 被当目录名），显示帮助即止
  if (SINGLE_DIR_COMMANDS.includes(command) && rest.some((a) => a === '--help' || a === '-h')) {
    console.log(HELP_TEXT)
    return
  }
  if (command === 'init') return cmdInit(singleDirTarget('init', rest))
  if (command === 'stats') return cmdStats(singleDirTarget('stats', rest))
  if (command === 'index') return cmdIndex(singleDirTarget('index', rest))
  if (command === 'export') return cmdExport(rest)
  if (command === 'brief') return cmdBrief(rest)
  if (command === 'check') return cmdCheck(singleDirTarget('check', rest))
  if (command === undefined) {
    console.error('maoying: 缺少子命令（init / stats / index / export / brief / check，--help 看用法）')
    process.exit(1)
  }
  fail(`未知子命令「${command}」——可用：init / stats / index / export / brief / check（--help 看用法）`)
}

main(process.argv.slice(2))
