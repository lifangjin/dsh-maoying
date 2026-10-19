/**
 * novel-parse —— 毛颖小说项目的共享解析层
 *
 * 从 bin/maoying.mjs 抽出的纯函数集合：frontmatter 围栏解析、CJK 计数、
 * 章节收集、index.yml 重建。CLI（bin/maoying.mjs）与创作台面板
 * （lib/panel-core.mjs）两侧共用同一份实现，保证「面板看到的」和「CLI 算的」
 * 永远是同一口径。
 *
 * 零依赖：只用 node:fs / node:path。YAML 解析走自带的极简子集
 * parseFlatYamlArray（本项目数据规范：yml 顶层只允许数组或平键，禁止深嵌套），
 * 与 dsh home 里的 yaml 包无关——yaml 包的真解析在 lib/yaml-loader.mjs 一侧，
 * 由 panel-core 自行惰性加载。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 章节状态机（frontmatter status 枚举 + 中文标签；CLI 展示与面板共用）。 */
export const CHAPTER_STATUSES = [
  ['pending', '待写'],
  ['writing', '写作中'],
  ['review', '审阅中'],
  ['accepted', '已定稿'],
]

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g

/** CJK 字符计数（基本区 + 扩展 A 区，覆盖常用汉字）。 */
export function countCjk(text) {
  const matches = String(text ?? '').match(CJK_RE)
  return matches === null ? 0 : matches.length
}

/**
 * 行内注释剥除：`#` 只有出现在行首或空白之后才算注释；单双引号内的 # 原样
 * 保留（双引号内 \" 是转义引号，翻转前回看前一字符）。
 */
export function stripInlineComment(line) {
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
export function parseScalarText(raw) {
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
export function parseFlatYamlArray(text) {
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

/**
 * 按 `---` 围栏切 frontmatter 与正文：raw 为围栏内文本（无围栏时 null），
 * index 为 raw 在原文中的起始下标（写侧做行级手术时用），body 为第二个
 * `---` 之后的正文（去首个空行）。只切不解析，解析交给上层。
 */
export function splitFrontmatter(text) {
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (open === null) return { raw: null, index: -1, body: text }
  const rawStart = open[0].length
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(rawStart))
  if (close === null) return { raw: null, index: -1, body: text }
  return {
    raw: text.slice(rawStart, rawStart + close.index),
    index: rawStart,
    body: text.slice(rawStart + close.index + close[0].length).replace(/^\r?\n/, ''),
  }
}

/**
 * 解析章节文件：`---` 围栏 frontmatter（简单键值，一行一个）+ body。
 * 无围栏时全部按 body 处理。
 */
export function parseChapterFile(text) {
  const { raw, body } = splitFrontmatter(text)
  if (raw === null) return { meta: {}, body }
  const meta = parseFlatYamlArray(raw)
  return { meta: meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}, body }
}

/** 从文件名取排序键：v01-c001.md → { vol: 1, num: 1 }；不合规范的文件返回 null。 */
export function chapterSortKey(stem) {
  const m = /^v(\d+)-c(\d+)$/.exec(stem)
  return m === null ? null : { vol: Number(m[1]), num: Number(m[2]) }
}

/** 章节五维叙事字段的 frontmatter 键名（值一律中文句子）。 */
export const FIVE_DIM_KEYS = ['cognitive_frame', 'emotional_anchor', 'world_texture', 'suspense', 'interpersonal_tension']

/** 收集章节：读取 chapters/*.md，按卷号+章号升序。目录不存在返回 null。 */
export function collectChapters(root) {
  const chaptersDir = path.join(root, 'chapters')
  if (!existsSync(chaptersDir)) return null
  const files = readdirSync(chaptersDir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const chapters = []
  for (const file of files) {
    const stem = file.slice(0, -3)
    let text = null
    try {
      text = readFileSync(path.join(chaptersDir, file), 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseChapterFile(text)
    const status = CHAPTER_STATUSES.some(([s]) => s === meta.status) ? meta.status : 'pending'
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
      ...Object.fromEntries(FIVE_DIM_KEYS.map((k) => [k, typeof meta[k] === 'string' ? meta[k] : ''])),
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

// ── index.yml 重建 ──────────────────────────────────────────────────────────

/**
 * 流式上下文里的标量落盘：数字直写；字符串在含 YAML 结构字符（流式项分隔、
 * 键值形态、起首指示符、注释引入、首尾空白、控制字符）时按 JSON 双引号落值
 * （JSON 字符串即合法 YAML 双引号标量），否则保持原文。
 */
export function flowScalar(value) {
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

/**
 * 重建 index.yml 全文（确定性输出：同样的章节与分卷永远得到逐字节相同的
 * 文本，不含任何时间戳）。chapters 来自 collectChapters，volumesRaw 来自
 * volumes.yml 的解析结果（可为 null——视为无分卷）。返回：
 *   { text, volumesCount, chaptersCount, orphansCount, totalWords }
 */
export function buildIndexYaml(chapters, volumesRaw) {
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

  return {
    text: `${lines.join('\n')}\n`,
    volumesCount: volumes.length,
    chaptersCount: chapters.length,
    orphansCount: orphans.length,
    totalWords,
  }
}
