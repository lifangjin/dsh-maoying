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
 *   - checkProject 规则细化：expected_resolve 排期承诺口径（不查存在性）、
 *     resolved 必填兑现章且不早于埋设章、num 字符串归一、BOM 容错、
 *     重复键提醒、杂散章节文件沉底、解析层杂项（注释剥离/类型漂移/countCjk）；
 *   - checkProject 三条 warn 新规则：伏笔超期未推进、章纲缺「钩子」小节、
 *     AI 味统计（checkChapterStyle：连续同式开头 / 比喻词密度 / 句长波动）；
 *   - CLI brief / check：退出码、输出、--out 落盘与 stdout 一致；
 *   - 回归：init / stats / index / export 照常工作。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(PLUGIN_ROOT, 'bin', 'maoying.mjs')

const {
  buildBrief,
  CHAPTER_STATUSES,
  checkChapterStyle,
  checkProject,
  collectChapters,
  countCjk,
  flowScalar,
  FORESHADOW_STALE_CHAPTERS,
  listOutlines,
  parseChapterFile,
  parseFlatYamlArray,
  readOutline,
  readTextOrNull,
  splitFrontmatter,
  splitParagraphs,
  stripInlineComment,
  STYLE_METAPHOR_PER_KILO,
  STYLE_REPEAT_RUN,
  STYLE_SENTENCE_CV_MIN,
} = await import('../lib/novel-parse.mjs')

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

// AI 味统计夹具：三条指标各只命中一条的正文（前缀轮流换防不触发同式开头，
// 句数压在句长波动下限之下，比喻词只在一处出现）。
const STYLE_REPEAT_BODY = '他知道刀在鞘里。他知道马在棚里。他知道风里有人。天亮之前，一切都还来得及补救。'
const STYLE_METAPHOR_BODY = [
  '他仿佛看见旧年的雪压塌了粮道。城墙宛如一头伏兽。刀光恍若一线天光。',
  '北境的雪下了三天三夜，冻河改道，当铺行当随之兴起，旧部名册下落成谜，谁也说不清那半块玉佩的来历。',
].join('\n')
const STYLE_FLAT_BODY = Array.from(
  { length: 24 },
  (_, i) => `${['风从北来', '雪从天落', '云从山起'][i % 3]}他沿着驿道一直走。`,
).join('')

const GU_CARD = `---
name: 顾长风
age: 24
gender: 男
role: protagonist
appearance: 玄氅佩刀，眉眼冷峻
personality: 外冷内热，重诺少言
background: 北境戍卒出身，家破后入镖局
motivation: 查明北境雪灾背后的隐情
arc: 从孤身查案到守护北境
markers:
  - 想事情时擦刀
---

备注：全书主角。
`

const WORLD_XUEZAI = `---
category: 事件
tags:
  - 北境
---

三年前的北境雪灾压塌南口粮道，冻河改道，当铺行当随之兴起。
`

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

## 章尾钩子

沈墨撂下一句「北境的雪，埋的不止是粮道」，收刀没入风雪；林晚儿借灯笼一照，玉佩缺角与他的刀镡缺口正好吻合。
`

const OUTLINE_C003 = `# 第三章章纲 · 废驿对峙

本章目标：沈墨与林晚儿在废驿对峙，揭开旧部信物的来历。
出场角色：林晚儿、沈墨
与前章接口：承接废驿火光。

## 钩子

对峙收场，赵老头的旱烟袋当啷落地——他认得那半块玉佩。
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
  expected_resolve: v01-c004
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
  write(path.join(dir, 'characters/gu-changfeng.md'), GU_CARD)
  write(path.join(dir, 'characters/lin-waner.md'), LIN_CARD)
  write(path.join(dir, 'characters/shen-mo.md'), SHEN_CARD)
  write(path.join(dir, 'characters/zhao-laotou.md'), ZHAO_CARD)
  write(path.join(dir, 'world/bei-jing-xue-zai.md'), WORLD_XUEZAI)
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

/** 最小可检项目：两章 + 一份 foreshadows.yml（其余账本缺省按空），check 规则单点测试用。 */
function minimalCheckProject(dir, foreshadowsYaml) {
  write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
  write(path.join(dir, 'chapters/v01-c002.md'), chapterFm({ num: 2, title: '接续章' }) + '正文。\n')
  write(path.join(dir, 'foreshadows.yml'), foreshadowsYaml)
  return checkProject(dir)
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

test('解析层杂项：转义引号注释、类型漂移落值、扩展B计数、杂散章沉底、重复键提醒、空条目过滤', () => {
  // stripInlineComment：\\" 反斜杠成对（转义的是反斜杠自己），引号正常收尾、注释剥得掉
  assert.equal(stripInlineComment('"a\\\\" # 注释'), '"a\\\\" ')
  // 单个反斜杠才构成转义引号：注释原样保留
  assert.equal(stripInlineComment('"a\\" # 不是注释'), '"a\\" # 不是注释')
  // flowScalar：裸写会被 YAML 读成数字/布尔的串按 JSON 引号落值，普通中文保持裸写
  assert.equal(flowScalar('1984'), '"1984"')
  assert.equal(flowScalar('true'), '"true"')
  assert.equal(flowScalar('3.14'), '"3.14"')
  assert.equal(flowScalar('雪夜来客'), '雪夜来客')
  // countCjk：扩展 B 区生僻字（𠮷 = U+20BB7）计入
  assert.equal(countCjk('𠮷野家'), 3)
  // 解析器对 `-\n- foo` 保持宽容（空对象条目原样产出），过滤发生在 readYamlArray 侧
  assert.deepEqual(parseFlatYamlArray('-\n- foo'), [{}, 'foo'])
  // splitParagraphs / readTextOrNull 导出可用（bin 侧 bodyParagraphs / readTextOrNull 同语义）
  assert.deepEqual(splitParagraphs('第一段。\n\n第二段一行\n接着写。'), ['第一段。', '第二段一行接着写。'])
  assert.ok(readTextOrNull(BIN) !== null)
  assert.equal(readTextOrNull(path.join(tmpdir(), 'maoying-不存在的文件')), null)
  assert.deepEqual(CHAPTER_STATUSES.map(([s]) => s), ['pending', 'writing', 'review', 'accepted'])

  withWorkspace('parse-misc', (dir) => {
    // 杂散 .md（文件名不合规范）沉底，不再混在正常章之前
    write(path.join(dir, 'chapters/0-notes.md'), '随手记，不是章节。\n')
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1 }) + '正文。\n')
    write(path.join(dir, 'chapters/v01-c002.md'), chapterFm({ num: 2 }) + '正文。\n')
    assert.deepEqual(collectChapters(dir).map((c) => c.stem), ['v01-c001', 'v01-c002', '0-notes'])
    // 章节 frontmatter 重复键：last-wins 语义不变，check 给 warn 提醒
    write(
      path.join(dir, 'chapters/v01-c003.md'),
      [
        '---',
        'volume: v01',
        'num: 3',
        'title: 前面的标题',
        'title: 后面的标题',
        'status: pending',
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
    const dup = checkProject(dir)
    assert.ok(dup.problems.some((p) => p.level === 'warn' && p.file === 'chapters/v01-c003.md' && p.message.includes('重复键')))
    assert.equal(collectChapters(dir).find((c) => c.stem === 'v01-c003').title, '后面的标题')
    // `-` 空条目不混进账本计数（readYamlArray 侧过滤，这里数出来应是 1 条不是 2 条）
    write(
      path.join(dir, 'foreshadows.yml'),
      [
        '-',
        '- id: fs-777',
        '  title: 空条目后面的伏笔',
        '  status: planted',
        '  priority: low',
        '  planted_chapter: v01-c001',
        '  expected_resolve: ""',
        '  resolved_chapter: ""',
        '',
      ].join('\n'),
    )
    assert.equal(checkProject(dir).summary.foreshadows, 1)
  })
})

test('parseFlatYamlArray：顶层数组里零缩进散键行丢弃并告警（H2），顶层平键形态不受影响', () => {
  // 旧实现把散键静默并进前一条目（`- a: 1\nkey: 2` → [{a:1,key:2}]）
  const warns = []
  assert.deepEqual(parseFlatYamlArray('- a: 1\nkey: 2', (w) => warns.push(w)), [{ a: 1 }])
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('第 2 行') && warns[0].includes('key: 2') && warns[0].includes('已丢弃'), warns[0])
  // 散键不得覆盖前条已有字段（手改残留键覆盖 status 的原始事故形态）
  const warns2 = []
  assert.deepEqual(
    parseFlatYamlArray('- id: fs-001\n  status: planted\nstatus: resolved\n', (w) => warns2.push(w)),
    [{ id: 'fs-001', status: 'planted' }],
  )
  assert.equal(warns2.length, 1)
  // 顶层纯键值是合法映射形态：零告警、解析不变（H2 只管数组分支）
  const quiet = []
  assert.deepEqual(parseFlatYamlArray('title: 雪葬长夜\nphase: writing', (w) => quiet.push(w)), { title: '雪葬长夜', phase: 'writing' })
  assert.deepEqual(quiet, [])
  // 不传 onWarn 的旧调用点行为不变（bin 侧 parseSimpleYaml 等）
  assert.deepEqual(parseFlatYamlArray('- a: 1\nkey: 2'), [{ a: 1 }])
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

test('buildBrief：volumes.yml 零缩进散键告警并入 warnings（H2）', () => {
  withWorkspace('brief-stray-key', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1 }) + '正文。\n')
    write(path.join(dir, 'volumes.yml'), '- id: v01\n  title: 第一卷\nsummary: 手滑残留的散键\n')
    const brief = buildBrief(dir, 'v01-c001')
    assert.equal(brief.ok, true)
    assert.ok(
      brief.warnings.some((w) => w.includes('volumes.yml') && w.includes('已丢弃')),
      `散键告警应并入 warnings，实得 ${JSON.stringify(brief.warnings)}`,
    )
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
    // 阶段就绪判据（phase: writing ≥ outline）：坏样例无主角卡/反派卡/world 条目（volumes 在案不报）
    assert.ok(find('error', 'characters/', 'protagonist'))
    assert.ok(find('error', 'characters/', 'antagonist'))
    assert.ok(find('error', 'world/', 'world/ 与 science/ 均无条目'))
    // 汇总口径
    assert.equal(result.summary.chapters, 5)
    assert.equal(result.summary.foreshadows, 4)
    assert.equal(result.summary.problems.error, 13)
    assert.equal(result.summary.problems.warn, 7)
    assert.equal(result.problems.filter((p) => p.level === 'error').length, result.summary.problems.error)
    assert.equal(result.problems.filter((p) => p.level === 'warn').length, result.summary.problems.warn)
  })
})

test('checkProject：phase 越枚举与阶段就绪判据——outline 起查核心设定件', () => {
  withWorkspace('check-phase-gates', (dir) => {
    const mk = (name) => {
      const d = path.join(dir, name)
      write(path.join(d, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
      return d
    }
    const gateProblems = (r) => r.problems.filter((p) => p.message.includes('判据'))

    // ① phase 越枚举 → error
    const badEnumDir = mk('bad-enum')
    write(path.join(badEnumDir, 'project.yml'), 'phase: writting\nmode: ai-draft\n')
    const badEnum = checkProject(badEnumDir)
    assert.ok(badEnum.problems.some((p) => p.level === 'error' && p.message.includes('phase 越枚举：writting')))

    // ② phase: outline 四件核心设定件全缺 → 主角卡/反派卡/world/volumes 各报一条 error
    const missingDir = mk('outline-missing')
    write(path.join(missingDir, 'project.yml'), 'phase: outline\nmode: ai-draft\n')
    const missing = checkProject(missingDir)
    assert.ok(missing.problems.some((p) => p.level === 'error' && p.message.includes('role: protagonist')))
    assert.ok(missing.problems.some((p) => p.level === 'error' && p.message.includes('role: antagonist')))
    assert.ok(missing.problems.some((p) => p.level === 'error' && p.message.includes('world/ 与 science/')))
    assert.ok(missing.problems.some((p) => p.level === 'error' && p.message.includes('volumes.yml 为空或缺失')))

    // ③ phase: setting 同样缺件 → 判据不启用（新项目正常态，零判据问题）
    const settingDir = mk('setting-clean')
    write(path.join(settingDir, 'project.yml'), 'phase: setting\nmode: ai-draft\n')
    assert.equal(gateProblems(checkProject(settingDir)).length, 0)

    // ④ 判据件齐（science 条目也算世界观落盘）→ outline 起零判据问题
    const fullDir = mk('outline-full')
    write(path.join(fullDir, 'project.yml'), 'phase: outline\nmode: ai-draft\n')
    write(path.join(fullDir, 'characters/protag.md'), GU_CARD)
    write(path.join(fullDir, 'characters/antag.md'), SHEN_CARD)
    write(
      path.join(fullDir, 'science/ting-wu.md'),
      '---\nlabel: hypothesis\nreferences: []\n---\n\n听器物之语，鉴其流转。\n',
    )
    write(path.join(fullDir, 'volumes.yml'), '- id: v01\n  title: 第一卷\n  summary: 一句话定位\n  chapters: 001-010\n')
    write(path.join(fullDir, 'relations.yml'), '- a: protag\n  b: antag\n  type: 宿敌\n  intensity: 4\n  started: v01-c001\n  ended: ""\n')
    assert.equal(gateProblems(checkProject(fullDir)).length, 0)

    // ⑥ 两张卡但 relations.yml 为空 → 关系网判据报一条 error（六期补）
    const noRelDir = mk('outline-no-relations')
    write(path.join(noRelDir, 'project.yml'), 'phase: outline\nmode: ai-draft\n')
    write(path.join(noRelDir, 'characters/protag.md'), GU_CARD)
    write(path.join(noRelDir, 'characters/antag.md'), SHEN_CARD)
    write(
      path.join(noRelDir, 'science/ting-wu.md'),
      '---\nlabel: hypothesis\nreferences: []\n---\n\n听器物之语，鉴其流转。\n',
    )
    write(path.join(noRelDir, 'volumes.yml'), '- id: v01\n  title: 第一卷\n  summary: 一句话定位\n  chapters: 001-010\n')
    assert.ok(checkProject(noRelDir).problems.some((p) => p.level === 'error' && p.message.includes('relations.yml 为空')))

    // ⑦ 单卡项目（不足两张卡）不触发关系网判据——一卡无关系可言
    const oneCardDir = mk('outline-one-card')
    write(path.join(oneCardDir, 'project.yml'), 'phase: outline\nmode: ai-draft\n')
    write(path.join(oneCardDir, 'characters/protag.md'), GU_CARD)
    write(
      path.join(oneCardDir, 'science/ting-wu.md'),
      '---\nlabel: hypothesis\nreferences: []\n---\n\n听器物之语，鉴其流转。\n',
    )
    write(path.join(oneCardDir, 'volumes.yml'), '- id: v01\n  title: 第一卷\n  summary: 一句话定位\n  chapters: 001-010\n')
    assert.ok(!checkProject(oneCardDir).problems.some((p) => p.message.includes('relations.yml')))

    // ⑤ 无 project.yml/phase 键（旧项目形态）→ 不查也不报
    const bareDir = mk('bare')
    assert.equal(gateProblems(checkProject(bareDir)).length, 0)
  })
})

test('checkProject：expected_resolve 按排期承诺口径——指向未写章节不报错', () => {
  withWorkspace('check-expected-resolve', (dir) => {
    const fm = (expected, status = 'planted') =>
      [
        '- id: fs-100',
        '  title: 玉佩下落',
        `  status: ${status}`,
        '  priority: high',
        '  planted_chapter: v01-c001',
        `  expected_resolve: ${expected}`,
        '  resolved_chapter: ""',
        '',
      ].join('\n')
    // ① 排期到尚未写出的章（官方模板的常态）——零问题
    const future = minimalCheckProject(path.join(dir, 'future'), fm('v01-c099'))
    assert.equal(future.ok, true)
    assert.deepEqual(future.problems, [])
    // ② 反向提醒：排期目标已写出却还停在 planted——warn 不 error
    const stale = minimalCheckProject(path.join(dir, 'stale'), fm('v01-c002'))
    assert.equal(stale.ok, true)
    assert.equal(stale.problems.length, 1)
    assert.equal(stale.problems[0].level, 'warn')
    assert.ok(stale.problems[0].message.includes('planted'))
    // ③ 格式不合法（解析不出卷/章）仍要报 error
    const malformed = minimalCheckProject(path.join(dir, 'malformed'), fm('废驿对峙'))
    assert.equal(malformed.ok, false)
    assert.ok(malformed.problems.some((p) => p.level === 'error' && p.message.includes('expected_resolve')))
  })
})

test('checkProject：resolved 必填 resolved_chapter，且不得早于 planted_chapter', () => {
  withWorkspace('check-resolved-rules', (dir) => {
    const fm = (planted, resolved) =>
      [
        '- id: fs-200',
        '  title: 血迹来历',
        '  status: resolved',
        '  priority: normal',
        `  planted_chapter: ${planted}`,
        '  expected_resolve: ""',
        `  resolved_chapter: ${resolved}`,
        '',
      ].join('\n')
    // 回收缺兑现章 → error
    const missing = minimalCheckProject(path.join(dir, 'missing'), fm('v01-c001', '""'))
    assert.equal(missing.ok, false)
    assert.ok(missing.problems.some((p) => p.level === 'error' && p.message.includes('resolved_chapter')))
    // 回收早于埋设 → error（两章都存在，排除存在性干扰）
    const reversed = minimalCheckProject(path.join(dir, 'reversed'), fm('v01-c002', 'v01-c001'))
    assert.equal(reversed.ok, false)
    assert.ok(reversed.problems.some((p) => p.level === 'error' && p.message.includes('早于')))
    // 正常回收零问题
    const fine = minimalCheckProject(path.join(dir, 'fine'), fm('v01-c001', 'v01-c002'))
    assert.equal(fine.ok, true)
    assert.deepEqual(fine.problems, [])
  })
})

test('checkProject：伏笔超期未推进——planted 超阈值给 warn，progressing/邻近阈值不报', () => {
  // 阈值出处：skills/maoying-foreshadow-discipline/SKILL.md「清理纪律」
  assert.equal(FORESHADOW_STALE_CHAPTERS, 30)
  withWorkspace('check-fs-stale', (dir) => {
    const fm = (id, status, planted) =>
      [
        `- id: ${id}`,
        '  title: 玉佩下落',
        `  status: ${status}`,
        '  priority: high',
        `  planted_chapter: ${planted}`,
        '  expected_resolve: ""',
        '  resolved_chapter: ""',
        '',
      ].join('\n')
    // ① 正例：埋设于 v01-c001，全书已写到 v01-c032——间隔 31 章超阈值 → warn
    const staleDir = path.join(dir, 'stale')
    write(path.join(staleDir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
    write(path.join(staleDir, 'chapters/v01-c032.md'), chapterFm({ num: 32, title: '最新章' }) + '正文。\n')
    write(path.join(staleDir, 'foreshadows.yml'), fm('fs-001', 'planted', 'v01-c001'))
    const stale = checkProject(staleDir)
    assert.equal(stale.ok, true) // 只 warn 不 error
    assert.equal(stale.problems.length, 1)
    assert.equal(stale.problems[0].level, 'warn')
    assert.equal(stale.problems[0].file, 'foreshadows.yml')
    assert.equal(
      stale.problems[0].message,
      `伏笔 fs-001 埋设于 v01-c001，已 ${FORESHADOW_STALE_CHAPTERS + 1} 章未推进（阈值 ${FORESHADOW_STALE_CHAPTERS} 章）——确认是否遗忘`,
    )
    // ② 反例：间隔 1 章（远未到阈值）+ progressing/abandoned 不查——零问题
    const freshDir = path.join(dir, 'fresh')
    write(path.join(freshDir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
    write(path.join(freshDir, 'chapters/v01-c002.md'), chapterFm({ num: 2, title: '接续章' }) + '正文。\n')
    write(
      path.join(freshDir, 'foreshadows.yml'),
      [fm('fs-001', 'planted', 'v01-c001'), fm('fs-002', 'progressing', 'v01-c001'), fm('fs-003', 'abandoned', 'v01-c001')].join(
        '\n',
      ),
    )
    assert.deepEqual(checkProject(freshDir).problems, [])
  })
})

test('checkProject：章纲缺「钩子」小节——无钩子标题给 warn，带钩子与空目录不报', () => {
  withWorkspace('check-outline-hook', (dir) => {
    // ① 正例：章纲正文无钩子小节（含正文里提「钩子」但不是标题行）→ warn
    const badDir = path.join(dir, 'bad')
    write(path.join(badDir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
    write(path.join(badDir, 'outlines/v01-c001.md'), '# 第一章章纲\n\n本章目标：雪夜来客，章尾的钩子留到下一章。\n')
    const bad = checkProject(badDir)
    assert.equal(bad.problems.length, 1)
    assert.equal(bad.problems[0].level, 'warn')
    assert.equal(bad.problems[0].file, 'outlines/v01-c001.md')
    assert.equal(bad.problems[0].message, '章纲缺「钩子」小节（## 钩子 或 ## 章尾钩子）——章尾钩子须独立成节写明')
    // ② 反例：「## 章尾钩子」「### 钩子」都算数；空 outlines/ 目录不报——零问题
    const goodDir = path.join(dir, 'good')
    write(path.join(goodDir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
    write(
      path.join(goodDir, 'outlines/v01-c001.md'),
      '# 第一章章纲\n\n本章目标：雪夜来客。\n\n## 章尾钩子\n\n马队没入风雪，玉佩缺角对上刀镡缺口。\n',
    )
    write(path.join(goodDir, 'outlines/v01-c002.md'), '## 正文安排\n\n先追后谈。\n\n### 钩子\n\n雪地里又多了一行脚印。\n')
    const emptyDir = path.join(dir, 'empty')
    write(path.join(emptyDir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '开局章' }) + '正文。\n')
    mkdirSync(path.join(emptyDir, 'outlines'), { recursive: true })
    assert.deepEqual(checkProject(goodDir).problems, [])
    assert.deepEqual(checkProject(emptyDir).problems, [])
  })
})

test('checkChapterStyle：AI 味统计三指标各自命中，干净正文零消息', () => {
  // 三条指标互相独立：逐条构造只命中一条的正文，消息逐字对齐
  assert.deepEqual(checkChapterStyle(STYLE_REPEAT_BODY), [`疑似句式重复：连续 ${STYLE_REPEAT_RUN} 句以「他知」开头`])
  assert.deepEqual(checkChapterStyle(STYLE_METAPHOR_BODY), [
    `比喻词密度偏高：3 处 / 0.1千字（阈值 ${STYLE_METAPHOR_PER_KILO}/千字）——AI 味风险`,
  ])
  assert.deepEqual(checkChapterStyle(STYLE_FLAT_BODY), [
    `句长节奏过平：24 句变异系数 0.00（阈值 ${STYLE_SENTENCE_CV_MIN.toFixed(2)}）——长短句交替不足`,
  ])
  // 反例：现有长正文 / 短正文 / 空正文三条全不命中
  assert.deepEqual(checkChapterStyle(longChapterBody()), [])
  assert.deepEqual(checkChapterStyle(C002_BODY), [])
  assert.deepEqual(checkChapterStyle(''), [])
  // checkProject 侧：命中挂在章节文件名上，无正文的章不查
  withWorkspace('check-style', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1, title: '句式重复章' }) + STYLE_REPEAT_BODY + '\n')
    write(path.join(dir, 'chapters/v01-c002.md'), chapterFm({ num: 2, title: '无正文章' }))
    const result = checkProject(dir)
    const styleWarns = result.problems.filter((p) => p.level === 'warn' && p.message.includes('疑似句式重复'))
    assert.equal(styleWarns.length, 1)
    assert.equal(styleWarns[0].file, 'chapters/v01-c001.md')
  })
})

test('checkProject：num 手写成单引号字符串与文件名章号不再误报不一致', () => {
  withWorkspace('check-num-string', (dir) => {
    write(
      path.join(dir, 'chapters/v01-c003.md'),
      [
        '---',
        'volume: v01',
        "num: '3'",
        'title: 单引号章号',
        'status: pending',
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
    const result = checkProject(dir)
    assert.deepEqual(result.problems, [])
  })
})

test('BOM 文件：frontmatter 不因 \\uFEFF 静默失效', () => {
  withWorkspace('bom-frontmatter', (dir) => {
    const text = '\uFEFF' + chapterFm({ num: 7, title: '带BOM的章' }) + '正文。\n'
    // 解析层：meta 正常解析，body 不带 BOM
    const parsed = parseChapterFile(text)
    assert.equal(parsed.meta.title, '带BOM的章')
    assert.equal(parsed.meta.num, 7)
    assert.ok(parsed.body.startsWith('正文'))
    // fence.index 契约不变：raw 仍是原文 text.slice(index, index + raw.length)（写侧行级手术依赖）
    const fence = splitFrontmatter(text)
    assert.equal(text.slice(fence.index, fence.index + fence.raw.length), fence.raw)
    // 落盘后走 check：带 BOM 的章节不再被误报缺必填键
    write(path.join(dir, 'chapters/v01-c007.md'), text)
    const result = checkProject(dir)
    assert.deepEqual(result.problems, [])
  })
})

test('checkProject：账本 yml 零缩进散键给 warn（H2 并入 problems 通道）', () => {
  withWorkspace('check-stray-key', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1 }) + '正文。\n')
    write(
      path.join(dir, 'foreshadows.yml'),
      '- id: fs-001\n  status: planted\n  priority: low\n  planted_chapter: v01-c001\ntitle: 顶层散键残留\n',
    )
    const result = checkProject(dir)
    const hit = result.problems.find((p) => p.level === 'warn' && p.file === 'foreshadows.yml')
    assert.ok(hit && hit.message.includes('title: 顶层散键残留'), `散键应给 warn，实得 ${JSON.stringify(result.problems)}`)
    // 散键未并进条目：伏笔账本仍只有原条目自身
    assert.equal(result.summary.foreshadows, 1)
  })
})

test('checkProject：volumes.yml id 重复报 error（M8：同 id 卷会把章节重复计入）', () => {
  withWorkspace('check-vol-dup', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1 }) + '正文。\n')
    write(
      path.join(dir, 'volumes.yml'),
      '- id: v01\n  title: 第一卷\n  summary: 正主\n  chapters: 001-001\n- id: v01\n  title: 第一卷之二\n  summary: 手改残留的重复卷\n  chapters: 001-001\n',
    )
    const result = checkProject(dir)
    assert.equal(result.ok, false)
    const hit = result.problems.find((p) => p.level === 'error' && p.file === 'volumes.yml')
    assert.ok(hit && hit.message.includes('id 重复：v01') && hit.message.includes('第 1 条与第 2 条'), JSON.stringify(result.problems))
  })
})

test('checkProject：M9 对称校验——clue/memories 枚举与章节引用、timeline.chapter、relations.started、foreshadows.source', () => {
  withWorkspace('check-m9-bad', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1 }) + '正文。\n')
    write(path.join(dir, 'clue-board.yml'), '- kind: hunch\n  content: 玉佩成对\n  related_chapter: v01-c099\n  resolved: false\n')
    write(path.join(dir, 'memories.yml'), '- category: vibe\n  content: 林晚儿登场\n  source_chapter: v01-c099\n')
    // 花写年份（只给 warn）也不放过 chapter 引用校验（error 并存）
    write(path.join(dir, 'timeline.yml'), '- year: 玄历三年冬\n  title: 北境雪灾\n  description: 花写年份挡不住引用校验\n  chapter: v01-c099\n')
    write(path.join(dir, 'relations.yml'), '- a: ghost\n  b: ghost2\n  type: 宿敌\n  started: v01-c099\n')
    write(path.join(dir, 'foreshadows.yml'), '- id: fs-001\n  status: planted\n  priority: high\n  planted_chapter: v01-c001\n  source: rewrite\n')
    const result = checkProject(dir)
    const errs = result.problems.filter((p) => p.level === 'error').map((p) => `${p.file}|${p.message}`)
    assert.ok(errs.some((m) => m.startsWith('clue-board.yml|') && m.includes('kind 越枚举：hunch')), JSON.stringify(errs))
    assert.ok(errs.some((m) => m.startsWith('clue-board.yml|') && m.includes('related_chapter 引用章节不存在：v01-c099')))
    assert.ok(errs.some((m) => m.startsWith('memories.yml|') && m.includes('category 越枚举：vibe')))
    assert.ok(errs.some((m) => m.startsWith('memories.yml|') && m.includes('source_chapter 引用章节不存在：v01-c099')))
    assert.ok(errs.some((m) => m.startsWith('timeline.yml|') && m.includes('chapter 引用章节不存在：v01-c099')))
    assert.ok(errs.some((m) => m.startsWith('relations.yml|') && m.includes('started 引用章节不存在：v01-c099')))
    assert.ok(errs.some((m) => m.startsWith('foreshadows.yml|') && m.includes('source 越枚举：rewrite')))
  })
})

test('checkProject：M9 合法枚举与在案引用零新增问题', () => {
  withWorkspace('check-m9-clean', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1, status: 'accepted' }) + '正文一。\n')
    write(path.join(dir, 'chapters/v01-c002.md'), chapterFm({ num: 2, status: 'accepted' }) + '正文二。\n')
    write(path.join(dir, 'clue-board.yml'), '- kind: red-herring\n  content: 掌柜装作不识玉佩\n  related_chapter: v01-c001\n  resolved: false\n')
    write(path.join(dir, 'memories.yml'), '- category: appearance\n  content: 林晚儿于 v01-c001 登场\n  source_chapter: v01-c001\n')
    // 年份须含数字（纯汉字纪年另有 warn），枚举值与引用全部在案
    write(path.join(dir, 'timeline.yml'), '- year: 玄历1024年冬\n  title: 北境雪灾\n  importance: 4\n  chapter: v01-c001\n')
    write(
      path.join(dir, 'foreshadows.yml'),
      '- id: fs-001\n  status: resolved\n  priority: high\n  planted_chapter: v01-c001\n  resolved_chapter: v01-c002\n  source: backfill\n',
    )
    const result = checkProject(dir)
    assert.deepEqual(result.problems, [])
  })
})

test('M10：.md 大小写不敏感——CLI 侧 collectChapters / checkProject 都收录 .MD 章', () => {
  withWorkspace('md-casing', (dir) => {
    write(path.join(dir, 'chapters/v01-c001.md'), chapterFm({ num: 1 }) + '正文一。\n')
    write(path.join(dir, 'chapters/v01-c002.MD'), chapterFm({ num: 2 }) + '正文二。\n')
    // collectChapters（listMdFiles 口径）收录 .MD，且章号序正常（stem 已去后缀）
    assert.deepEqual(
      collectChapters(dir).map((c) => c.file),
      ['v01-c001.md', 'v01-c002.MD'],
    )
    // checkProject 同口径：大写后缀章计入章节数，不当杂散文件漏计
    assert.equal(checkProject(dir).summary.chapters, 2)
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

// ── export 格式矩阵（docs/design.md §8：md / txt / epub，HTML 从未实现）──────

test('export 默认（无 --format）：md 落到 <dir>/exports/', () => {
  withWorkspace('export-default', (dir) => {
    const proj = path.join(dir, 'proj')
    buildCleanSample(proj)
    const r = runCli(['export', proj])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes('格式 md'), `stdout 应带所选格式：${r.stdout}`)
    const produced = readdirSync(path.join(proj, 'exports'))
    assert.equal(produced.length, 1)
    assert.ok(produced[0].endsWith('.md'), `默认产物应为 .md：${produced[0]}`)
  })
})

test('export --format epub：产物存在且头两字节为 PK（zip 魔数）', () => {
  withWorkspace('export-epub', (dir) => {
    const proj = path.join(dir, 'proj')
    buildCleanSample(proj)
    const r = runCli(['export', proj, '--format', 'epub'])
    assert.equal(r.status, 0, r.stderr)
    const [file] = readdirSync(path.join(proj, 'exports'))
    assert.ok(file && file.endsWith('.epub'), `应有 .epub 产物：${file}`)
    const head = readFileSync(path.join(proj, 'exports', file)).subarray(0, 2)
    assert.equal(head.toString('latin1'), 'PK', `epub 应以 zip 魔数 PK 开头，实得 ${head.toString('hex')}`)
  })
})

test('export 未知格式：exit 1，stderr 点名格式与合法取值（html 从未实现）', () => {
  withWorkspace('export-badfmt', (dir) => {
    const proj = path.join(dir, 'proj')
    buildCleanSample(proj)
    const r = runCli(['export', proj, '--format', 'html'])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('未知导出格式'), `stderr 应点名未知格式：${r.stderr}`)
    assert.ok(r.stderr.includes('html') && r.stderr.includes('md'), 'stderr 应复述格式名与合法取值')
  })
})

test('export --out 自定义目录：产物落在指定目录（同名自动改序号，不覆盖）', () => {
  withWorkspace('export-out', (dir) => {
    const proj = path.join(dir, 'proj')
    buildCleanSample(proj)
    const outDir = path.join(dir, '自定义导出')
    const r = runCli(['export', proj, '--format', 'txt', '--out', outDir])
    assert.equal(r.status, 0, r.stderr)
    const m = /导出完成：(.+)/.exec(r.stdout)
    assert.ok(m, `stdout 应带产物绝对路径：${r.stdout}`)
    const produced = m[1].trim()
    assert.ok(path.dirname(produced) === path.resolve(outDir), `产物应落在 --out 目录：${produced}`)
    assert.ok(existsSync(produced))
    // 再跑一次同名导出：自动加序号 -2，绝不静默覆盖
    const again = runCli(['export', proj, '--format', 'txt', '--out', outDir])
    assert.equal(again.status, 0)
    assert.ok(again.stderr.includes('-2'), `重复导出应提示改写去向：${again.stderr}`)
    assert.equal(readdirSync(outDir).length, 2)
  })
})
