/**
 * docs-sync：文档与代码实况的「清单类声明」一致性门禁。
 *
 * AGENTS.md 要求文档与代码一致，此前靠人工纪律；本文件把它落成机器断言：
 * README（中/英）的 CLI 命令清单与数量字样、方法论技能表、templates/novel/
 * 速查的「文件 ↔ 节」双向覆盖、decisions.yml 的键集，全部对照代码/磁盘实况
 * 对账。断言失败信息一律带「文档哪句（行号 + 引文）vs 代码/磁盘哪个事实」，
 * 一眼定位该修文档还是该修代码。
 *
 * bin/maoying.mjs 的子命令分发在 main() 函数体内、不可 import——照
 * i18n-keys.test.mjs 的源码切片先例：切 `function main(argv) {` 起至收尾
 * `main(process.argv.slice(2))` 止，再按分发行形状提取子命令。切片标记失效
 * 即红并带定位提示，防未来重排后静默漏测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

// ── 代码实况：bin/maoying.mjs 实际子命令集（源码切片 + 分发行提取）──────────

const binSource = read('bin/maoying.mjs')
const START_MARK = 'function main(argv) {'
const END_MARK = '\nmain(process.argv.slice(2))'
const sliceStart = binSource.indexOf(START_MARK)
const sliceEnd = binSource.indexOf(END_MARK, sliceStart)
if (sliceStart === -1 || sliceEnd === -1) {
  throw new Error('[docs-sync] 无法在 bin/maoying.mjs 定位 main() 子命令分发块：切片标记 "function main(argv) {" 或收尾 "main(process.argv.slice(2))" 未命中——入口可能已被重排/改名，请同步更新本测试的 START_MARK / END_MARK 后再跑，谨防静默漏测')
}
if (sliceEnd <= sliceStart) {
  throw new Error('[docs-sync] bin/maoying.mjs 切片区间异常：收尾标记出现在开头之前，请检查 START_MARK / END_MARK')
}
// 分发行形状：`if (command === 'init') return cmdInit(...)`。--help/-h/help 走
// 拦截分支、undefined 与报错不是这个形状，不会被误提。
const ACTUAL_COMMANDS = [
  ...binSource.slice(sliceStart, sliceEnd).matchAll(/if \(command === '([a-z][a-z-]*)'\) return cmd/g),
].map((m) => m[1])
if (ACTUAL_COMMANDS.length === 0) {
  throw new Error('[docs-sync] bin/maoying.mjs main() 切片成功但没提取到任何子命令——分发行形状可能已变（不再是 if (command === \'<cmd>\') return cmd…），请更新提取正则，谨防静默漏测')
}

// ── 文档侧提取小工具 ────────────────────────────────────────────────────────

const uniq = (arr) => [...new Set(arr)]
const onlyIn = (a, b) => uniq(a.filter((x) => !b.includes(x)))
const listCmds = (cmds) => cmds.join(' / ')
/** 文本中 needle 首次出现的 1-based 行号（失败信息定位「文档哪句」用）。 */
const lineOf = (text, needle) => {
  const idx = text.indexOf(needle)
  return idx === -1 ? -1 : text.slice(0, idx).split('\n').length
}

/** 「CLI 兜底 / CLI fallback」要点行里的 `maoying a / b / c` 命令清单与原文。 */
function cliBulletCommands(md, anchor, docName) {
  const lineNo = lineOf(md, anchor)
  assert.notEqual(lineNo, -1, `${docName} 找不到「${anchor}」要点行——CLI 段可能被重排，请更新本测试锚点`)
  const line = md.split('\n')[lineNo - 1]
  const m = /`maoying ([^`]+)`/.exec(line)
  assert.notEqual(m !== null, false, `${docName} 第 ${lineNo} 行「${anchor}」里没有 \`maoying …\` 命令清单——请确认文档写法或更新本测试`)
  const cmds = m[1].split('/').map((s) => s.trim()).filter((s) => s !== '')
  return { line, lineNo, cmds }
}

/** `## CLI` 小节第一个代码围栏里的 `maoying <cmd>` 用法行命令清单。 */
function cliSectionCommands(md, docName) {
  const lines = md.split('\n')
  const h = lines.findIndex((l) => l.trim() === '## CLI')
  assert.notEqual(h, -1, `${docName} 找不到「## CLI」小节标题——CLI 段可能被重排，请更新本测试锚点`)
  let open = -1
  for (let i = h + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      open = i
      break
    }
  }
  assert.notEqual(open, -1, `${docName} 的「## CLI」小节下没有代码围栏——请确认文档写法或更新本测试锚点`)
  const cmds = []
  for (let i = open + 1; i < lines.length && !lines[i].startsWith('```'); i++) {
    const m = /^maoying ([a-z][a-z-]*)/.exec(lines[i])
    if (m !== null) cmds.push(m[1])
  }
  assert.ok(cmds.length > 0, `${docName} 的「## CLI」代码围栏里没提取到任何命令行——围栏内容可能已改写，请确认文档或更新本测试锚点`)
  return cmds
}

/** 条数的文档用字：「六条」的六 /「six commands」的 six，须与实际条数对上。 */
const ZH_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const EN_NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const countWord = (n, lang) => (n <= 10 ? (lang === 'zh' ? ZH_NUM[n] : EN_NUM[n]) : String(n))

// ── 1. CLI 命令集一致 ────────────────────────────────────────────────────────

for (const { file, docName, bullet, lang } of [
  { file: 'README.md', docName: 'README.md', bullet: '**CLI 兜底**', lang: 'zh' },
  { file: 'README.en.md', docName: 'README.en.md', bullet: '**CLI fallback**', lang: 'en' },
]) {
  const md = read(file)

  test(`${docName}「${bullet}」与「## CLI」命令清单 == bin/maoying.mjs 实际子命令集`, () => {
    for (const [what, cmds] of [
      [`${bullet} 要点行`, cliBulletCommands(md, bullet, docName).cmds],
      ['## CLI 代码围栏', cliSectionCommands(md, docName)],
    ]) {
      const missing = onlyIn(ACTUAL_COMMANDS, cmds) // 代码有、文档漏列
      const unknown = onlyIn(cmds, ACTUAL_COMMANDS) // 文档列了、代码没有
      assert.deepEqual(
        { missing, unknown },
        { missing: [], unknown: [] },
        `${docName} 第 ${lineOf(md, bullet)} 行附近的${what}与 bin/maoying.mjs 实况不一致：\n` +
          `  文档写：${listCmds(cmds)}\n  代码实况：${listCmds(ACTUAL_COMMANDS)}\n` +
          (missing.length > 0 ? `  文档漏列（代码有）：${missing.join(', ')}\n` : '') +
          (unknown.length > 0 ? `  文档多列（代码没有）：${unknown.join(', ')}\n` : '') +
          `  → 命令增删后同步更新 ${docName}；若文档无误则是 bin 分发行形状变了，先修本测试锚点`,
      )
    }
  })

  test(`${docName}「${bullet}」数量字样与实际子命令数一致`, () => {
    const { line, lineNo } = cliBulletCommands(md, bullet, docName)
    const word = countWord(ACTUAL_COMMANDS.length, lang)
    assert.ok(
      line.includes(word),
      `${docName} 第 ${lineNo} 行「${bullet}」的数量字样与 bin/maoying.mjs 实况不符：\n` +
        `  文档原句：${line.trim()}\n  代码实况：${ACTUAL_COMMANDS.length} 条子命令（${listCmds(ACTUAL_COMMANDS)}）\n` +
        `  → 数量字样应写作「${word}」`,
    )
  })
}

test('docs/spec.md §4「CLI 与本规范的关系」出现的 maoying <cmd> ⊆ 实际子命令集', () => {
  const spec = read('docs/spec.md')
  const s4Start = spec.indexOf('## 4. CLI 与本规范的关系')
  assert.notEqual(s4Start, -1, 'docs/spec.md 找不到「## 4. CLI 与本规范的关系」小节——spec 可能被重排，请更新本测试锚点')
  const nextH2 = spec.indexOf('\n## ', s4Start + 10)
  const s4 = spec.slice(s4Start, nextH2 === -1 ? spec.length : nextH2)
  const docCmds = uniq([...s4.matchAll(/`maoying ([a-z][a-z-]*)/g)].map((m) => m[1]))
  const unknown = onlyIn(docCmds, ACTUAL_COMMANDS)
  assert.deepEqual(
    unknown,
    [],
    `docs/spec.md §4 提到的命令在 bin/maoying.mjs 里不存在：${unknown.join(', ')}\n` +
      `  代码实况：${listCmds(ACTUAL_COMMANDS)}\n  → spec §4 的命令提法须与实况对齐`,
  )
})

// ── 2. 方法论技能数一致 ─────────────────────────────────────────────────────

const SKILL_DIRS = readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('maoying-'))
  .map((e) => e.name)
  .sort()
const skillTableRows = (md) => [...md.matchAll(/^\|\s*(maoying-[A-Za-z0-9-]+)\s*\|/gm)].map((m) => m[1])

for (const { file, docName } of [
  { file: 'README.md', docName: 'README.md' },
  { file: 'README.en.md', docName: 'README.en.md' },
]) {
  test(`${docName} 方法论技能表 == skills/maoying-* 目录（行数相等且集合对称）`, () => {
    const rows = skillTableRows(read(file))
    assert.ok(rows.length > 0, `${docName} 没找到「| maoying-… |」技能表行——技能表可能被重排/改名，请更新本测试锚点`)
    const missingInTable = onlyIn(SKILL_DIRS, rows) // 磁盘有、表里漏
    const notInSkills = onlyIn(rows, SKILL_DIRS) // 表里有、磁盘无
    assert.deepEqual(
      { missingInTable, notInSkills },
      { missingInTable: [], notInSkills: [] },
      `${docName} 技能表与 skills/ 目录实况不一致：\n` +
        `  文档表 ${rows.length} 行：${rows.join(', ')}\n  磁盘实况 ${SKILL_DIRS.length} 个目录：${SKILL_DIRS.join(', ')}\n` +
        (missingInTable.length > 0 ? `  磁盘有、表里漏：${missingInTable.join(', ')}\n` : '') +
        (notInSkills.length > 0 ? `  表里有、磁盘无：${notInSkills.join(', ')}\n` : '') +
        `  → 新增/删除 skills/maoying-* 目录时同步更新 ${docName} 技能表`,
    )
  })
}

// ── 3. templates/novel/ 速查「文件 ↔ 节」双向覆盖 ───────────────────────────

const QUICK_REL = 'templates/novel/README.md'
const TEMPLATE_DIR = path.join(ROOT, 'templates/novel')
const quickHeadings = [...read(QUICK_REL).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
// 节名形状分类：带扩展名且无斜杠 = 顶层文件节（## project.yml）；带斜杠或以 /
// 收尾 = 目录型节（## chapters/vXX-cXXX.md、## research/）；其余（## 总原则）
// 是非文件节。.gitkeep 是点文件占位、只存在于子目录里，不参与顶层对账。
const isTopFileSection = (name) => !name.includes('/') && /\.[A-Za-z0-9]+$/.test(name)

test(`${QUICK_REL} 文件节 → templates/novel/ 对应文件存在（正向）`, () => {
  const fileSections = quickHeadings.filter(isTopFileSection)
  assert.ok(fileSections.length > 0, `${QUICK_REL} 没识别到任何「## <file>」顶层文件节——速查可能被重排，请更新本测试锚点`)
  const missing = fileSections.filter((name) => {
    const p = path.join(TEMPLATE_DIR, name)
    return !existsSync(p) || !statSync(p).isFile()
  })
  assert.deepEqual(
    missing,
    [],
    `${QUICK_REL} 有节、templates/novel/ 缺文件：${missing.join(', ')}\n` +
      `  速查文件节：${fileSections.join(', ')}\n  → 文件被删/改名时同步删改速查对应节`,
  )
})

test('templates/novel/ 顶层文件（*.yml、style.md、速查 README.md 本身）→ 速查有对应节（反向）', () => {
  const topFiles = readdirSync(TEMPLATE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
  assert.ok(topFiles.length > 0, 'templates/novel/ 顶层没列出任何文件——目录可能被移动，请先确认路径')
  const noSection = topFiles.filter((f) => !quickHeadings.includes(f))
  assert.deepEqual(
    noSection,
    [],
    `templates/novel/ 顶层有文件、${QUICK_REL} 没有对应「## <文件名>」节：${noSection.join(', ')}\n` +
      `  速查现存文件节：${quickHeadings.filter(isTopFileSection).join(', ')}\n` +
      `  → 本目录每个文件（含速查本身）都要在速查里有一节；新增/改名文件同步补节`,
  )
})

test('templates/novel/ 顶层目录 → 速查有对应目录节（## <dir>/ 或 ## <dir>/…）', () => {
  const topDirs = readdirSync(TEMPLATE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const noSection = topDirs.filter((d) => !quickHeadings.some((h) => h === `${d}/` || h.startsWith(`${d}/`)))
  assert.deepEqual(
    noSection,
    [],
    `templates/novel/ 顶层目录在 ${QUICK_REL} 没有任何对应节：${noSection.join(', ')}\n` +
      `  → 新增目录时补一节说明其文件命名与用途`,
  )
})

// ── 4. 拍板账键集 ───────────────────────────────────────────────────────────

const { parseFlatYamlArray } = await import('../lib/novel-parse.mjs')
const DECISION_KEYS = ['id', 'topic', 'decision', 'scope', 'date', 'source']
const DECISION_REQUIRED = ['id', 'topic', 'decision']

test('templates/novel/decisions.yml 条目键 ⊆ 规范键集且必含 id/topic/decision', () => {
  const warns = []
  const entries = parseFlatYamlArray(read('templates/novel/decisions.yml'), (w) => warns.push(w))
  assert.ok(Array.isArray(entries), 'templates/novel/decisions.yml 解析结果不是顶层数组——速查规定拍板账必须是顶层数组，先修文件')
  assert.deepEqual(warns, [], `templates/novel/decisions.yml 有不合规范的行：\n  ${warns.join('\n  ')}`)
  assert.ok(entries.length >= 1, 'templates/novel/decisions.yml 一条样例都没有——键集门禁将空转，请保留至少一条字段示例')
  for (const [i, entry] of entries.entries()) {
    const keys = Object.keys(entry)
    const extra = keys.filter((k) => !DECISION_KEYS.includes(k))
    const missing = DECISION_REQUIRED.filter((k) => !keys.includes(k))
    assert.deepEqual(
      { extra, missing },
      { extra: [], missing: [] },
      `templates/novel/decisions.yml 第 ${i + 1} 条键集越界：\n` +
        `  实际键：${keys.join(', ')}\n  规范键集：${DECISION_KEYS.join(', ')}\n` +
        (extra.length > 0 ? `  多出的键：${extra.join(', ')}\n` : '') +
        (missing.length > 0 ? `  缺必填键：${missing.join(', ')}\n` : '') +
        `  → 加键/删键须先改 docs/spec.md「decisions.yml」小节与速查示例，再动模板`,
    )
  }
})

test('docs/spec.md 有「decisions.yml」小节', () => {
  assert.ok(
    read('docs/spec.md').includes('### decisions.yml'),
    'docs/spec.md 缺「### decisions.yml」小节——拍板账的完整版说明缺失，请补回',
  )
})
