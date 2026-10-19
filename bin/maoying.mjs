#!/usr/bin/env node
/**
 * maoying — 毛颖网文创作项目 CLI（init / stats / index / export）
 *
 * 零依赖：只用 node:fs / node:path / node:url / node:crypto，模板目录经
 * import.meta.url 定位，任意 cwd 可用。novel/ 目录的数据规范见
 * templates/novel/README.md（或已初始化项目里的 novel/README.md）。
 *
 *   maoying init [dir]    生成 novel/ 脚手架（默认 ./novel；已存在文件跳过，绝不覆盖）
 *   maoying stats [dir]   逐章字数（CJK 计数）、状态分布、当前 phase
 *   maoying index [dir]   从 volumes.yml + chapters/ 重建 index.yml（派生文件）
 *   maoying export [dir]  导出全书：--format md|txt|epub（默认 md）、--out <目录>
 *
 * 子命令出错 exit 1，中文报错。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEpub } from '../lib/epub.mjs'

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

/** 章节状态机（frontmatter status 枚举）。 */
const STATUSES = [
  ['pending', '待写'],
  ['writing', '写作中'],
  ['review', '审阅中'],
  ['accepted', '已定稿'],
]

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 中文报错 + exit 1。 */
function fail(message) {
  console.error(`maoying: ${message}`)
  process.exit(1)
}

/** 读文本文件；读不到返回 null。 */
function readTextOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** CJK 字符计数（基本区 + 扩展 A 区，覆盖常用汉字）。 */
function countCjk(text) {
  const matches = text.match(CJK_RE)
  return matches === null ? 0 : matches.length
}

/**
 * 行内注释剥除：`#` 只有出现在行首或空白之后才算注释；单双引号内的 # 原样
 * 保留（双引号内 \" 是转义引号，翻转前回看前一字符）。
 */
function stripInlineComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (c === '"' && line[i - 1] !== '\\') inDouble = false
      continue
    }
    if (c === "'") inSingle = true
    else if (c === '"') inDouble = true
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** 标量值还原：剥引号、认数字与布尔；其余按字符串。 */
function parseScalarText(raw) {
  const s = String(raw ?? '').trim()
  if (s === '' || s === '~' || s === 'null') return ''
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2)) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  if (s === 'true' || s === 'false') return s === 'true'
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  return s
}

/**
 * 极简 YAML 读取器（只认本项目数据文件的两类形态，零依赖）：
 *   - 平键映射（project.yml、frontmatter）：顶层 `key: value`，缩进续行折叠拼接；
 *   - 顶层数组（volumes.yml / foreshadows.yml 等）：`- key: value` 起条目，
 *     缩进行补键；裸 `- 标量` 收作字符串条目。
 * 深嵌套不在支持范围（数据规范本身就禁止）。解析不了返回 null。
 */
function parseSimpleYaml(text) {
  if (text === null) return null
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = stripInlineComment(raw).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    lines.push(line)
  }
  if (lines.length === 0) return null
  const first = lines[0].trim()
  if (first === '[]') return []
  if (first === '{}') return {}
  if (first.startsWith('-')) {
    const arr = []
    let current = null
    let bare = false
    const flush = () => {
      if (current !== null) arr.push(current)
      current = null
      bare = false
    }
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('- ')) {
        flush()
        const rest = trimmed.slice(2).trim()
        const m = /^([^:]+):\s*(.*)$/.exec(rest)
        if (m !== null) {
          current = {}
          current[m[1].trim()] = parseScalarText(m[2])
        } else {
          arr.push(parseScalarText(rest)) // 裸标量条目
          bare = true
        }
      } else if (trimmed === '-') {
        flush()
        current = {}
      } else if (current !== null) {
        const m = /^([^:]+):\s*(.*)$/.exec(trimmed)
        if (m !== null) current[m[1].trim()] = parseScalarText(m[2])
      }
    }
    flush()
    return bare || arr.length > 0 ? arr : []
  }
  // 平键映射
  const map = {}
  let lastKey = null
  for (const line of lines) {
    const indent = line.match(/^[ \t]*/)[0].length
    const m = /^([^:]+):\s*(.*)$/.exec(line.trim())
    if (m !== null && indent === 0) {
      const key = m[1].trim().replace(/^['"]|['"]$/g, '')
      map[key] = parseScalarText(m[2])
      lastKey = key
    } else if (lastKey !== null && indent > 0 && line.trim() !== '') {
      map[lastKey] = `${map[lastKey]} ${line.trim()}`.trim() // 折叠续行
    }
  }
  return map
}

// ── 章节 ────────────────────────────────────────────────────────────────────

/**
 * 解析章节文件：`---` 围栏 frontmatter（简单键值，一行一个）+ body。
 * 无围栏时全部按 body 处理。
 */
function parseChapterFile(text) {
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (fence === null) return { meta: {}, body: text }
  const meta = parseSimpleYaml(fence[1])
  const body = text.slice(fence[0].length).replace(/^\r?\n/, '')
  return { meta: meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}, body }
}

/** 从文件名取排序键：v01-c001.md → { vol: 1, num: 1 }；不合规范的文件返回 null。 */
function chapterSortKey(stem) {
  const m = /^v(\d+)-c(\d+)$/.exec(stem)
  return m === null ? null : { vol: Number(m[1]), num: Number(m[2]) }
}

/** 收集章节：读取 chapters/*.md，按卷号+章号升序。目录不存在返回 null。 */
function collectChapters(root) {
  const chaptersDir = path.join(root, 'chapters')
  if (!existsSync(chaptersDir)) return null
  const files = readdirSync(chaptersDir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const chapters = []
  for (const file of files) {
    const stem = file.slice(0, -3)
    const text = readTextOrNull(path.join(chaptersDir, file))
    if (text === null) continue
    const { meta, body } = parseChapterFile(text)
    const status = STATUSES.some(([s]) => s === meta.status) ? meta.status : 'pending'
    chapters.push({
      file,
      stem,
      sortKey: chapterSortKey(stem),
      volume: typeof meta.volume === 'string' && meta.volume !== '' ? meta.volume : (chapterSortKey(stem) ? `v${String(chapterSortKey(stem).vol).padStart(2, '0')}` : ''),
      num: Number.isInteger(meta.num) ? meta.num : (chapterSortKey(stem) ? chapterSortKey(stem).num : null),
      title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : '（无标题）',
      status,
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      words: countCjk(body),
      body, // 原文正文（frontmatter 已剥离）；stats/index 不读，export 用
    })
  }
  chapters.sort((a, b) => {
    if (a.sortKey !== null && b.sortKey !== null) {
      return a.sortKey.vol !== b.sortKey.vol ? a.sortKey.vol - b.sortKey.vol : a.sortKey.num - b.sortKey.num
    }
    return a.stem.localeCompare(b.stem, undefined, { numeric: true })
  })
  return chapters
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
  const { created, skipped } = copyTemplateTree(TEMPLATE_DIR, dest)
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

/**
 * 流式上下文里的标量落盘：数字直写；字符串在含 YAML 结构字符（流式项分隔、
 * 键值形态、起首指示符、注释引入、首尾空白、控制字符）时按 JSON 双引号落值
 * （JSON 字符串即合法 YAML 双引号标量），否则保持原文。
 */
function flowScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = String(value ?? '')
  if (s === '') return '""'
  const unsafe =
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /[,{}[\]]/.test(s) ||
    /:\s/.test(s) ||
    /:$/.test(s) ||
    /\s[:#]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /[\x00-\x1f]/.test(s)
  return unsafe ? JSON.stringify(s) : s
}

/** 章节一行条目（flow mapping，num/title/status/words/summary 一行）。 */
function chapterLine(ch) {
  return `        - {num: ${Number.isInteger(ch.num) ? ch.num : 0}, title: ${flowScalar(ch.title)}, status: ${ch.status}, words: ${ch.words}, summary: ${flowScalar(ch.summary)}}`
}

function cmdIndex(targetArg) {
  const root = path.resolve(targetArg ?? 'novel')
  const chapters = collectChapters(root)
  if (chapters === null) fail(`找不到 ${path.join(root, 'chapters')}——先跑 maoying init ${root}`)
  const volumesRaw = parseSimpleYaml(readTextOrNull(path.join(root, 'volumes.yml')))
  const volumes = Array.isArray(volumesRaw) ? volumesRaw.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v)) : []

  const lines = [
    '# index.yml —— 派生文件，可由 lore 角色或 `maoying index` 重建；手工改动会被覆盖。',
    '# 结构：volumes 照 volumes.yml 顺序分组，卷内章节按章号升序；',
    '#       未归入任何卷的章节落在 orphans（volume + 同款章节行）；',
    '#       total 为全书汇总（章节数与 CJK 总字数）。',
    'volumes:',
  ]
  const claimed = new Set()
  if (volumes.length === 0) lines.push('  []')
  for (const volume of volumes) {
    const id = String(volume.id ?? '')
    const members = chapters.filter((ch) => ch.volume === id)
    for (const ch of members) claimed.add(ch.stem)
    lines.push(`  - id: ${flowScalar(id || '（缺 id）')}`)
    lines.push(`    title: ${flowScalar(typeof volume.title === 'string' ? volume.title : '')}`)
    lines.push(`    summary: ${flowScalar(typeof volume.summary === 'string' ? volume.summary : '')}`)
    lines.push('    chapters:')
    if (members.length === 0) lines.push('      []')
    for (const ch of members) lines.push(chapterLine(ch))
  }
  const orphans = chapters.filter((ch) => !claimed.has(ch.stem))
  lines.push('orphans:')
  if (orphans.length === 0) lines.push('  []')
  else {
    for (const ch of orphans) {
      lines.push(`  - {volume: ${flowScalar(ch.volume)}, num: ${Number.isInteger(ch.num) ? ch.num : 0}, title: ${flowScalar(ch.title)}, status: ${ch.status}, words: ${ch.words}, summary: ${flowScalar(ch.summary)}}`)
    }
  }
  const totalWords = chapters.reduce((sum, ch) => sum + ch.words, 0)
  lines.push(`total: {chapters: ${chapters.length}, words: ${totalWords}, accepted: ${chapters.filter((c) => c.status === 'accepted').length}}`)

  const indexPath = path.join(root, 'index.yml')
  writeFileSync(indexPath, `${lines.join('\n')}\n`, 'utf8')
  console.log(`已重建 ${indexPath}：${volumes.length} 卷、${chapters.length} 章（总字数 ${totalWords}）、未归卷 ${orphans.length} 章。`)
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
 * 正文分段：空行为段界；段内多行去首尾空白后直接拼接（中文行间不加空格）。
 * md/txt 的正文与 epub 的 <p> 共用这一套。
 */
function bodyParagraphs(body) {
  const paragraphs = []
  let current = []
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') {
      if (current.length > 0) paragraphs.push(current.join(''))
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) paragraphs.push(current.join(''))
  return paragraphs
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
    paragraphs: bodyParagraphs(ch.body),
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

  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPath, content)
  const totalWords = chapters.reduce((sum, ch) => sum + ch.words, 0)
  console.log(`导出完成：${path.resolve(outPath)}`)
  console.log(`格式 ${format}；${chapters.length} 章，总字数 ${totalWords}（CJK 计数）。`)
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const HELP_TEXT = `毛颖（maoying）—— 网文创作项目 CLI

用法：
  maoying init [dir]     生成 novel/ 脚手架（默认 ./novel；已存在的文件一律跳过，绝不覆盖）
  maoying stats [dir]    逐章字数（CJK 计数）、状态分布、当前阶段
  maoying index [dir]    从 volumes.yml + chapters/ 重建 index.yml（派生文件）
  maoying export [dir]   导出全书：--format md|txt|epub（默认 md），--out <目录> 改输出位置

说明：
  novel/ 目录的数据规范见 templates/novel/README.md（或项目内 novel/README.md）。
  export 输出目录默认 <dir>/exports/，文件名 <书名>-<YYYYMMDD>.<扩展名>。
  所有命令零依赖，任意 cwd 可用；出错时退出码 1。`

function main(argv) {
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP_TEXT)
    return
  }
  if (command === 'init') return cmdInit(rest[0])
  if (command === 'stats') return cmdStats(rest[0])
  if (command === 'index') return cmdIndex(rest[0])
  if (command === 'export') return cmdExport(rest)
  if (command === undefined) {
    console.error('maoying: 缺少子命令（init / stats / index / export，--help 看用法）')
    process.exit(1)
  }
  fail(`未知子命令「${command}」——可用：init / stats / index / export（--help 看用法）`)
}

main(process.argv.slice(2))
