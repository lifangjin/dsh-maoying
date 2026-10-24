/**
 * novel-parse —— 毛颖小说项目的共享解析层
 *
 * 从 bin/maoying.mjs 抽出的纯函数集合：frontmatter 围栏解析、CJK 计数、
 * 章节收集、index.yml 重建。CLI（bin/maoying.mjs）与创作台面板
 * （lib/panel-core.mjs）两侧共用同一份实现，保证「面板看到的」和「CLI 算的」
 * 永远是同一口径。五期（§9）在此追加：章纲 outlines/ 读取（readOutline /
 * listOutlines）、写作卡组装（buildBrief）与静态体检（checkProject）。
 *
 * 零依赖：只用 node:crypto / node:fs / node:path。YAML 解析走自带的极简子集
 * parseFlatYamlArray（本项目数据规范：yml 顶层只允许数组或平键，禁止深嵌套），
 * 与 dsh home 里的 yaml 包无关——yaml 包的真解析在 lib/yaml-loader.mjs 一侧，
 * 由 panel-core 自行惰性加载。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * sha256 hex（小写）：文本 → 指纹。全仓库唯一 hash 实现——面板「人工改动
 * 保护」的各处基线（project_hash / 章节 chapter 的 hash / 章纲 outline.hash /
 * style 的 hash）与各 save 路由的 base_hash 比对都从这一个口径出，避免多处
 * 手搓摘要算法日后漂移（比如一方忘了 utf8 编码）。
 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 章节状态机（frontmatter status 枚举 + 中文标签；CLI 展示与面板共用）。 */
export const CHAPTER_STATUSES = [
  ['pending', '待写'],
  ['writing', '写作中'],
  ['review', '审阅中'],
  ['accepted', '已定稿'],
]

/**
 * 伏笔超期阈值：planted 状态超过该章数未推进即提醒（checkProject 的伏笔超期
 * warn 用）。数字出处：skills/maoying-foreshadow-discipline/SKILL.md「清理纪律」
 * ——planted 超过 30 章未推进应升级（置 progressing 并规划推进）或 abandoned。
 */
export const FORESHADOW_STALE_CHAPTERS = 30

// CJK 计数范围：基本区 + 扩展 A + 扩展 B（\u{20000}-\u{2A6DF}）。扩展 B 在增补
// 平面，必须带 u 标志按码点匹配——网文生僻字（如「𠮷」）此前会被漏计。
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu

/** CJK 字符计数（基本区 + 扩展 A/B 区，含增补平面生僻字）。 */
export function countCjk(text) {
  const matches = String(text ?? '').match(CJK_RE)
  return matches === null ? 0 : matches.length
}

/**
 * 行内注释剥除：`#` 只有出现在行首或空白之后才算注释；单双引号内的 # 原样
 * 保留（双引号内 \" 是转义引号——判定看引号前连续反斜杠的奇偶：成对说明
 * 反斜杠自身被转义、引号是收尾引号；只回看一个字符会把 "a\\" 的收尾引号
 * 误判成转义，导致注释剥不掉）。
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
      if (c === '"') {
        let slashes = 0
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++
        if (slashes % 2 === 0) inDouble = false
      }
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
 *
 * H2：onWarn（可选回调）接收「认不出但没炸」的行告警——目前只有数组分支的
 * 零缩进散键行一种；调用方（panel-core collectArrayYml / checkProject /
 * buildBrief）把消息各自挂上文件名再入自家告警通道，散键不再静默蒸发。
 */
export function parseFlatYamlArray(text, onWarn = null) {
  if (text === null) return null
  const lines = []
  const lineNos = [] // 源行号随行登记：散键告警要能定位到文件行
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripInlineComment(raw).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) return
    lines.push(line)
    lineNos.push(i + 1)
  })
  if (lines.length === 0) return null
  const first = lines[0].trim()
  if (first === '[]') return []
  if (first === '{}') return {}
  if (first.startsWith('-')) {
    const arr = []
    let current = null
    const flush = () => {
      if (current !== null) arr.push(current)
      current = null
    }
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
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
        }
      } else if (trimmed === '-') {
        flush()
        current = {}
      } else if (!/^[ \t]/.test(line)) {
        // H2：数组形态里零缩进、非「-」起头的散键行不属于任何条目——旧实现会
        // 静默并入前一条目，手改残留键能覆盖前条 status 且零告警。丢弃并告警
        // （顶层纯键值不经过本分支——那是合法映射形态）。
        if (onWarn !== null) onWarn(`第 ${lineNos[li]} 行零缩进散键「${trimmed}」不属于任何条目，已丢弃`)
      } else if (current !== null) {
        const m = /^([^:]+):\s*(.*)$/.exec(trimmed)
        if (m !== null) current[m[1].trim()] = parseScalarText(m[2])
      }
    }
    flush()
    return arr // 原式 `bare || arr.length > 0 ? arr : []` 恒等于 arr，删简
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
  // 带 BOM 的文件开头是 \uFEFF，会让下面的开头围栏正则失配 → frontmatter 整体
  // 静默失效（meta 全空、check 全报缺键）。解析入口先剥 BOM：bom 作统一偏移，
  // index 仍按原文计（+1 补回），保住「raw === text.slice(index, index + raw.length)」
  // 的契约——写侧行级手术（panel-core 用 fence.index 拼接替换）不能错位。
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const rest = bom === 0 ? text : text.slice(1)
  const open = /^---[ \t]*\r?\n/.exec(rest)
  if (open === null) return { raw: null, index: -1, body: text }
  const rawStart = open[0].length
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest.slice(rawStart))
  if (close === null) return { raw: null, index: -1, body: text }
  return {
    raw: text.slice(rawStart + bom, rawStart + bom + close.index),
    index: rawStart + bom,
    body: text.slice(rawStart + bom + close.index + close[0].length).replace(/^\r?\n/, ''),
  }
}

/**
 * 解析章节文件：`---` 围栏 frontmatter（简单键值，一行一个）+ body。
 * 无围栏时全部按 body 处理。raw 为围栏内原文（check 侧扫重复键用），无围栏
 * 时为 null。
 */
export function parseChapterFile(text) {
  const { raw, body } = splitFrontmatter(text)
  if (raw === null) return { meta: {}, body, raw: null }
  const meta = parseFlatYamlArray(raw)
  return { meta: meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}, body, raw }
}

/** 从文件名取排序键：v01-c001.md → { vol: 1, num: 1 }；不合规范的文件返回 null。 */
export function chapterSortKey(stem) {
  const m = /^v(\d+)-c(\d+)$/.exec(stem)
  return m === null ? null : { vol: Number(m[1]), num: Number(m[2]) }
}

/**
 * 「列目录下 .md + numeric 感知名称序」在 collectChapters / listOutlines /
 * checkProject 出现三次，收敛到这里。目录不存在给 []（调用方按需先判存在）。
 */
function listMdFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    // M10：.md 大小写不敏感（/\.md$/i）——panel-core 的 collectOutlines /
    // collectMdEntities 同口径收录 .MD，CLI 侧不得把同一批文件漏在门外
    .filter((f) => /\.md$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** 章节五维叙事字段的 frontmatter 键名（值一律中文句子）。 */
export const FIVE_DIM_KEYS = ['cognitive_frame', 'emotional_anchor', 'world_texture', 'suspense', 'interpersonal_tension']

/** 收集章节：读取 chapters/*.md，按卷号+章号升序（文件名不合规范的杂散文件沉底）。目录不存在返回 null。 */
export function collectChapters(root) {
  const chaptersDir = path.join(root, 'chapters')
  if (!existsSync(chaptersDir)) return null
  const files = listMdFiles(chaptersDir)
  const chapters = []
  for (const file of files) {
    const stem = file.slice(0, -3)
    const key = chapterSortKey(stem) // 排序键一次算好——volume/num/sortKey 三个字段都要用
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
      sortKey: key,
      volume: typeof meta.volume === 'string' && meta.volume !== '' ? meta.volume : (key !== null ? canonicalVolume(key.vol) : ''),
      num: Number.isInteger(meta.num) ? meta.num : (key !== null ? key.num : null),
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
    // 文件名不合规范的杂散 .md 一律沉底（与 listOutlines 同策略）——否则会排
    // 在正常章之前，混进导出并污染 brief 的「前章」链。
    if (a.sortKey !== null) return -1
    if (b.sortKey !== null) return 1
    return a.stem.localeCompare(b.stem, undefined, { numeric: true })
  })
  return chapters
}

// ── index.yml 重建 ──────────────────────────────────────────────────────────

/**
 * 流式上下文里的标量落盘：数字直写；字符串在含 YAML 结构字符（流式项分隔、
 * 键值形态、起首指示符、注释引入、首尾空白、控制字符）时按 JSON 双引号落值
 * （JSON 字符串即合法 YAML 双引号标量）；裸写会被 YAML 读成数字/布尔的串
 * （'1984'、'true'、'3.14' 这类类型漂移）同样要引起来——落值前用自家
 * parseScalarText 试解析，结果 !== 原串（类型或值变了）即按 JSON 引号落值，
 * 保证读回来自始至终是字符串。
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
  if (unsafe) return JSON.stringify(s)
  return parseScalarText(s) !== s ? JSON.stringify(s) : s
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
    // M8：重复 id 不在此处去重——index 重建是确定性纯函数、静默择一反而把数据
    // 问题藏进产物；重复 id 由 checkProject 报 error 兜底，源头修 volumes.yml
    // （claimed 用 Set，同批章节重复入卷只影响卷内字数之和，orphans 不受影响）。
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

// ── 章纲 outlines/（五期 §9.3：纯 markdown，无 frontmatter）─────────────────
//
// 章纲是可选文件：outlines/ 下与章节同 stem 的 .md（chapters/v01-c002.md 对应
// outlines/v01-c002.md）。缺章纲不算错误——brief 降级、check 不检查它。

const OUTLINES_DIR = 'outlines'

/** 读文本文件；读不到返回 null（导出供 bin 等其他文件复用，与 bin 侧本地副本同语义）。 */
export function readTextOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 章纲相对路径（相对 novel/ 根，供展示与报错定位）。 */
function outlineFile(stem) {
  return `${OUTLINES_DIR}/${stem}.md`
}

/**
 * 读一章的章纲。chapterFile 传章节文件名（v01-c002.md）或 stem（v01-c002）。
 * 章纲是纯 markdown 无 frontmatter（§9.3，作者编辑器里打开不碍眼），words 为
 * 全文 CJK 计数。返回 { file, chapter, words, body }；无章纲返回 null。
 */
export function readOutline(novelDir, chapterFile) {
  const stem = String(chapterFile ?? '').trim().replace(/\.md$/i, '')
  if (stem === '' || stem.includes('/') || stem.includes('\\')) return null
  const text = readTextOrNull(path.join(novelDir, OUTLINES_DIR, `${stem}.md`))
  if (text === null) return null
  return { file: outlineFile(stem), chapter: stem, words: countCjk(text), body: text }
}

/** 列出全部章纲 [{ file, chapter, words }]，按章号升序（不合文件名规范的排最后，按名称序）。 */
export function listOutlines(novelDir) {
  const dir = path.join(novelDir, OUTLINES_DIR)
  const outlines = []
  for (const file of listMdFiles(dir)) {
    const stem = file.slice(0, -3)
    const text = readTextOrNull(path.join(dir, file))
    if (text === null) continue
    outlines.push({ file: outlineFile(stem), chapter: stem, words: countCjk(text) })
  }
  outlines.sort((a, b) => {
    const ka = chapterSortKey(a.chapter)
    const kb = chapterSortKey(b.chapter)
    if (ka !== null && kb !== null) return ka.vol !== kb.vol ? ka.vol - kb.vol : ka.num - kb.num
    if (ka !== null) return -1
    if (kb !== null) return 1
    return a.chapter.localeCompare(b.chapter, undefined, { numeric: true })
  })
  return outlines
}

/**
 * 只数 outlines/ 下的 .md 个数，不读内容。checkProject 的数纲数只需要个数，
 * 走 listOutlines 会把每份章纲全文读进来做 CJK 计数——纯浪费。
 */
function countOutlineFiles(novelDir) {
  return listMdFiles(path.join(novelDir, OUTLINES_DIR)).length
}

// ── 写作卡 brief（五期 §9.6）────────────────────────────────────────────────
//
// 把一章的写作输入打成一个 md（章纲 + 前章结尾 + 出场角色卡 + 活跃伏笔 +
// 本章状态），给作者带去任意编辑器/其他 AI。全程只读文件，不调模型。

/** 正文分段：空行为段界；段内多行去首尾空白后直接拼接（中文行间不加空格）。 */
export function splitParagraphs(body) {
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

/** 尾部截取约 limit 字：从最后一段往前整段累计，凑够即停——整段取用，不截半句。
 * 字数口径与 stats/index 一致，按 CJK 计数。 */
function tailParagraphs(body, limit) {
  const paragraphs = splitParagraphs(body)
  const picked = []
  let total = 0
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    picked.unshift(paragraphs[i])
    total += countCjk(paragraphs[i])
    if (total >= limit) break
  }
  return picked.join('\n\n')
}

/** 收集角色卡：characters/*.md → { slug, file, meta, body }，按 slug 排序。 */
function collectCharacterCards(novelDir) {
  const dir = path.join(novelDir, 'characters')
  if (!existsSync(dir)) return []
  const cards = []
  for (const file of readdirSync(dir)) {
    // M10：口径与 listMdFiles 一致——.MD 大小写不敏感（面板实体卡目录收录同款文件）
    if (!/\.md$/i.test(file)) continue
    const text = readTextOrNull(path.join(dir, file))
    if (text === null) continue
    const { meta, body, raw } = parseChapterFile(text)
    cards.push({ slug: file.slice(0, -3), file: `characters/${file}`, meta, body, raw })
  }
  cards.sort((a, b) => a.slug.localeCompare(b.slug))
  return cards
}

/** 顶层数组 yml 读取：文件缺失、解析失败或非数组一律给 []（条目只留对象）。
 * `-` 空条目后跟裸标量（`-\n- foo`）会被解析成无任何自有键的空对象，一并过滤。
 * onWarn（H2）透传给 parseFlatYamlArray 收散键丢弃告警，消息不含文件名，
 * 由调用方按需挂（checkProject 入 problems、buildBrief 入 warnings）。 */
function readYamlArray(novelDir, name, onWarn = null) {
  const raw = parseFlatYamlArray(readTextOrNull(path.join(novelDir, name)), onWarn)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item) => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0,
  )
}

/**
 * 主角判定——简易启发式：characters/ 的卡被 relations.yml 引用（a/b 端出现
 * slug）次数最多者视为主角；全员零引用时退回 frontmatter role=protagonist
 * 的卡。计数不分 a/b 端、不看强度，够用即可。
 */
function protagonistCards(cards, relations) {
  const counts = new Map(cards.map((c) => [c.slug, 0]))
  for (const rel of relations) {
    for (const side of ['a', 'b']) {
      const value = typeof rel[side] === 'string' ? rel[side].trim() : ''
      if (counts.has(value)) counts.set(value, counts.get(value) + 1)
    }
  }
  const max = Math.max(0, ...counts.values())
  if (max > 0) return cards.filter((c) => counts.get(c.slug) === max)
  return cards.filter((c) => c.meta.role === 'protagonist')
}

/** 在给定文本里找出场卡：卡 name 或 slug 出现即算出场，按首现位置排序。 */
function matchCardsByText(cards, text) {
  const hits = []
  for (const card of cards) {
    const name = typeof card.meta.name === 'string' ? card.meta.name : ''
    const ats = []
    if (name !== '') ats.push(text.indexOf(name))
    ats.push(text.indexOf(card.slug))
    if (ats.some((i) => i >= 0)) {
      const present = ats.filter((i) => i >= 0)
      hits.push({ card, at: Math.min(...present) })
    }
  }
  hits.sort((a, b) => a.at - b.at)
  return hits.map((h) => h.card)
}

/**
 * 从章纲抓点名的角色名单：认「出场角色：」一类行，冒号后按顿号/逗号等切分。
 * 纯启发式——抓不到就算了，卡名匹配仍然兜底。
 */
function extractOutlineRoles(outlineText) {
  const names = []
  for (const line of String(outlineText ?? '').split(/\r?\n/)) {
    const m = /(?:出场角色|登场人物|出场人物|主要角色|人物)[:：]\s*(.*)$/.exec(line)
    if (m === null) continue
    for (const piece of m[1].split(/[、，,;；/·|]+/)) {
      const name = piece.trim().replace(/^[（(【\["'「]|[）)】\]"'」]$/g, '')
      if (name !== '' && name !== '无' && name !== '暂无' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/** 字段照录：非空字符串原样、数字转字符串，其余给（未填）占位。 */
function scalarOrBlank(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return '（未填）'
}

/** 压缩角色卡：姓名/角色定位/一句话性格/当前动机，字段值原文照录不加工。 */
function renderBriefCard(card) {
  const m = card.meta
  const name = typeof m.name === 'string' && m.name !== '' ? m.name : '（未命名角色）'
  return [
    `### ${name}（${card.slug}）`,
    `- 姓名：${name}`,
    `- 角色定位：${scalarOrBlank(m.role)}`,
    `- 一句话性格：${scalarOrBlank(m.personality)}`,
    `- 当前动机：${scalarOrBlank(m.motivation)}`,
  ].join('\n')
}

/** 活跃伏笔条目：标题/优先级/埋设章/预期回收章/备注，字段值原文照录。 */
function renderForeshadowBrief(f) {
  const id = typeof f.id === 'string' && f.id !== '' ? `${f.id} ` : ''
  return [
    `- ${id}${scalarOrBlank(f.title)}`,
    `  优先级：${scalarOrBlank(f.priority)}`,
    `  埋设章：${scalarOrBlank(f.planted_chapter)}`,
    `  预期回收章：${scalarOrBlank(f.expected_resolve)}`,
    `  备注：${scalarOrBlank(f.notes)}`,
  ].join('\n')
}

/**
 * 章节参数容错解析：文件名（v01-c002.md）、stem（v01-c002）、「卷-章」（1-2，
 * 全角横线也认）、v1-c2 这类不补零写法、裸章号（2，取排序最前的同名章）。
 * 解析口径与 chapterSortKey 的 v(\d+)-c(\d+) 对齐。找不到返回 null。
 */
function resolveChapterRef(chapters, ref) {
  const raw = String(ref ?? '').trim().replace(/[－—–]/g, '-').replace(/\s+/g, '').replace(/\.md$/i, '')
  if (raw === '') return null
  let m = /^v(\d+)-c(\d+)$/i.exec(raw)
  if (m !== null) {
    const vol = Number(m[1])
    const num = Number(m[2])
    return chapters.find((c) => c.sortKey !== null && c.sortKey.vol === vol && c.sortKey.num === num) ?? null
  }
  m = /^(\d+)-(\d+)$/.exec(raw)
  if (m !== null) {
    const vol = Number(m[1])
    const num = Number(m[2])
    return chapters.find((c) => c.sortKey !== null && c.sortKey.vol === vol && c.sortKey.num === num) ?? null
  }
  const byStem = chapters.find((c) => c.stem === raw || c.file === `${raw}.md`)
  if (byStem !== undefined) return byStem
  if (/^\d+$/.test(raw)) {
    const num = Number(raw)
    return chapters.find((c) => c.num === num) ?? null
  }
  return null
}

/**
 * 组装一章的写作卡（五期 §9.6）。chapterRef 见 resolveChapterRef；options
 * 支持 prevChars（前章结尾目标字数，默认 1500）。返回：
 *   { ok: true, text, warnings } —— warnings 收集章纲缺失、角色卡找不到等
 *                                   非致命情况，不 fail；
 *   { ok: false, reason }        —— 项目/章节不存在这类硬失败。
 */
export function buildBrief(novelDir, chapterRef, options = {}) {
  const prevLimit = Number.isInteger(options.prevChars) && options.prevChars > 0 ? options.prevChars : 1500
  const warnings = []
  const chapters = collectChapters(novelDir)
  if (chapters === null) return { ok: false, reason: `找不到 ${path.join(novelDir, 'chapters')}——先跑 maoying init` }
  if (chapters.length === 0) return { ok: false, reason: 'chapters/ 下还没有章节文件，没卡可拼' }
  const target = resolveChapterRef(chapters, chapterRef)
  if (target === null) {
    return {
      ok: false,
      reason: `找不到章节「${chapterRef}」——可写文件名（v01-c002.md）、stem（v01-c002）、「卷-章」（1-2）或裸章号（2）`,
    }
  }
  const idx = chapters.findIndex((c) => c.stem === target.stem)

  // 卷名：volumes.yml 的 title，缺了退「卷N」/卷 id（H2：散键告警挂文件名入 warnings）
  const volumesRaw = parseFlatYamlArray(readTextOrNull(path.join(novelDir, 'volumes.yml')), (w) =>
    warnings.push(`volumes.yml: ${w}`),
  )
  const volTitles = new Map()
  if (Array.isArray(volumesRaw)) {
    for (const v of volumesRaw) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && typeof v.title === 'string' && v.title !== '') {
        volTitles.set(v.id, v.title)
      }
    }
  }
  const volName =
    volTitles.get(target.volume) ??
    (target.sortKey !== null ? `卷${target.sortKey.vol}` : target.volume !== '' ? target.volume : '未分卷')

  // 本章 frontmatter 原文照录——collectChapters 会把越枚举的 status 归一成
  // pending，状态栏要看的是文件里实际写了什么。
  const { meta } = parseChapterFile(readTextOrNull(path.join(novelDir, 'chapters', target.file)) ?? '')
  const statusText = typeof meta.status === 'string' && meta.status !== '' ? meta.status : target.status
  const statusLabel = CHAPTER_STATUSES.find(([s]) => s === statusText)?.[1]
  const writerText = typeof meta.writer === 'string' && meta.writer !== '' ? meta.writer : ''
  const projectRaw = parseFlatYamlArray(readTextOrNull(path.join(novelDir, 'project.yml')))
  const modeText =
    projectRaw !== null && !Array.isArray(projectRaw) && typeof projectRaw.mode === 'string' && projectRaw.mode !== ''
      ? projectRaw.mode
      : ''

  // 章纲（空文件视同没有）
  let outline = readOutline(novelDir, target.stem)
  if (outline !== null && outline.body.trim() === '') outline = null
  let outlineBlock
  if (outline === null) {
    warnings.push(`本章无章纲（${outlineFile(target.stem)} 不存在或为空），建议先让主编安排大纲师出章纲`)
    outlineBlock = '暂无章纲，建议先让主编安排大纲师出章纲。'
  } else {
    outlineBlock = outline.body.trim()
  }

  // 前章结尾：按段落边界从尾部整段截取，不截半句
  let prevBlock
  if (idx <= 0) {
    prevBlock = '全书开篇，无前章。'
  } else {
    const prev = chapters[idx - 1]
    const tail = tailParagraphs(prev.body, prevLimit)
    if (tail === '') {
      warnings.push(`前章（${prev.stem}《${prev.title}》）正文为空，前章结尾一节无内容`)
      prevBlock = `> 接上一章 ${prev.stem}《${prev.title}》结尾：\n（前章正文为空）`
    } else {
      prevBlock = `> 接上一章 ${prev.stem}《${prev.title}》结尾（约 ${countCjk(tail)} 字，整段截取）：\n${tail}`
    }
  }

  // 出场角色卡：有章纲按章纲选人（卡名/ slug 命中 + 「出场角色：」行点名）；
  // 章纲缺失时回退「前章出场角色 + 主角」（主角判定见 protagonistCards 注释）
  const cards = collectCharacterCards(novelDir)
  const relations = readYamlArray(novelDir, 'relations.yml', (w) => warnings.push(`relations.yml: ${w}`))
  let roleCards = []
  let missingNames = []
  if (outline !== null) {
    roleCards = matchCardsByText(cards, outline.body)
    missingNames = extractOutlineRoles(outline.body).filter(
      (n) => !cards.some((c) => (typeof c.meta.name === 'string' && c.meta.name === n) || c.slug === n),
    )
  } else {
    const fromPrev = idx > 0 ? matchCardsByText(cards, chapters[idx - 1].body) : []
    const seen = new Set()
    roleCards = [...fromPrev, ...protagonistCards(cards, relations)].filter((c) => {
      if (seen.has(c.slug)) return false
      seen.add(c.slug)
      return true
    })
  }
  if (missingNames.length > 0) {
    warnings.push(`角色卡找不到：${missingNames.join('、')}（章纲点名但 characters/ 无卡，先让 lore 建卡）`)
  }
  const roleParts = roleCards.map((card) => renderBriefCard(card))
  if (roleParts.length === 0) roleParts.push('没有可列出的角色卡（章纲未点名已建档角色，characters/ 也为空）。')
  if (missingNames.length > 0) {
    roleParts.push(`> 章纲点名但未建档的角色：${missingNames.join('、')}——先让 lore 建卡，防止写崩人设。`)
  }

  // 活跃伏笔：status ∈ planted/progressing 的条目照录
  const hasForeshadowsFile = existsSync(path.join(novelDir, 'foreshadows.yml'))
  if (!hasForeshadowsFile) warnings.push('未找到 foreshadows.yml，活跃伏笔一节按空处理')
  const activeForeshadows = readYamlArray(novelDir, 'foreshadows.yml', (w) => warnings.push(`foreshadows.yml: ${w}`)).filter(
    (f) => f.status === 'planted' || f.status === 'progressing',
  )
  const fsParts = activeForeshadows.map((f) => renderForeshadowBrief(f))
  if (fsParts.length === 0) fsParts.push('暂无活跃伏笔（status 为 planted/progressing 的条目为零）。')

  const statusParts = [
    `- 状态：${statusText}${statusLabel !== undefined ? `（${statusLabel}）` : ''}`,
    `- 写手：${writerText !== '' ? writerText : '未标注（缺省按 mode 推）'}`,
    `- 模式：${modeText !== '' ? modeText : '未设置（缺 project.yml 或 mode 键，按 ai-draft 处理）'}`,
  ]

  const blocks = [
    `# 写作卡 · ${volName} 第${target.num !== null ? target.num : idx + 1}章 ${target.title}`,
    `## 本章章纲\n\n${outlineBlock}`,
    `## 前章结尾\n\n${prevBlock}`,
    `## 出场角色卡\n\n${roleParts.join('\n\n')}`,
    `## 活跃伏笔\n\n${fsParts.join('\n\n')}`,
    `## 本章状态\n\n${statusParts.join('\n')}`,
  ]
  return { ok: true, text: `${blocks.join('\n\n')}\n`, warnings }
}

// ── 静态体检 check（五期 §9.6：不调模型，LLM 审校走主编）────────────────────

/** 章节 frontmatter 必填键（五期前就有，缺了是硬伤）。 */
const REQUIRED_CHAPTER_KEYS = ['volume', 'num', 'title', 'status']

/** 章节 frontmatter writer 枚举（五期 §9.1，co-write 下用）。 */
const CHAPTER_WRITERS = ['author', 'ai']

/** 伏笔状态机枚举（docs/spec.md）。 */
const FORESHADOW_STATUSES = ['planted', 'progressing', 'resolved', 'abandoned']

/** 伏笔 source 枚举（templates/novel/foreshadows.yml 声明；缺省归 plan 不报）。 */
const FORESHADOW_SOURCES = ['plan', 'backfill']

/** clue-board.yml 的 kind 枚举（templates/novel/clue-board.yml 声明）。 */
const CLUE_KINDS = ['clue', 'red-herring', 'deduction', 'question']

/** memories.yml 的 category 枚举（templates/novel/memories.yml 声明）。 */
const MEMORY_CATEGORIES = ['character', 'location', 'item', 'event', 'promise', 'appearance', 'arc', 'other']

/** project.yml 的共创模式枚举（五期 §9.1）。 */
const PROJECT_MODES = ['ai-draft', 'co-write', 'author-draft']

/** 七阶段工作流枚举（与 project.yml 的 phase 键一致，顺序即推进序）。 */
export const PROJECT_PHASES = ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export']

/**
 * 章节 frontmatter 的 volume 规范形态：v + 两位卷号。面板从章纲建章
 * （panel-core 的 createChapterFromOutline）与本文件 check / collectChapters
 * 共用同一规范形态。
 */
export function canonicalVolume(vol) {
  return `v${String(vol).padStart(2, '0')}`
}

/**
 * 扫 frontmatter 原文找重复键：解析器对重复键 last-wins（宽容不炸），但静默
 * 覆盖会藏「改了前一个没生效」的困惑，check 侧给 warn 提醒。判定口径与
 * parseFlatYamlArray 的平键分支对齐：只认零缩进键，键名去首尾引号。
 */
function findDuplicateFrontmatterKeys(raw) {
  if (raw === null) return []
  const seen = new Set()
  const dups = []
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = stripInlineComment(line)
    const trimmed = cleaned.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = cleaned.match(/^[ \t]*/)[0].length
    const m = /^([^:]+):/.exec(trimmed)
    if (m === null || indent !== 0) continue
    const key = m[1].trim().replace(/^['"]|['"]$/g, '')
    if (seen.has(key)) {
      if (!dups.includes(key)) dups.push(key)
    } else {
      seen.add(key)
    }
  }
  return dups
}

/**
 * 账本里的章节引用是否存在：认 stem（v01-c001，含不补零写法）与裸章号。
 * 空值视为「未填」，不算悬空。
 */
function chapterRefExists(ref, stems, nums) {
  const raw = String(ref ?? '').trim()
  if (raw === '') return true
  const m = /^v(\d+)-c(\d+)$/i.exec(raw)
  if (m !== null) {
    const canonical = `${canonicalVolume(Number(m[1]))}-c${String(Number(m[2])).padStart(3, '0')}`
    return stems.has(canonical) || stems.has(raw)
  }
  if (/^\d+$/.test(raw)) return nums.has(Number(raw))
  return false
}

/**
 * 章节引用转可比较的序数 {vol, num}：认 v01-c002（含不补零写法）、「卷-章」
 * 与裸章号（裸章号无卷信息，卷号记 0，仅用于与带卷引用的近似比较）。
 * 只做格式解析、不查存在性——expected_resolve 的排期承诺口径用它。
 */
function parseChapterRefOrdinal(ref) {
  const raw = String(ref ?? '').trim().replace(/[－—–]/g, '-').replace(/\.md$/i, '')
  let m = /^[vV](\d+)-c(\d+)$/.exec(raw)
  if (m !== null) return { vol: Number(m[1]), num: Number(m[2]) }
  m = /^(\d+)-(\d+)$/.exec(raw)
  if (m !== null) return { vol: Number(m[1]), num: Number(m[2]) }
  if (/^\d+$/.test(raw)) return { vol: 0, num: Number(raw) }
  return null
}

/** 时间线年份还原：数字直用；字符串抓第一段数字；抓不到返回 null。 */
function parseTimelineYear(year) {
  if (typeof year === 'number' && Number.isFinite(year)) return year
  const m = /-?\d+/.exec(String(year ?? ''))
  return m === null ? null : Number(m[0])
}

// ── AI 味统计（checkProject 第三组规则的实现；独立纯函数便于测试与复用）──────

/** 连续同式开头判定下限：连续 ≥ 3 句以相同前 2 字开头算句式重复。 */
export const STYLE_REPEAT_RUN = 3
/** 比喻词密度阈值：每千 CJK 字超过 2 处判 AI 味风险。 */
export const STYLE_METAPHOR_PER_KILO = 2
/** 句长波动检查的最少句数：句数不足时统计无意义，不查。 */
export const STYLE_SENTENCE_MIN = 20
/** 句长变异系数（标准差/均值）下限：低于它说明长短句交替不足。 */
export const STYLE_SENTENCE_CV_MIN = 0.3

/** AI 高频比喻词清单（字面计数，不做修辞判定）。 */
const METAPHOR_WORDS = ['仿佛', '宛如', '好似', '如同', '恍若', '好像']

/** 章纲「钩子」小节的标题行：#{1,3} 级、「钩子」或「章尾钩子」打头即算。 */
const OUTLINE_HOOK_RE = /^#{1,3}[ \t]*(?:章尾)?钩子/m

/**
 * 章节正文的 AI 味统计（纯函数，不读文件、不调模型）：按句切分（。！？…；，切分符不含逗号；
 * 保留句文本），三条指标互相独立、命中才报，返回 warn 消息数组（level/file
 * 由调用方挂）：
 *   a. 连续同式开头——取最长的同前缀连续句段，达到 STYLE_REPEAT_RUN 报一次/章；
 *   b. 比喻词密度——METAPHOR_WORDS 总次数 / 千 CJK 字超过 STYLE_METAPHOR_PER_KILO
 *      （分母用 countCjk，与全库字数统计同口径）；
 *   c. 句长波动——句数达 STYLE_SENTENCE_MIN 且变异系数（总体标准差/均值）
 *      低于 STYLE_SENTENCE_CV_MIN。
 */
export function checkChapterStyle(body) {
  const text = String(body ?? '')
  const messages = []
  const sentences = text
    .split(/[。！？…；]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (sentences.length === 0) return messages
  // a. 连续同式开头：一次线性扫描，记最长的同前缀连续段
  let best = null
  let curPrefix = null
  let curRun = 0
  for (const sentence of sentences) {
    const prefix = sentence.slice(0, 2)
    if (prefix === curPrefix) curRun++
    else {
      curPrefix = prefix
      curRun = 1
    }
    if (best === null || curRun > best.run) best = { prefix, run: curRun }
  }
  if (best.run >= STYLE_REPEAT_RUN) {
    messages.push(`疑似句式重复：连续 ${best.run} 句以「${best.prefix}」开头`)
  }
  // b. 比喻词密度：字面总次数 / 千 CJK 字，严格超过阈值才报
  let metaphorCount = 0
  for (const word of METAPHOR_WORDS) metaphorCount += text.split(word).length - 1
  const kilo = countCjk(text) / 1000
  if (kilo > 0 && metaphorCount / kilo > STYLE_METAPHOR_PER_KILO) {
    messages.push(
      `比喻词密度偏高：${metaphorCount} 处 / ${Number(kilo.toFixed(1))}千字（阈值 ${STYLE_METAPHOR_PER_KILO}/千字）——AI 味风险`,
    )
  }
  // c. 句长波动：句数足够且变异系数过低才报（均值 0 只可能全空句，已被过滤）
  if (sentences.length >= STYLE_SENTENCE_MIN) {
    const lengths = sentences.map((s) => s.length)
    const mean = lengths.reduce((sum, l) => sum + l, 0) / lengths.length
    if (mean > 0) {
      const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length
      const cv = Math.sqrt(variance) / mean
      if (cv < STYLE_SENTENCE_CV_MIN) {
        messages.push(
          `句长节奏过平：${sentences.length} 句变异系数 ${cv.toFixed(2)}（阈值 ${STYLE_SENTENCE_CV_MIN.toFixed(2)}）——长短句交替不足`,
        )
      }
    }
  }
  return messages
}

/**
 * 静态体检（五期 §9.6）：只查文件规范，不调模型。返回
 *   { ok, problems: [{ level: 'error'|'warn', file, message }], summary }
 * file 一律相对 novel/ 根。注意章节检查读原始 frontmatter——collectChapters
 * 会把越枚举 status 归一成 pending，会掩盖问题。
 */
export function checkProject(novelDir) {
  const problems = []
  const push = (level, file, message) => problems.push({ level, file, message })

  // H2：顶层数组账本 yml 的极简解析告警（零缩进散键被丢弃等）并入 problems——
  // 与面板快照的 warnings 通道对齐，散键不能再静默蒸发。
  const readAccountYml = (name) => readYamlArray(novelDir, name, (w) => push('warn', name, w))
  // M9：账本章节引用统一校验——空值是「未填」不算悬空，指向未写章节报 error
  // （口径与 foreshadows planted_chapter 的既有引用校验一致）。
  const refCheck = (file, label, field, ref) => {
    if ((typeof ref !== 'string' || ref.trim() === '') && typeof ref !== 'number') return
    if (!chapterRefExists(ref, stems, nums)) push('error', file, `${label}的 ${field} 引用章节不存在：${ref}`)
  }

  // —— chapters/：frontmatter 完整性、枚举、章号卷号一致 ——
  const chaptersDir = path.join(novelDir, 'chapters')
  const chapterFiles = listMdFiles(chaptersDir)
  if (!existsSync(chaptersDir)) push('error', 'chapters/', '找不到 chapters/ 目录——先跑 maoying init')

  const stems = new Set()
  const nums = new Set()
  // 全书已写章节的最大卷章序数（vol,num）：伏笔超期检查的比对基准。规范文件名
  // 优先；不合规范但 frontmatter 卷号章号可解析的章按 frontmatter 口径补入。
  let maxWritten = null
  for (const file of chapterFiles) {
    const stem = file.slice(0, -3)
    stems.add(stem)
    const key = chapterSortKey(stem)
    if (key !== null) nums.add(key.num)
    const rel = `chapters/${file}`
    if (key === null) {
      push('warn', rel, '文件名不合规范（应为 v<卷号2位>-c<章号3位>.md），章纲与账本对不上它')
    }
    let meta = {}
    let fmRaw = null
    let chapterBody = '' // AI 味统计要在循环尾用正文，try 块里的 parsed 出了作用域
    try {
      const parsed = parseChapterFile(readFileSync(path.join(chaptersDir, file), 'utf8'))
      meta = parsed.meta
      fmRaw = parsed.raw
      chapterBody = parsed.body
    } catch {
      push('error', rel, '章节文件读取失败')
      continue
    }
    // 重复键：解析保持 last-wins 宽容，但静默覆盖值得提醒（角色卡同理，见 characters 段）
    const dupKeys = findDuplicateFrontmatterKeys(fmRaw)
    if (dupKeys.length > 0) {
      push('warn', rel, `frontmatter 重复键（解析时后者覆盖前者）：${dupKeys.join('、')}`)
    }
    for (const k of REQUIRED_CHAPTER_KEYS) {
      if (meta[k] === undefined || meta[k] === '') push('error', rel, `frontmatter 缺少必填键 ${k}`)
    }
    if (typeof meta.status === 'string' && meta.status !== '' && !CHAPTER_STATUSES.some(([s]) => s === meta.status)) {
      push('error', rel, `status 越枚举：${meta.status}（合法值 pending|writing|review|accepted）`)
    }
    if (Number.isInteger(meta.num)) nums.add(meta.num)
    // 汇总最大卷章序数：文件名可解析用文件名；否则退 frontmatter volume+num
    // （裸章号口径的卷号记 0）。vol*1000+num 线性化比较——单卷章数远不到千。
    const ordNum = key !== null ? key.num : (Number.isInteger(meta.num) ? meta.num : null)
    if (ordNum !== null) {
      const volMatch = /^v(\d+)$/.exec(typeof meta.volume === 'string' ? meta.volume.trim() : '')
      const ordVol = key !== null ? key.vol : (volMatch !== null ? Number(volMatch[1]) : 0)
      if (maxWritten === null || ordVol * 1000 + ordNum > maxWritten.vol * 1000 + maxWritten.num) {
        maxWritten = { vol: ordVol, num: ordNum }
      }
    }
    const missingDims = FIVE_DIM_KEYS.filter((k) => meta[k] === undefined || meta[k] === '')
    if (missingDims.length > 0) push('warn', rel, `五维字段缺失：${missingDims.join('、')}`)
    if (meta.summary === undefined || meta.summary === '') push('warn', rel, 'summary 缺失（index.yml 与 stats 直接引用）')
    if (key !== null) {
      const expectedVolume = canonicalVolume(key.vol)
      if (typeof meta.volume === 'string' && meta.volume !== '' && meta.volume !== expectedVolume) {
        push('error', rel, `frontmatter volume（${meta.volume}）与文件名卷号（${expectedVolume}）不一致`)
      }
      // num 常被手写成 '3' 这类单引号字符串：比较前按 Number() 归一（与
      // collectChapters 的宽容口径对齐），转不出数字（NaN）时维持严格不等判断。
      if (meta.num !== undefined && meta.num !== '') {
        const parsedNum = Number(meta.num)
        const mismatch = Number.isNaN(parsedNum) ? meta.num !== key.num : parsedNum !== key.num
        if (mismatch) {
          push('error', rel, `frontmatter num（${meta.num}）与文件名章号（${key.num}）不一致`)
        }
      }
    }
    if (typeof meta.writer === 'string' && meta.writer !== '' && !CHAPTER_WRITERS.includes(meta.writer)) {
      push('error', rel, `writer 越枚举：${meta.writer}（合法值 author|ai）`)
    }
    // AI 味统计（warn）：只查有正文的章；指标与阈值见 checkChapterStyle
    if (chapterBody.trim() !== '') {
      for (const message of checkChapterStyle(chapterBody)) push('warn', rel, message)
    }
  }

  // —— foreshadows.yml：状态枚举、id 去重、章节引用、状态-字段自洽 ——
  const foreshadows = readAccountYml('foreshadows.yml')
  const seenIds = new Map()
  foreshadows.forEach((f, i) => {
    const label = typeof f.id === 'string' && f.id !== '' ? f.id : `第 ${i + 1} 条`
    if (typeof f.status === 'string' && f.status !== '' && !FORESHADOW_STATUSES.includes(f.status)) {
      push('error', 'foreshadows.yml', `伏笔 ${label} status 越枚举：${f.status}（合法值 ${FORESHADOW_STATUSES.join('|')}）`)
    }
    // M9：source 枚举（模板声明 plan|backfill）——缺省不报，面板快照侧同样把
    // 非 backfill 归一成 plan，两侧口径一致
    if (typeof f.source === 'string' && f.source !== '' && !FORESHADOW_SOURCES.includes(f.source)) {
      push('error', 'foreshadows.yml', `伏笔 ${label} source 越枚举：${f.source}（合法值 ${FORESHADOW_SOURCES.join('|')}）`)
    }
    if (typeof f.id === 'string' && f.id !== '') {
      if (seenIds.has(f.id)) push('error', 'foreshadows.yml', `伏笔 id 重复：${f.id}（第 ${seenIds.get(f.id) + 1} 条与第 ${i + 1} 条）`)
      else seenIds.set(f.id, i)
    }
    // 埋设/回收章是已发生的事实，必须指向已写出的章（空值在此跳过——resolved
    // 缺兑现章属于「漏规则」，在下面单查）。
    for (const k of ['planted_chapter', 'resolved_chapter']) {
      const ref = f[k]
      if ((typeof ref !== 'string' || ref.trim() === '') && typeof ref !== 'number') continue
      if (!chapterRefExists(ref, stems, nums)) {
        push('error', 'foreshadows.yml', `伏笔 ${label} 的 ${k} 引用章节不存在：${ref}`)
      }
    }
    // expected_resolve 是排期承诺（docs/spec.md）：目标章天然多数尚未写出，
    // 只查格式合法性（能解析出卷/章），不查存在性——按官方模板排到未来章号
    // 不该报「引用章节不存在」。
    const expected = f.expected_resolve
    if ((typeof expected === 'string' && expected.trim() !== '') || typeof expected === 'number') {
      if (parseChapterRefOrdinal(expected) === null) {
        push('error', 'foreshadows.yml', `伏笔 ${label} 的 expected_resolve 格式不合法：${expected}（应为 v<卷>-c<章>、「卷-章」或裸章号）`)
      } else if (f.status === 'planted' && chapterRefExists(expected, stems, nums)) {
        // 反向提醒：排期目标章已写出却还停在埋设态，多半是忘了登记推进/回收
        push('warn', 'foreshadows.yml', `伏笔 ${label} 的 expected_resolve（${expected}）指向的章节已写出，但 status 仍为 planted——确认是否漏登记推进/回收`)
      }
    }
    // docs/spec.md：resolved 回收时 resolved_chapter 必填
    const resolvedRef = f.resolved_chapter
    const resolvedEmpty =
      resolvedRef === undefined || resolvedRef === null || (typeof resolvedRef === 'string' && resolvedRef.trim() === '')
    if (f.status === 'resolved' && resolvedEmpty) {
      push('error', 'foreshadows.yml', `伏笔 ${label} status 为 resolved 但未填 resolved_chapter（回收必须登记兑现章）`)
    }
    // docs/spec.md：resolved_chapter 不得早于 planted_chapter（两章号均可解析才比）
    const plantedOrd = parseChapterRefOrdinal(f.planted_chapter)
    const resolvedOrd = parseChapterRefOrdinal(resolvedRef)
    if (
      plantedOrd !== null &&
      resolvedOrd !== null &&
      (resolvedOrd.vol < plantedOrd.vol || (resolvedOrd.vol === plantedOrd.vol && resolvedOrd.num < plantedOrd.num))
    ) {
      push('error', 'foreshadows.yml', `伏笔 ${label} 的 resolved_chapter（${resolvedRef}）早于 planted_chapter（${f.planted_chapter}）`)
    }
    // 清理纪律（skills/maoying-foreshadow-discipline/SKILL.md「清理纪律」：
    // planted 超过 30 章未推进应升级推进或弃用）：planted 且埋设章可解析时，
    // 与全书已写章节的最大卷章序数求间隔章数，超过阈值给 warn。
    // abandoned/resolved/progressing 不查，埋设章解析不出（非规范写法）跳过。
    // 与上面 expected_resolve 的反向提醒语义不同（那边查排期目标章是否已写出，
    // 这边查时间跨度），同一条伏笔可能双报——允许。
    if (f.status === 'planted' && plantedOrd !== null && maxWritten !== null) {
      // 带卷引用按 vol*1000+num 线性化相减（卷内即章号差，跨卷差值上千、必然
      // 超阈值）；裸章号无卷信息，与最大章号直接相减（同 nums 的存在性口径）。
      const gap =
        plantedOrd.vol === 0
          ? maxWritten.num - plantedOrd.num
          : maxWritten.vol * 1000 + maxWritten.num - (plantedOrd.vol * 1000 + plantedOrd.num)
      if (gap > FORESHADOW_STALE_CHAPTERS) {
        push('warn', 'foreshadows.yml', `伏笔 ${label} 埋设于 ${f.planted_chapter}，已 ${gap} 章未推进（阈值 ${FORESHADOW_STALE_CHAPTERS} 章）——确认是否遗忘`)
      }
    }
  })

  // —— volumes.yml：id 去重（M8：重复 id 会让同批章节被 filter 重复计入多个
  // 卷，卷字数之和 ≠ total；写法对齐 foreshadows id 去重）——
  const volumes = readAccountYml('volumes.yml')
  const seenVolIds = new Map()
  volumes.forEach((v, i) => {
    if (typeof v.id === 'string' && v.id !== '') {
      if (seenVolIds.has(v.id)) {
        push('error', 'volumes.yml', `分卷 id 重复：${v.id}（第 ${seenVolIds.get(v.id) + 1} 条与第 ${i + 1} 条）——同 id 卷会把章节重复计入`)
      } else {
        seenVolIds.set(v.id, i)
      }
    }
  })

  // —— timeline.yml：年份可解析、不倒挂（warn：故事内纪年本就允许花写）——
  const timeline = readAccountYml('timeline.yml')
  let prevYear = null
  timeline.forEach((t, i) => {
    // M9：chapter 指向已写正文；放在年份解析之前，免得花写年份把引用校验跳过
    refCheck('timeline.yml', `第 ${i + 1} 条时间线`, 'chapter', t.chapter)
    const parsed = parseTimelineYear(t.year)
    if (parsed === null) {
      push('warn', 'timeline.yml', `第 ${i + 1} 条 year 无法解析为数字：${t.year}`)
      return
    }
    if (prevYear !== null && parsed < prevYear) {
      push('warn', 'timeline.yml', `第 ${i + 1} 条年份序倒挂：${parsed} 早于上一条 ${prevYear}`)
    }
    prevYear = parsed
  })

  // —— memories.yml：category 枚举 + source_chapter 引用（M9 补对称校验，
  // 枚举以 templates/novel/memories.yml 声明为准）——
  readAccountYml('memories.yml').forEach((m, i) => {
    if (typeof m.category === 'string' && m.category !== '' && !MEMORY_CATEGORIES.includes(m.category)) {
      push('error', 'memories.yml', `第 ${i + 1} 条记忆 category 越枚举：${m.category}（合法值 ${MEMORY_CATEGORIES.join('|')}）`)
    }
    refCheck('memories.yml', `第 ${i + 1} 条记忆`, 'source_chapter', m.source_chapter)
  })

  // —— clue-board.yml：kind 枚举 + related_chapter 引用（M9 补对称校验，
  // 枚举以 templates/novel/clue-board.yml 声明为准）——
  readAccountYml('clue-board.yml').forEach((c, i) => {
    if (typeof c.kind === 'string' && c.kind !== '' && !CLUE_KINDS.includes(c.kind)) {
      push('error', 'clue-board.yml', `第 ${i + 1} 条线索 kind 越枚举：${c.kind}（合法值 ${CLUE_KINDS.join('|')}）`)
    }
    refCheck('clue-board.yml', `第 ${i + 1} 条线索`, 'related_chapter', c.related_chapter)
  })

  // —— relations.yml：a/b 角色有卡（warn：可能是已死亡/未建档角色，故不升 error）——
  const cards = collectCharacterCards(novelDir)
  const knownRoles = new Set(cards.map((c) => c.slug))
  for (const card of cards) {
    if (typeof card.meta.name === 'string' && card.meta.name !== '') knownRoles.add(card.meta.name)
  }
  const relations = readAccountYml('relations.yml')
  relations.forEach((r, i) => {
    // M9：started/ended 指向已写正文（ended 空串是「未结束」，refCheck 视作未填跳过）
    for (const k of ['started', 'ended']) refCheck('relations.yml', `第 ${i + 1} 条关系`, k, r[k])
    for (const side of ['a', 'b']) {
      const value = typeof r[side] === 'string' ? r[side].trim() : ''
      if (value !== '' && !knownRoles.has(value)) {
        push('warn', 'relations.yml', `第 ${i + 1} 条关系 ${side} 端角色无卡：${value}（可能是已死亡或未建档角色，暂只提醒）`)
      }
    }
  })

  // —— outlines/*.md：章纲缺「钩子」小节（warn：章纲本身可选，写了就须带钩子节）——
  // 章纲纯 markdown 无 frontmatter；「钩子」或「章尾钩子」须独立成节写明
  // （#{1,3} 级标题行，见 OUTLINE_HOOK_RE）。空 outlines/ 目录（或缺目录）不报。
  const outlinesDir = path.join(novelDir, OUTLINES_DIR)
  for (const file of listMdFiles(outlinesDir)) {
    const text = readTextOrNull(path.join(outlinesDir, file))
    if (text !== null && !OUTLINE_HOOK_RE.test(text)) {
      push('warn', outlineFile(file.slice(0, -3)), '章纲缺「钩子」小节（## 钩子 或 ## 章尾钩子）——章尾钩子须独立成节写明')
    }
  }

  // —— characters/*.md：name 缺失是硬伤；重复键给 warn ——
  for (const card of cards) {
    if (typeof card.meta.name !== 'string' || card.meta.name.trim() === '') {
      push('error', card.file, '角色卡缺少 name')
    }
    const dupKeys = findDuplicateFrontmatterKeys(card.raw)
    if (dupKeys.length > 0) {
      push('warn', card.file, `frontmatter 重复键（解析时后者覆盖前者）：${dupKeys.join('、')}`)
    }
  }

  // —— project.yml：mode/phase 枚举 + 阶段就绪判据 ——
  // 判据与 docs/spec.md §2 同源：phase 到 outline 及之后（setting 已过），核心设定件
  // 必须在案——缺了说明写作流程被硬闯，报 error 提示回上一阶段补齐。
  // phase 键缺失（无 project.yml 或旧文件）不查——stats 已提示「未设置」，此处不重复计账。
  const projectRaw = parseFlatYamlArray(readTextOrNull(path.join(novelDir, 'project.yml')))
  if (projectRaw !== null && !Array.isArray(projectRaw)) {
    const mode = projectRaw.mode
    if (typeof mode === 'string' && mode !== '' && !PROJECT_MODES.includes(mode)) {
      push('error', 'project.yml', `mode 越枚举：${mode}（合法值 ${PROJECT_MODES.join('|')}）`)
    }
  }
  const phase = projectRaw !== null && !Array.isArray(projectRaw) ? projectRaw.phase : undefined
  if (typeof phase === 'string' && phase !== '') {
    if (!PROJECT_PHASES.includes(phase)) {
      push('error', 'project.yml', `phase 越枚举：${phase}（合法值 ${PROJECT_PHASES.join('|')}）`)
    } else if (PROJECT_PHASES.indexOf(phase) >= PROJECT_PHASES.indexOf('outline')) {
      if (!cards.some((c) => c.meta.role === 'protagonist')) {
        push('error', 'characters/', 'phase 已过 setting 但 characters/ 缺 role: protagonist 主角卡（setting → outline 判据：核心角色卡须落盘）')
      }
      if (!cards.some((c) => c.meta.role === 'antagonist')) {
        push('error', 'characters/', 'phase 已过 setting 但 characters/ 缺 role: antagonist 核心反派卡（setting → outline 判据：核心角色卡须落盘）')
      }
      const hasWorldLore =
        listMdFiles(path.join(novelDir, 'world')).length > 0 || listMdFiles(path.join(novelDir, 'science')).length > 0
      if (!hasWorldLore) {
        push('error', 'world/', 'phase 已过 setting 但 world/ 与 science/ 均无条目（setting → outline 判据：世界观核心条目须落盘）')
      }
      // 复用上方已读的 volumes / relations（M8/H2 起 readAccountYml 带告警采集，
      // 这里重复读会导致同一份文件告警计两次）
      if (volumes.length === 0) {
        push('error', 'volumes.yml', 'phase 已过 setting 但 volumes.yml 为空或缺失（setting → outline 判据：分卷规划须在案）')
      }
      // 关系网判据（六期补）：两张及以上角色卡时 relations.yml 不得为空——
      // 空关系网意味着设定阶段漏登关系，关系图与大纲师的戏剧权重都无从谈起。
      if (cards.length >= 2 && relations.length === 0) {
        push('error', 'relations.yml', 'phase 已过 setting 但 relations.yml 为空（setting → outline 判据：两张及以上角色卡时关系网须登记）')
      }
    }
  }

  const summary = {
    chapters: chapterFiles.length,
    outlines: countOutlineFiles(novelDir), // 只列目录计数，不为数数把章纲全文读进来
    foreshadows: foreshadows.length,
    problems: {
      error: problems.filter((p) => p.level === 'error').length,
      warn: problems.filter((p) => p.level === 'warn').length,
    },
  }
  return { ok: summary.problems.error === 0, problems, summary }
}
