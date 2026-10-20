/**
 * 五期 CLI 两条新命令（brief / check）与其解析层的自包含测试。
 *
 * 夹具全部自建在 /tmp（mkdtemp，跑完即删），不碰 test/fixtures.mjs——那是
 * 面板任务的文件。CLI 用例直接 spawnSync node bin/maoying.mjs，验证真实
 * 退出码与输出；解析层用例直接调 lib/novel-parse.mjs 的导出。
 *
 * 覆盖：
 *   - readOutline / listOutlines：同名章纲读取、章号序；
 *   - buildBrief：全料样例、缺章纲降级、第一章开篇、三种章节参数写法等价、硬失败；
 *   - checkProject：逐类问题各一条 + 全净样例零问题；
 *   - CLI brief / check：退出码、输出、--out 落盘与 stdout 一致；
 *   - 回归：init / stats / index / export 照常工作。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(PLUGIN_ROOT, 'bin', 'maoying.mjs')

const { buildBrief, checkProject, countCjk, listOutlines, readOutline } = await import('../lib/novel-parse.mjs')

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 建一个 /tmp 工作区，fn 跑完（无论成败）整个删掉。 */
function withWorkspace(label, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), `maoying-${label}-`))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
}

// ── 夹具：全净样例 ──────────────────────────────────────────────────────────

/** 合规章节 frontmatter（五维齐全）；opts 可覆盖键值或去掉 summary / suspense。 */
function chapterFm(opts = {}) {
  const {
    volume = 'v01',
    num = 1,
    title = '雪夜来客',
    status = 'pending',
    writer = null,
    withSummary = true,
    withSuspense = true,
  } = opts
  const lines = ['---', `volume: ${volume}`, `num: ${num}`, `title: ${title}`, `status: ${status}`]
  if (writer !== null) lines.push(`writer: ${writer}`)
  if (withSummary) lines.push('summary: 一句话梗概，index 与 stats 直接引用')
  lines.push('cognitive_frame: 读者以为老者是路人，实际是旧部信使')
  lines.push('emotional_anchor: 孤身入局的紧绷与雪夜的压抑')
  lines.push('world_texture: 北境驿站的风物与雪夜行路的规矩')
  if (withSuspense) lines.push('suspense: 半块玉佩到底认谁？')
  lines.push('interpersonal_tension: 林晚儿与当铺掌柜的试探')
  lines.push('---', '')
  return lines.join('\n')
}

/** 长正文：25 段，总量超过 1500 字，用来验证前章结尾的整段截尾。 */
function longChapterBody() {
  const paras = []
  for (let i = 1; i <= 25; i++) {
    const head =
      i === 1
        ? '这是第一章的开篇段落，北境的雪下了三天三夜。'
        : i === 25
          ? '这是第一章的收尾段落，他攥紧了手里的半块玉佩。'
          : `这是第一章的第${i}段。`
    paras.push(`${head}${'雪还在下，'.repeat(12)}风从垭口灌进来。`)
  }
  return paras.join('\n\n')
}

const C002_BODY = [
  '雪粒子打在灯笼纸上，噼啪作响。',
  '林晚儿勒住马，盯着雪地里那行深一脚浅一脚的脚印，脚印尽头，废驿的门虚掩着。',
  '她没有拔刀，先把袖口的银扣按了下去。',
].join('\n\n')

const LIN_CARD = `---
name: 林晚儿
age: 19
gender: 女
role: supporting
appearance: 青衫佩刀，袖口有银扣
personality: 外冷内热，嘴硬心软
background: 北境镖局遗孤，父亲当年被逐出师门
motivation: 查明父亲被逐出师门的真相
arc: 从寻仇到守城
markers:
  - 紧张时摩挲袖口
---

备注：前期与沈墨敌对，中期并肩。
`

const SHEN_CARD = `---
name: 沈墨
age: 27
gender: 男
role: antagonist
appearance: 灰氅旧刀，左手缺半根小指
personality: 阴鸷自制，话少刀快
background: 旧部遗孤，家被北境王府抄没
motivation: 夺回被北境王府侵吞的旧部名册
arc: 从复仇到放下
markers:
  - 说谎前先摸刀柄
---

备注：信物与半块玉佩同源。
`

const ZHAO_CARD = `---
name: 赵老头
age: 60
gender: 男
role: minor
appearance: 驼背，手里总搓着旱烟袋
personality: 糊涂账里最明白的人
background: 沈墨父辈的亲兵，退役后在当铺做伙计
motivation: 守着当铺，等旧部来取最后一箱东西
arc: 无弧线，功能性角色
markers:
  - 说话前先咳嗽两声
---

备注：第一章埋、第三章收的信息节点。
`

const OUTLINE_C002 = `# 第二章章纲 · 雪夜再临

本章目标：雪夜追踪，林晚儿与沈墨在废驿初次正面交锋，半块玉佩第一次示人。

节拍：
1. 雪夜追踪马蹄印，发现血迹；
2. 废驿遭遇，交手三个回合；
3. 沈墨亮出旧部信物，林晚儿收刀。

出场角色：林晚儿、沈墨、赵铁柱

需埋伏笔：无；需收伏笔：无。
与前章接口：承接第一章末尾的玉佩悬念。
`

const OUTLINE_C003 = `# 第三章章纲 · 废驿对峙

本章目标：沈墨与林晚儿在废驿对峙，揭开旧部信物的来历。
出场角色：林晚儿、沈墨
与前章接口：承接废驿火光。
`

const CLEAN_PROJECT = `title: 雪葬北境
author: 张三
genre: 东方玄幻
length: 约80万字
language: zh
phase: writing
mode: co-write
description: 一个关于雪与刀的故事
`

const CLEAN_VOLUMES = `- id: v01
  title: 第一卷 北境风雪
  summary: 主角踏入北境的第一卷
  chapters: 001-003
`

const CLEAN_FORESHADOWS = `- id: fs-001
  title: 老者留下的半块玉佩
  status: planted
  priority: high
  planted_chapter: v01-c001
  expected_resolve: v01-c003
  resolved_chapter: ""
  notes: 废驿对峙时示人，验明旧部身份
- id: fs-002
  title: 马蹄印上的血迹
  status: progressing
  priority: normal
  planted_chapter: v01-c002
  expected_resolve: v01-c003
  resolved_chapter: ""
  notes: 顺着血迹找到第三具尸体
- id: fs-003
  title: 当铺掌柜多找的三枚铜钱
  status: resolved
  priority: low
  planted_chapter: v01-c001
  expected_resolve: v01-c001
  resolved_chapter: v01-c002
  notes: 第二章开头由掌柜自己说明
- id: fs-004
  title: 城南的旧战场传闻
  status: abandoned
  priority: low
  planted_chapter: v01-c001
  expected_resolve: ""
  resolved_chapter: ""
  notes: 与主线无关，明确弃用
`

const CLEAN_TIMELINE = `- year: 1024
  title: 北境雪灾
  description: 三天三夜的雪压塌了南口粮道
  importance: 4
  chapter: v01-c001
- year: 1025
  title: 废驿对峙
  description: 林晚儿与沈墨初次交锋
  importance: 3
  chapter: v01-c003
`

// 沈墨被引用两次、其余各一次——主角判定的计数口径要能分出高下
const CLEAN_RELATIONS = `- a: shen-mo
  b: lin-waner
  type: 宿敌
  description: 旧部名册与镖局遗孤的旧账
  intensity: 4
  started: v01-c002
  ended: ""
- a: shen-mo
  b: zhao-laotou
  type: 旧部
  description: 赵老头是沈墨父辈的亲兵
  intensity: 2
  started: v01-c001
  ended: ""
`

function buildCleanSample(dir, { withOutline3 = true } = {}) {
  write(path.join(dir, 'project.yml'), CLEAN_PROJECT)
  write(path.join(dir, 'volumes.yml'), CLEAN_VOLUMES)
  write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '雪夜来客', status: 'accepted' }) + longChapterBody() + '\n')
  write(path.join(dir, 'chapters/v01-c002.md'), chapterFm({ num: 2, title: '雪夜再临', status: 'writing', writer: 'author' }) + C002_BODY + '\n')
  write(path.join(dir, 'chapters/v01-c003.md'), chapterFm({ num: 3, title: '废驿对峙', status: 'pending' }) + '正文还没动笔。\n')
  write(path.join(dir, 'characters/lin-waner.md'), LIN_CARD)
  write(path.join(dir, 'characters/shen-mo.md'), SHEN_CARD)
  write(path.join(dir, 'characters/zhao-laotou.md'), ZHAO_CARD)
  write(path.join(dir, 'outlines/v01-c002.md'), OUTLINE_C002)
  if (withOutline3) write(path.join(dir, 'outlines/v01-c003.md'), OUTLINE_C003)
  write(path.join(dir, 'foreshadows.yml'), CLEAN_FORESHADOWS)
  write(path.join(dir, 'timeline.yml'), CLEAN_TIMELINE)
  write(path.join(dir, 'relations.yml'), CLEAN_RELATIONS)
}

// ── 夹具：坏样例（check 逐类问题各一条）─────────────────────────────────────

function buildBadSample(dir) {
  // mode 越枚举
  write(path.join(dir, 'project.yml'), CLEAN_PROJECT.replace('mode: co-write', 'mode: solo'))
  write(path.join(dir, 'volumes.yml'), CLEAN_VOLUMES)
  // 缺 status 必填键（连带五维缺失与 summary 缺失两条 warn）
  write(path.join(dir, 'chapters/v01-c001.md'), '---\nvolume: v01\nnum: 1\ntitle: 缺状态章\n---\n\n正文一段。\n')
  // status 与 writer 双越枚举（其余键齐全，只报这两条 error）
  write(
    path.join(dir, 'chapters/v01-c002.md'),
    [
      '---',
      'volume: v01',
      'num: 2',
      'title: 状态越枚举章',
      'status: finished',
      'writer: gpt',
      'summary: 有梗概',
      'cognitive_frame: 有',
      'emotional_anchor: 有',
      'world_texture: 有',
      'suspense: 有',
      'interpersonal_tension: 有',
      '---',
      '',
      '正文。',
      '',
    ].join('\n'),
  )
  // 五维缺 suspense + summary 缺失（warn 级）
  write(
    path.join(dir, 'chapters/v01-c003.md'),
    chapterFm({ num: 3, title: '缺五维章', withSuspense: false, withSummary: false }) + '正文。\n',
  )
  // frontmatter volume 与文件名卷号不一致
  write(
    path.join(dir, 'chapters/v01-c004.md'),
    chapterFm({ volume: 'v02', num: 4, title: '卷号不一致章' }) + '正文。\n',
  )
  // frontmatter num 与文件名章号不一致
  write(path.join(dir, 'chapters/v01-c005.md'), chapterFm({ volume: 'v01', num: 9, title: '章号不一致章' }) + '正文。\n')
  write(path.join(dir, 'characters/lin-waner.md'), LIN_CARD)
  // 角色卡缺 name
  write(path.join(dir, 'characters/broken.md'), '---\nrole: minor\n---\n\n没有名字的卡。\n')
  // 伏笔：引用不存在的章号 / status 越枚举 / id 重复
  write(
    path.join(dir, 'foreshadows.yml'),
    [
      '- id: fs-001',
      '  title: 引用不存在章号的伏笔',
      '  status: planted',
      '  priority: high',
      '  planted_chapter: v01-c099',
      '  expected_resolve: ""',
      '  resolved_chapter: ""',
      '  notes: 应报引用不存在',
      '- id: fs-a',
      '  title: 状态越枚举的伏笔',
      '  status: forgotten',
      '  priority: normal',
      '  planted_chapter: v01-c001',
      '  expected_resolve: ""',
      '  resolved_chapter: ""',
      '  notes: 应报 status 越枚举',
      '- id: fs-dup',
      '  title: 重复编号第一条',
      '  status: planted',
      '  priority: low',
      '  planted_chapter: v01-c001',
      '  expected_resolve: ""',
      '  resolved_chapter: ""',
      '  notes: ""',
      '- id: fs-dup',
      '  title: 重复编号第二条',
      '  status: planted',
      '  priority: low',
      '  planted_chapter: v01-c001',
      '  expected_resolve: ""',
      '  resolved_chapter: ""',
      '  notes: ""',
      '',
    ].join('\n'),
  )
  // 时间线：无法解析的年份 + 倒挂
  write(
    path.join(dir, 'timeline.yml'),
    [
      '- year: 1024',
      '  title: 北境雪灾',
      '  description: ""',
      '  importance: 4',
      '  chapter: v01-c001',
      '- year: 玄历三年冬',
      '  title: 年份无法解析',
      '  description: ""',
      '  importance: 2',
      '  chapter: v01-c001',
      '- year: 300',
      '  title: 年份倒挂',
      '  description: ""',
      '  importance: 2',
      '  chapter: v01-c002',
      '',
    ].join('\n'),
  )
  // 关系：a 端角色无卡
  write(
    path.join(dir, 'relations.yml'),
    [
      '- a: ghost-guy',
      '  b: lin-waner',
      '  type: 宿敌',
      '  description: a 端角色无卡',
      '  intensity: 3',
      '  started: v01-c001',
      '  ended: ""',
      '',
    ].join('\n'),
  )
}

// ── 解析层：章纲 ────────────────────────────────────────────────────────────

test('readOutline / listOutlines：同名章纲读取与章号序', () => {
  withWorkspace('outlines', (dir) => {
    buildCleanSample(dir)
    const outline = readOutline(dir, 'v01-c002.md')
    assert.ok(outline !== null)
    assert.equal(outline.file, 'outlines/v01-c002.md')
    assert.equal(outline.chapter, 'v01-c002')
    assert.equal(outline.words, countCjk(outline.body))
    assert.ok(outline.body.includes('本章目标：雪夜追踪'))
    // stem 与文件名两种写法等价
    assert.deepEqual(readOutline(dir, 'v01-c002'), outline)
    // 没有章纲返回 null（可选文件不算错误）
    assert.equal(readOutline(dir, 'v01-c001'), null)
    // 列表按章号升序
    assert.deepEqual(listOutlines(dir).map((o) => o.chapter), ['v01-c002', 'v01-c003'])
    assert.deepEqual(listOutlines(path.join(dir, 'no-such')), [])
  })
})

// ── 解析层：写作卡 ──────────────────────────────────────────────────────────

test('buildBrief：全料样例拼出完整写作卡', () => {
  withWorkspace('brief-full', (dir) => {
    buildCleanSample(dir)
    const brief = buildBrief(dir, 'v01-c002')
    assert.equal(brief.ok, true)
    assert.ok(Array.isArray(brief.warnings))

    // 五个段标题齐全且按序出现
    const headings = ['## 本章章纲', '## 前章结尾', '## 出场角色卡', '## 活跃伏笔', '## 本章状态']
    const at = headings.map((h) => brief.text.indexOf(h))
    for (const i of at) assert.ok(i >= 0, `缺段标题：${headings[at.indexOf(i)]}`)
    assert.deepEqual([...at].sort((a, b) => a - b), at)

    // 大标题：卷名 + 章号 + 章题
    assert.ok(brief.text.startsWith('# 写作卡 · 第一卷 北境风雪 第2章 雪夜再临\n'))

    // 章纲原文照录
    assert.ok(brief.text.includes('本章目标：雪夜追踪，林晚儿与沈墨在废驿初次正面交锋'))

    // 前章结尾：整段截尾，含收尾标记、不含开篇标记，约 1500 字
    const prevSection = brief.text.slice(brief.text.indexOf('## 前章结尾'), brief.text.indexOf('## 出场角色卡'))
    assert.ok(prevSection.includes('> 接上一章 v01-c001《雪夜来客》结尾'))
    assert.ok(prevSection.includes('收尾段落'))
    assert.ok(prevSection.includes('半块玉佩'))
    assert.equal(prevSection.includes('开篇段落'), false)
    assert.ok(prevSection.length > 1400, `前章结尾应约 1500 字，实际 ${prevSection.length}`)
    assert.ok(prevSection.length < 2400)

    // 角色卡：按章纲出场序，字段原文照录
    const roleSection = brief.text.slice(brief.text.indexOf('## 出场角色卡'), brief.text.indexOf('## 活跃伏笔'))
    const linAt = roleSection.indexOf('### 林晚儿（lin-waner）')
    const shenAt = roleSection.indexOf('### 沈墨（shen-mo）')
    assert.ok(linAt >= 0)
    assert.ok(shenAt > linAt)
    assert.ok(roleSection.includes('- 角色定位：supporting'))
    assert.ok(roleSection.includes('- 一句话性格：外冷内热，嘴硬心软'))
    assert.ok(roleSection.includes('- 当前动机：查明父亲被逐出师门的真相'))
    assert.ok(roleSection.includes('- 角色定位：antagonist'))
    // 章纲点名但未建档的角色：有兜底提示
    assert.ok(roleSection.includes('赵铁柱'))

    // 活跃伏笔：只收 planted/progressing，字段照录
    const fsSection = brief.text.slice(brief.text.indexOf('## 活跃伏笔'), brief.text.indexOf('## 本章状态'))
    assert.ok(fsSection.includes('- fs-001 老者留下的半块玉佩'))
    assert.ok(fsSection.includes('优先级：high'))
    assert.ok(fsSection.includes('埋设章：v01-c001'))
    assert.ok(fsSection.includes('预期回收章：v01-c003'))
    assert.ok(fsSection.includes('- fs-002 马蹄印上的血迹'))
    assert.equal(fsSection.includes('当铺掌柜多找的三枚铜钱'), false) // resolved 不收
    assert.equal(fsSection.includes('城南的旧战场传闻'), false) // abandoned 不收

    // 本章状态：frontmatter 原文 + writer + mode
    assert.ok(brief.text.includes('- 状态：writing（写作中）'))
    assert.ok(brief.text.includes('- 写手：author'))
    assert.ok(brief.text.includes('- 模式：co-write'))

    // warnings：只有「角色卡找不到」这一条非致命情况
    assert.equal(brief.warnings.length, 1)
    assert.ok(brief.warnings[0].includes('角色卡找不到'))
    assert.ok(brief.warnings[0].includes('赵铁柱'))
  })
})

test('buildBrief：缺章纲走降级文案，角色回退前章出场加主角', () => {
  withWorkspace('brief-no-outline', (dir) => {
    buildCleanSample(dir, { withOutline3: false })
    const brief = buildBrief(dir, 'v01-c003')
    assert.equal(brief.ok, true)
    assert.ok(brief.text.includes('暂无章纲，建议先让主编安排大纲师出章纲'))
    assert.equal(brief.warnings.length, 1)
    assert.ok(brief.warnings[0].includes('outlines/v01-c003.md'))
    const roleSection = brief.text.slice(brief.text.indexOf('## 出场角色卡'), brief.text.indexOf('## 活跃伏笔'))
    // 前章（c002）正文点名的林晚儿 + relations 引用最多的主角沈墨
    assert.ok(roleSection.includes('### 林晚儿（lin-waner）'))
    assert.ok(roleSection.includes('### 沈墨（shen-mo）'))
    // 没出场的龙套不硬塞
    assert.equal(roleSection.includes('赵老头'), false)
  })
})

test('buildBrief：第一章给「全书开篇」，角色只剩主角', () => {
  withWorkspace('brief-first', (dir) => {
    buildCleanSample(dir)
    const brief = buildBrief(dir, 'v01-c001')
    assert.equal(brief.ok, true)
    assert.ok(brief.text.includes('全书开篇，无前章'))
    assert.ok(brief.text.includes('暂无章纲，建议先让主编安排大纲师出章纲'))
    assert.ok(brief.text.includes('### 沈墨（shen-mo）'))
    assert.equal(brief.text.includes('林晚儿'), false)
    assert.ok(brief.text.includes('- 状态：accepted（已定稿）'))
    assert.equal(brief.warnings.length, 1)
    assert.ok(brief.warnings[0].includes('outlines/v01-c001.md'))
  })
})

test('buildBrief：文件名 / stem /「卷-章」/ 裸章号写法等价，硬失败口径清晰', () => {
  withWorkspace('brief-refs', (dir) => {
    buildCleanSample(dir)
    const base = buildBrief(dir, 'v01-c002').text
    assert.equal(buildBrief(dir, 'v01-c002.md').text, base)
    assert.equal(buildBrief(dir, '1-2').text, base)
    assert.equal(buildBrief(dir, 'v1-c2').text, base)
    assert.equal(buildBrief(dir, '2').text, base)
    // 章节不存在
    const missing = buildBrief(dir, 'v09-c099')
    assert.equal(missing.ok, false)
    assert.ok(missing.reason.includes('找不到章节'))
    // 项目不存在
    const noProject = buildBrief(path.join(dir, 'no-such-project'), 'v01-c001')
    assert.equal(noProject.ok, false)
    assert.ok(noProject.reason.includes('找不到'))
  })
})

// ── CLI：brief ──────────────────────────────────────────────────────────────

test('CLI brief：--out 落盘与 stdout 内容一致，提醒与提示走 stderr', () => {
  withWorkspace('cli-brief', (dir) => {
    buildCleanSample(dir)
    const expected = buildBrief(dir, 'v01-c002').text

    const outFile = path.join(dir, 'card.md')
    const withOut = runCli(['brief', dir, 'v01-c002', '--out', outFile])
    assert.equal(withOut.status, 0)
    assert.equal(readFileSync(outFile, 'utf8'), expected)
    assert.ok(withOut.stdout.includes('写作卡已写入'))
    assert.ok(withOut.stdout.includes('拿去写'))

    const plain = runCli(['brief', dir, 'v01-c002'])
    assert.equal(plain.status, 0)
    assert.equal(plain.stdout, expected)
    assert.ok(plain.stderr.includes('拿去写'))
    assert.ok(plain.stderr.includes('提醒：'))
    assert.ok(plain.stderr.includes('角色卡找不到'))
  })
})

test('CLI brief：错误走中文报错加非零退出码', () => {
  withWorkspace('cli-brief-err', (dir) => {
    buildCleanSample(dir)
    const badChapter = runCli(['brief', dir, 'v09-c099'])
    assert.equal(badChapter.status, 1)
    assert.ok(badChapter.stderr.includes('找不到章节'))
    const noProject = runCli(['brief', path.join(dir, 'no-such'), 'v01-c001'])
    assert.equal(noProject.status, 1)
    assert.ok(noProject.stderr.includes('找不到'))
    const noArgs = runCli(['brief'])
    assert.equal(noArgs.status, 1)
    assert.ok(noArgs.stderr.includes('用法'))
  })
})

// ── 解析层：静态体检 ────────────────────────────────────────────────────────

test('checkProject：全净样例零问题', () => {
  withWorkspace('check-clean', (dir) => {
    buildCleanSample(dir)
    const result = checkProject(dir)
    assert.equal(result.ok, true)
    assert.deepEqual(result.problems, [])
    assert.deepEqual(result.summary, {
      chapters: 3,
      outlines: 2,
      foreshadows: 4,
      problems: { error: 0, warn: 0 },
    })
  })
})

test('checkProject：逐类坏样例各报一条，计数自洽', () => {
  withWorkspace('check-bad', (dir) => {
    buildBadSample(dir)
    const result = checkProject(dir)
    assert.equal(result.ok, false)
    const find = (level, file, messagePart) =>
      result.problems.find((p) => p.level === level && p.file === file && p.message.includes(messagePart))
    // 章节 frontmatter：必填键 / 越枚举 / 五维 / summary
    assert.ok(find('error', 'chapters/v01-c001.md', '缺少必填键 status'))
    assert.ok(find('warn', 'chapters/v01-c001.md', '五维字段缺失'))
    assert.ok(find('warn', 'chapters/v01-c001.md', 'summary 缺失'))
    assert.ok(find('error', 'chapters/v01-c002.md', 'status 越枚举：finished'))
    assert.ok(find('error', 'chapters/v01-c002.md', 'writer 越枚举：gpt'))
    assert.ok(find('warn', 'chapters/v01-c003.md', '五维字段缺失：suspense'))
    assert.ok(find('warn', 'chapters/v01-c003.md', 'summary 缺失'))
    // 章号/卷号与文件名一致
    assert.ok(find('error', 'chapters/v01-c004.md', 'volume（v02）与文件名卷号（v01）不一致'))
    assert.ok(find('error', 'chapters/v01-c005.md', 'num（9）与文件名章号（5）不一致'))
    // 伏笔：引用存在性 / 越枚举 / id 重复
    assert.ok(find('error', 'foreshadows.yml', '引用章节不存在：v01-c099'))
    assert.ok(find('error', 'foreshadows.yml', 'status 越枚举：forgotten'))
    assert.ok(find('error', 'foreshadows.yml', 'id 重复：fs-dup'))
    // 时间线：年份不可解析 / 倒挂
    assert.ok(find('warn', 'timeline.yml', 'year 无法解析为数字：玄历三年冬'))
    assert.ok(find('warn', 'timeline.yml', '年份序倒挂'))
    // 关系：悬空引用（warn 不 error——可能是已死亡或未建档角色）
    assert.ok(find('warn', 'relations.yml', 'a 端角色无卡：ghost-guy'))
    // 角色卡 / 模式
    assert.ok(find('error', 'characters/broken.md', '缺少 name'))
    assert.ok(find('error', 'project.yml', 'mode 越枚举：solo'))
    // 汇总口径
    assert.equal(result.summary.chapters, 5)
    assert.equal(result.summary.foreshadows, 4)
    assert.equal(result.summary.problems.error, 10)
    assert.equal(result.summary.problems.warn, 7)
    assert.equal(result.problems.filter((p) => p.level === 'error').length, result.summary.problems.error)
    assert.equal(result.problems.filter((p) => p.level === 'warn').length, result.summary.problems.warn)
  })
})

// ── CLI：check ──────────────────────────────────────────────────────────────

test('CLI check：有 error 退出码 1，全净退出码 0', () => {
  withWorkspace('cli-check', (dir) => {
    const badDir = path.join(dir, 'bad')
    const cleanDir = path.join(dir, 'clean')
    buildBadSample(badDir)
    buildCleanSample(cleanDir)

    const bad = runCli(['check', badDir])
    assert.equal(bad.status, 1)
    assert.ok(bad.stdout.includes('[错误]'))
    assert.ok(bad.stdout.includes('[提醒]'))
    assert.ok(bad.stdout.includes('chapters/v01-c002.md'))
    assert.ok(bad.stdout.includes('汇总：'))

    const clean = runCli(['check', cleanDir])
    assert.equal(clean.status, 0)
    assert.ok(clean.stdout.includes('未发现问题'))
    assert.ok(clean.stdout.includes('错误 0 个'))

    const noProject = runCli(['check', path.join(dir, 'no-such')])
    assert.equal(noProject.status, 1)
  })
})

// ── help 与回归 ─────────────────────────────────────────────────────────────

test('--help 列出 brief 与 check', () => {
  const help = runCli(['--help'])
  assert.equal(help.status, 0)
  assert.ok(help.stdout.includes('maoying brief'))
  assert.ok(help.stdout.includes('maoying check'))
})

test('回归：init / stats / index / export 对样例项目照常工作', () => {
  withWorkspace('regression', (dir) => {
    const fresh = path.join(dir, 'fresh')
    const init = runCli(['init', fresh])
    assert.equal(init.status, 0)
    assert.ok(init.stdout.includes('毛颖脚手架'))
    assert.ok(existsSync(path.join(fresh, 'project.yml')))

    const proj = path.join(dir, 'proj')
    buildCleanSample(proj)
    const stats = runCli(['stats', proj])
    assert.equal(stats.status, 0)
    assert.ok(stats.stdout.includes('总字数'))
    assert.ok(stats.stdout.includes('状态分布'))

    const index = runCli(['index', proj])
    assert.equal(index.status, 0)
    assert.ok(index.stdout.includes('已重建'))
    assert.ok(readFileSync(path.join(proj, 'index.yml'), 'utf8').includes('volumes:'))

    const exportOut = path.join(dir, 'exports-out')
    const exp = runCli(['export', proj, '--format', 'txt', '--out', exportOut])
    assert.equal(exp.status, 0)
    assert.ok(exp.stdout.includes('导出完成'))
  })
})
