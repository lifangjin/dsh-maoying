/**
 * panel-core 单测：快照契约字段逐一断言 + 写操作三件套（正常流转 / 非法值拒 /
 * 替换计数 ≠1 拒 409）+ 路径穿越拒 403。全部跑在 /tmp 临时工作区上。
 *
 * 解析走两条路都断言：yamlLib 显式置 null（极简回退，确定性）为主；
 * 若本机 loadYamlLib 能借到 yaml 包，再加一轮真解析抽查（数组字段是真数组）。
 * 另设「生产默认路径」用例：把 /tmp/yamlcheck 的 yaml 包搬进 TEST_HOME/node_modules，
 * 覆盖不传 options 时从 DSH_HOME 惰性借包的真解析分支（staging 缺席优雅 skip）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 测试全程把 DSH_HOME 钉在一次性临时目录——parseStateSnapshot 默认路径
// （loadYamlLib(resolveDshHome())）绝不落到真实 ~/.dsh 上。
// makeTmpRoot 包一层登记进 tmpRoots，test.after 统一删除（含模块级 TEST_HOME），
// 对照 test/installer-shape.test.mjs 的清理写法。
import { buildSampleNovel, makeRegistry, makeTmpRoot as makeRawTmpRoot } from './fixtures.mjs'

const PREV_DSH_HOME = process.env.DSH_HOME
const tmpRoots = []
function makeTmpRoot(prefix) {
  const dir = makeRawTmpRoot(prefix)
  tmpRoots.push(dir)
  return dir
}
const TEST_HOME = makeTmpRoot('maoying-home-')
process.env.DSH_HOME = TEST_HOME

test.after(() => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREV_DSH_HOME
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const {
  createChapterFromOutline,
  listWorkspaces,
  parseStateSnapshot,
  readChapter,
  readOutlineFile,
  resolveNovelRoot,
  mutateChapterBody,
  mutateChapterStatus,
  mutateForeshadowStatus,
  mutateOutlineBody,
  mutatePhase,
  mutateProject,
  rebuildIndex,
  managedRelCheck,
  validateManagedText,
  readManagedFile,
  saveManagedFile,
  createManagedFile,
  deleteManagedFile,
  PanelError,
} = await import('../lib/panel-core.mjs')
const { FIVE_DIM_KEYS, sha256Hex } = await import('../lib/novel-parse.mjs')
const { loadYamlLib } = await import('../lib/yaml-loader.mjs')

/** 状态码断言助手：fn 必须抛出带指定 statusCode 的 PanelError。 */
function assertFails(fn, statusCode, messageIncludes) {
  let caught = null
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof PanelError, `应抛 PanelError，实得 ${caught}`)
  assert.equal(caught.statusCode, statusCode)
  if (messageIncludes) assert.ok(String(caught.message).includes(messageIncludes), `报错应含「${messageIncludes}」，实得「${caught.message}」`)
}

test('resolveNovelRoot：注册表内的根放行并返回 novel 目录', () => {
  const root = makeTmpRoot()
  const novel = resolveNovelRoot(root, makeRegistry([root]))
  assert.equal(novel, path.join(path.resolve(root), 'novel'))
})

test('resolveNovelRoot：白名单外的根 403、缺参 422', () => {
  const root = makeTmpRoot()
  const registry = makeRegistry([root])
  assertFails(() => resolveNovelRoot('/etc', registry), 403)
  assertFails(() => resolveNovelRoot(path.join(root, 'sub'), registry), 403) // 子路径也不放行：严格相等
  assertFails(() => resolveNovelRoot('', registry), 422)
  assertFails(() => resolveNovelRoot(undefined, registry), 422)
})

test('resolveNovelRoot：注册表缺失时一律 403（空白名单）', () => {
  assertFails(() => resolveNovelRoot('/tmp', undefined), 403)
})

test('listWorkspaces：逐根探测 novel/project.yml，name 缺省取目录名', () => {
  const withNovel = makeTmpRoot()
  buildSampleNovel(withNovel)
  const withoutNovel = makeTmpRoot()
  const workspaces = listWorkspaces(makeRegistry([withNovel, withoutNovel]))
  assert.equal(workspaces.length, 2)
  const hit = workspaces.find((w) => w.path === path.resolve(withNovel))
  const miss = workspaces.find((w) => w.path === path.resolve(withoutNovel))
  assert.equal(hit.hasNovel, true)
  assert.equal(miss.hasNovel, false)
  assert.equal(hit.name, path.basename(path.resolve(withNovel)))
})

test('parseStateSnapshot（回退解析）：§3 契约字段逐一就位', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const snap = parseStateSnapshot(novel, { yamlLib: null })

  // 顶层
  assert.equal(snap.ok, true)
  assert.equal(snap.root, path.resolve(root))
  assert.equal(snap.novelDir, path.resolve(novel))
  assert.equal(snap.found, true)
  assert.ok(!Number.isNaN(Date.parse(snap.generatedAt)))
  assert.ok(Array.isArray(snap.warnings))

  // project 七键
  assert.deepEqual(Object.keys(snap.project).sort(), ['author', 'description', 'genre', 'language', 'length', 'mode', 'phase', 'title'])
  assert.equal(snap.project.title, '雪葬长夜')
  assert.equal(snap.project.phase, 'writing')
  assert.equal(snap.project.language, 'zh')

  // chapters：按 volume,num 升序；五维字段齐全
  assert.equal(snap.chapters.length, 2)
  const [c1, c2] = snap.chapters
  assert.deepEqual(Object.keys(c1).sort(), [
    'cognitive_frame', 'emotional_anchor', 'file', 'interpersonal_tension',
    'num', 'status', 'summary', 'suspense', 'title', 'volume', 'words', 'world_texture',
  ].sort())
  assert.equal(c1.file, 'v01-c001.md')
  assert.equal(c1.volume, 'v01')
  assert.equal(c1.num, 1)
  assert.equal(c1.title, '雪夜来客')
  assert.equal(c1.status, 'accepted')
  assert.equal(c1.words, 17)
  assert.equal(c1.summary, '当铺夜客以半块玉佩抵债，主角看出端倪。')
  assert.equal(c1.cognitive_frame, '读者与主角同步发现玉佩缺口暗合族徽')
  assert.equal(c2.num, 2)
  assert.equal(c2.status, 'writing')
  assert.ok(c1.num < c2.num)

  // characters：markers 数组；坏文件只进 warnings 不炸快照
  assert.equal(snap.characters.length, 2) // broken.md 是目录，读取失败被跳过
  const lin = snap.characters.find((c) => c.file === 'lin-waner.md')
  assert.deepEqual(Object.keys(lin).sort(), [
    'age', 'appearance', 'arc', 'background', 'file', 'gender',
    'markers', 'motivation', 'name', 'personality', 'role',
  ].sort())
  assert.equal(lin.name, '林晚儿')
  assert.equal(lin.age, 19)
  assert.equal(lin.role, 'supporting')
  assert.deepEqual(lin.markers, ['紧张时摩挲袖口', '说话前先抿嘴'])

  // relations：端点归一——契约里的 slug（lin-waner/shen-mo）出快照时改写成角色
  // name（林晚儿/沈默），关系图客户端按 name 找节点才有边可画
  assert.equal(snap.relations.length, 1)
  assert.deepEqual(snap.relations[0], {
    a: '林晚儿', b: '沈默', type: '宿敌',
    description: '当铺交锋结下的梁子', intensity: 4,
    started: 'v01-c003', ended: '',
  })

  // foreshadows：裸标量条目被跳过并警告；缺 status 行的条目 status 为 null；
  // source（五期）夹具回填条目为 backfill，缺省一律归 plan
  assert.equal(snap.foreshadows.length, 3)
  assert.equal(snap.foreshadows[0].id, 'fs-001')
  assert.equal(snap.foreshadows[0].status, 'planted')
  assert.equal(snap.foreshadows[0].priority, 'high')
  assert.equal(snap.foreshadows[0].resolved_chapter, '')
  assert.equal(snap.foreshadows[0].source, 'plan')
  assert.equal(snap.foreshadows[1].id, 'fs-002')
  assert.equal(snap.foreshadows[1].source, 'backfill')
  assert.equal(snap.foreshadows[2].id, 'fs-003')
  assert.equal(snap.foreshadows[2].status, null)
  assert.equal(snap.foreshadows[2].source, 'plan')
  assert.deepEqual(Object.keys(snap.foreshadows[1]).sort(), [
    'expected_resolve', 'id', 'notes', 'planted_chapter', 'priority',
    'resolved_chapter', 'source', 'status', 'title',
  ].sort())

  // timeline / memories / clues
  assert.equal(snap.timeline[0].year, '玄历三年冬')
  assert.equal(snap.timeline[0].importance, 4)
  assert.equal(snap.memories[0].category, 'appearance')
  assert.equal(snap.clues[0].kind, 'clue')
  assert.equal(snap.clues[0].resolved, false)

  // world / science / research（name 取 slug；tags/references 数组）
  assert.equal(snap.world.length, 1)
  assert.equal(snap.world[0].file, 'north-realm.md')
  assert.equal(snap.world[0].name, 'north-realm')
  assert.equal(snap.world[0].category, '地点')
  assert.deepEqual(snap.world[0].tags, ['北境', '长夜镇'])
  assert.ok(snap.world[0].description.includes('长夜镇'))
  assert.equal(snap.science[0].label, 'extrapolation')
  assert.deepEqual(snap.science[0].references, ['known:灵气密度与纬度'])
  assert.equal(snap.research[0].topic, '北境封冻期风物考')
  assert.deepEqual(snap.research, [{ file: 'bei-jing-feng-su.md', topic: '北境封冻期风物考', sources: ['https://example.com/fengsu'], description: '封冻八个月的镇子靠凿冰取水。' }])
  // volumes：分卷规划原样出快照（概览分卷卡取数）
  assert.deepEqual(snap.volumes, [{ id: 'v01', title: '第一卷 北境风雪', summary: '雪灾揭幕，玉佩现世。', chapters: '001-002' }])

  // outlines（五期）：按 chapterSortKey（卷、章号）升序；孤儿章纲（正文未写）
  // 照列；words 为 CJK 计数；excerpt 为折叠空白的节选原料
  assert.deepEqual(snap.outlines.map((o) => o.file), ['v01-c001.md', 'v01-c003.md'])
  assert.deepEqual(snap.outlines.map((o) => o.chapter), ['v01-c001.md', 'v01-c003.md'])
  assert.ok(snap.outlines[0].words > 0, `章纲 words 应为正整数，实得 ${snap.outlines[0].words}`)
  assert.ok(snap.outlines[1].words > 0)
  assert.ok(snap.outlines[0].excerpt.includes('夜客抵债'))
  assert.ok(!snap.outlines[0].excerpt.includes('\n'), 'excerpt 应折叠空白为单行')
  assert.ok(!snap.warnings.some((w) => w.includes('outlines')), `outlines 正常解析不应告警，实得 ${JSON.stringify(snap.warnings)}`)

  // totals
  assert.deepEqual(snap.totals, { chapters: 2, words: 31, byStatus: { pending: 0, writing: 1, review: 0, accepted: 1 } })

  // warnings：坏目录 + 坏条目各一条
  assert.ok(snap.warnings.some((w) => w.includes('characters/broken.md') && w.includes('读取失败')), `warnings 应含坏目录条目，实得 ${JSON.stringify(snap.warnings)}`)
  assert.ok(snap.warnings.some((w) => w.includes('foreshadows.yml') && w.includes('不是键值映射')), `warnings 应含坏条目，实得 ${JSON.stringify(snap.warnings)}`)
})

test('parseStateSnapshot：relations 端点归一——未知 slug 与 name 端点原样保留', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  writeFileSync(path.join(novel, 'relations.yml'), `- a: lin-waner
  b: ghost-x
  type: 暂别
  description: 未建档角色端点保留原值
  intensity: 2
  started: v01-c001
  ended: ""
- a: 林晚儿
  b: shen-mo
  type: 旧识
  description: 历史条目直接写 name，无 slug 可对，原样保留
  intensity: 3
  started: v01-c001
  ended: ""
`, 'utf8')
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  assert.equal(snap.relations.length, 2)
  assert.deepEqual(snap.relations.map((r) => [r.a, r.b]), [
    ['林晚儿', 'ghost-x'],
    ['林晚儿', '沈默'],
  ])
})

test('parseStateSnapshot：未初始化（无 project.yml）found=false 其余缺省', () => {
  const root = makeTmpRoot()
  const novel = path.join(root, 'novel')
  mkdirSync(novel, { recursive: true })
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  assert.deepEqual(snap, { ok: true, root: path.resolve(root), novelDir: path.resolve(novel), found: false, project_hash: null, warnings: [] })
})

test('parseStateSnapshot：project_hash 为 project.yml 原文 sha256，动一个字节即变（人工改动保护基线）', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'project.yml')
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  assert.ok(/^[0-9a-f]{64}$/.test(snap.project_hash), `应为 64 位小写 hex，实得 ${snap.project_hash}`)
  assert.equal(snap.project_hash, createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex'))

  // 外部改一个字节：快照指纹跟着变——面板保存拿旧值当 base_hash 就会被 409
  const before = snap.project_hash
  writeFileSync(target, readFileSync(target, 'utf8').replace('title: 雪葬长夜', 'title: 雪葬长夜！'), 'utf8')
  assert.notEqual(parseStateSnapshot(novel, { yamlLib: null }).project_hash, before)
})

test('parseStateSnapshot：yaml 包可用时真解析（条件执行，本机借不到就跳过）', (t) => {
  const yamlLib = loadYamlLib(TEST_HOME)
  if (!yamlLib) return t.skip('本机无可借的 yaml 包')
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const snap = parseStateSnapshot(novel, { yamlLib })
  const lin = snap.characters.find((c) => c.file === 'lin-waner.md')
  assert.deepEqual(lin.markers, ['紧张时摩挲袖口', '说话前先抿嘴'])
  assert.equal(lin.age, 19)
  assert.equal(snap.totals.words, 31)
  // 真解析路径同验新增键：volumes 与 research 正文（与回退解析口径一致）
  assert.deepEqual(snap.volumes, [{ id: 'v01', title: '第一卷 北境风雪', summary: '雪灾揭幕，玉佩现世。', chapters: '001-002' }])
  assert.equal(snap.research[0].description, '封冻八个月的镇子靠凿冰取水。')
  assert.deepEqual(snap.research[0].sources, ['https://example.com/fengsu'])
})

// ── 写操作三件套 ────────────────────────────────────────────────────────────

test('mutateChapterStatus：正常流转，只动 status 一行', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'chapters', 'v01-c002.md')
  const before = readFileSync(target, 'utf8')

  const result = mutateChapterStatus(novel, 'v01-c002.md', 'review')
  assert.deepEqual(result, { ok: true, file: 'v01-c002.md', status: 'review' })

  const after = readFileSync(target, 'utf8')
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  assert.equal(beforeLines.length, afterLines.length)
  const changed = beforeLines.filter((l, i) => l !== afterLines[i])
  assert.deepEqual(changed, ['status: writing'])
  assert.ok(afterLines.includes('status: review'))
})

test('mutateChapterStatus：非法值 422、穿越 403、缺文件 404', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  assertFails(() => mutateChapterStatus(novel, 'v01-c001.md', 'done'), 422, 'status')
  assertFails(() => mutateChapterStatus(novel, '../project.yml', 'writing'), 403)
  assertFails(() => mutateChapterStatus(novel, 'a/b.md', 'writing'), 403)
  assertFails(() => mutateChapterStatus(novel, '不存在.md', 'writing'), 404)
  // 写后校验：穿越被拒，目标文件毫发无损
  assert.ok(readFileSync(path.join(novel, 'project.yml'), 'utf8').includes('phase: writing'))
})

test('mutateChapterStatus：围栏内无 status 行（计数 0）409、双 status 行（计数 2）409、无围栏 409', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  // 夹具自带 fs-003……不，章节侧用临时造的文件验证
  writeFileSync(path.join(novel, 'chapters', 'v01-nostatus.md'), `---
volume: v01
num: 9
title: 没状态的章
---

正文。
`, 'utf8')
  writeFileSync(path.join(novel, 'chapters', 'v01-dup.md'), `---
volume: v01
num: 10
status: pending
title: 双状态行
status: writing
---

正文。
`, 'utf8')
  writeFileSync(path.join(novel, 'chapters', 'v01-bare.md'), '没有围栏，整篇都是正文。\n', 'utf8')
  assertFails(() => mutateChapterStatus(novel, 'v01-nostatus.md', 'writing'), 409)
  assertFails(() => mutateChapterStatus(novel, 'v01-dup.md', 'review'), 409)
  assertFails(() => mutateChapterStatus(novel, 'v01-bare.md', 'writing'), 409)
  // 409 拒写不落盘：原文件原样
  assert.ok(readFileSync(path.join(novel, 'chapters', 'v01-dup.md'), 'utf8').includes('status: pending\ntitle: 双状态行'))
  assert.ok(readFileSync(path.join(novel, 'chapters', 'v01-bare.md'), 'utf8').startsWith('没有围栏'))
})

test('mutateChapterStatus：status 行尾注释流转后原样保留', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'chapters', 'v01-c002.md')
  writeFileSync(target, readFileSync(target, 'utf8').replace('status: writing\n', 'status: writing # 编辑部在盯\n'), 'utf8')

  mutateChapterStatus(novel, 'v01-c002.md', 'review')
  const text = readFileSync(target, 'utf8')
  assert.ok(text.includes('status: review # 编辑部在盯'), '行尾注释应随流转原样保留')
  assert.ok(!text.includes('status: writing'), '旧值不应残留')
})

test('mutateForeshadowStatus：正常流转，只动对应条目的 status 行', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'foreshadows.yml')
  const before = readFileSync(target, 'utf8')

  assert.deepEqual(mutateForeshadowStatus(novel, 'fs-001', 'progressing'), { ok: true, id: 'fs-001', status: 'progressing' })

  const after = readFileSync(target, 'utf8')
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const changed = beforeLines.filter((l, i) => l !== afterLines[i])
  assert.deepEqual(changed, ['  status: planted']) // 只有 fs-001 块内那一行变了
  assert.ok(afterLines.includes('  status: progressing'))
  // fs-001 与 fs-002 都是 progressing（后者原本就是）——验证条目块定位没误伤：
  // fs-002 块的 planted_chapter 应保持 v01-c002
  assert.ok(after.includes('planted_chapter: v01-c002'))
})

test('mutateForeshadowStatus：非法值 422、坏 id 422、未知 id 404、无 status 行 409', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  assertFails(() => mutateForeshadowStatus(novel, 'fs-001', 'done'), 422)
  assertFails(() => mutateForeshadowStatus(novel, '../etc', 'planted'), 422)
  assertFails(() => mutateForeshadowStatus(novel, 'fs 001', 'planted'), 422)
  assertFails(() => mutateForeshadowStatus(novel, 'fs-999', 'progressing'), 404)
  assertFails(() => mutateForeshadowStatus(novel, 'fs-003', 'resolved'), 409) // fs-003 没写 status 行
})

test('mutateForeshadowStatus：status 行尾注释与间距流转后原样保留', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'foreshadows.yml')
  writeFileSync(target, readFileSync(target, 'utf8').replace('  status: planted\n', '  status: planted   # 埋于第一章当铺夜客\n'), 'utf8')

  mutateForeshadowStatus(novel, 'fs-001', 'progressing')
  const text = readFileSync(target, 'utf8')
  assert.ok(text.includes('  status: progressing   # 埋于第一章当铺夜客'), '行尾注释与值后间距应原样保留')
  assert.ok(!text.includes('  status: planted'), '旧值不应残留')
})

test('mutatePhase：正常推进且保住行尾注释；非法值 422；无 phase 行 409', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'project.yml')

  assert.deepEqual(mutatePhase(novel, 'review'), { ok: true, phase: 'review' })
  const text = readFileSync(target, 'utf8')
  assert.ok(text.includes('phase: review             # 七阶段：'), 'phase 值应被替换且行尾注释保留')
  assert.ok(!text.includes('phase: writing'))

  assertFails(() => mutatePhase(novel, 'done'), 422)

  const noPhase = makeTmpRoot()
  const novel2 = path.join(noPhase, 'novel')
  mkdirSync(novel2, { recursive: true })
  writeFileSync(path.join(novel2, 'project.yml'), 'title: 无阶段\n', 'utf8')
  assertFails(() => mutatePhase(novel2, 'writing'), 409)
})

test('mutateProject：批量改写保注释、缺键补齐、越枚举/空书名 422、特殊字符引号包裹', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'project.yml')
  const before = readFileSync(target, 'utf8')

  assert.deepEqual(mutateProject(novel, {
    title: '新 书名: 带冒号', author: '墨客', genre: '东方玄幻', length: '约100万字',
    language: 'zh', phase: 'outline', mode: 'co-write', description: '一句话"简介"',
  }), { ok: true, project_hash: createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex') })
  const after = readFileSync(target, 'utf8')
  assert.ok(after.includes('title: "新 书名: 带冒号"'), '含冒号空格的值应双引号包裹')
  assert.ok(after.includes('mode: co-write'), 'mode 应写入')
  assert.ok(after.includes('phase: outline'), 'phase 应写入')
  assert.ok(/phase: outline[ \t]*#/.test(after), 'phase 行尾注释应保留')
  assert.ok(after.includes('author: 墨客'), '安全字符裸写')
  assert.ok(after.includes('description: "一句话\\"简介\\"'), '双引号应转义包裹')
  // 原有注释头不应丢
  assert.ok(after.includes('# project.yml'), '模板注释头应保留')

  assertFails(() => mutateProject(novel, { title: 'x', phase: 'done', mode: 'ai-draft' }), 422)
  assertFails(() => mutateProject(novel, { title: 'x', phase: 'idea', mode: 'ghost' }), 422)
  assertFails(() => mutateProject(novel, { title: '  ', phase: 'idea', mode: 'ai-draft' }), 422)

  // 缺键补齐：只有 title/phase/mode 的文件，其余键应按模板补在末尾
  const root2 = makeTmpRoot()
  const novel2 = path.join(root2, 'novel')
  mkdirSync(novel2, { recursive: true })
  writeFileSync(path.join(novel2, 'project.yml'), 'title: 简本\nphase: idea\nmode: ai-draft\n', 'utf8')
  mutateProject(novel2, { title: '简本', phase: 'idea', mode: 'ai-draft', author: '阿墨' })
  const text2 = readFileSync(path.join(novel2, 'project.yml'), 'utf8')
  assert.ok(text2.includes('author: 阿墨'), '缺失键应补齐')
  assert.ok(text2.includes('language: zh'), '语言缺省补 zh')
})

test('mutateProject：值含 #（长#夜）连存两次仍合法且值不变，行尾注释照留', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'project.yml')
  const values = { title: '长#夜', phase: 'writing', mode: 'ai-draft' }

  mutateProject(novel, values)
  const once = readFileSync(target, 'utf8')
  assert.ok(once.includes('title: "长#夜"'), '值内 # 不是注释，应整体双引号包裹')
  assert.ok(!once.includes('"长#夜"#'), '不应出现注释截断产物（title: "长#夜"#夜"）')
  assert.ok(/^mode: ai-draft[ \t]+# 五期模式开关/m.test(once), 'mode 行尾注释应原样保留')

  mutateProject(novel, values)
  const twice = readFileSync(target, 'utf8')
  assert.equal(twice, once, '同值连存两次应逐字节一致（回归：值内 # 被当注释截断的刀法损坏）')

  // 回读仍是原字符串：回退解析 + 真 YAML 双路（借不到 yaml 只跑回退路）
  assert.equal(parseStateSnapshot(novel, { yamlLib: null }).project.title, '长#夜')
  const yamlLib = loadYamlLib(TEST_HOME)
  if (yamlLib) assert.equal(parseStateSnapshot(novel, { yamlLib }).project.title, '长#夜')
})

test('mutateProject：纯数字/布尔形书名（2046、true、-2.5）落盘带引号，回读不漂成 number/boolean', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'project.yml')
  const yamlLib = loadYamlLib(TEST_HOME)

  for (const title of ['2046', 'true', '-2.5']) {
    mutateProject(novel, { title, phase: 'idea', mode: 'ai-draft' })
    const text = readFileSync(target, 'utf8')
    assert.ok(text.includes(`title: "${title}"`), `「${title}」应双引号包裹落盘`)
    // 真 YAML 回读：双引号标量恒为字符串（借不到 yaml 时跳过该路；回退解析的
    // parseScalarText 对带引号数字串的还原本属 novel-parse，不在本文件断言）
    if (yamlLib) assert.equal(parseStateSnapshot(novel, { yamlLib }).project.title, title)
    mutateProject(novel, { title, phase: 'idea', mode: 'ai-draft' })
    assert.equal(readFileSync(target, 'utf8'), text, `「${title}」连存两次应逐字节一致`)
  }
})

test('mutateProject：baseHash 基线一致放行并返回新 hash；过期基线 409 拒写不落盘；缺省跳过检查', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'project.yml')
  const values = { title: '基线一致', author: '墨客', genre: '', length: '', language: 'zh', phase: 'writing', mode: 'ai-draft', description: '' }
  const baseline = createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex')

  // 基线一致：写成功，返回写后新指纹（客户端下一轮保存的基线）
  const res = mutateProject(novel, values, { baseHash: baseline })
  assert.equal(res.ok, true)
  const after = readFileSync(target, 'utf8')
  assert.ok(after.includes('title: 基线一致'))
  assert.equal(res.project_hash, createHash('sha256').update(after, 'utf8').digest('hex'))

  // 过期基线（baseline 是首次写入前的指纹，文件已被上面那次「外部改动」推进）：
  // 409 点名外部修改，且文件一个字节都不动
  const stale = readFileSync(target, 'utf8')
  assertFails(() => mutateProject(novel, { ...values, title: '覆盖未遂' }, { baseHash: baseline }), 409, '外部修改')
  assert.equal(readFileSync(target, 'utf8'), stale, '409 拒写不得落盘')

  // 缺省 options（旧调用方）：跳过旧版检测，行为与现状一致
  assert.deepEqual(Object.keys(mutateProject(novel, { ...values, title: '无基线' })), ['ok', 'project_hash'])
  assert.ok(readFileSync(target, 'utf8').includes('title: 无基线'))

  // 指纹大小写宽容：大写 hex 视为同值（指纹本身 hex，归一后比较）
  const fresh = createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex').toUpperCase()
  assert.equal(mutateProject(novel, { ...values, title: '大写基线' }, { baseHash: fresh }).ok, true)
})

test('parseFrontmatterFallback：__proto__ 键只落自身属性，改写不了原型（null 原型加固）', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  writeFileSync(path.join(novel, 'chapters', 'v01-proto.md'), `---
__proto__: injected
title: 原型试探
---

正文。
`, 'utf8')

  const { frontmatter } = readChapter(novel, 'v01-proto.md', { yamlLib: null })
  assert.equal(Object.getPrototypeOf(frontmatter), null, 'meta 应是无原型对象')
  assert.equal(frontmatter.__proto__, 'injected', '__proto__ 应是自身属性')
  assert.equal(frontmatter.title, '原型试探', '正常键不受影响')
})

test('rebuildIndex：index.yml 落盘且确定性（两次重建逐字节一致）；chapters/ 缺失 404', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  assert.deepEqual(rebuildIndex(novel), { ok: true, chapters: 2 })
  const first = readFileSync(path.join(novel, 'index.yml'), 'utf8')
  assert.ok(first.includes('雪夜来客'))
  assert.ok(first.includes('id: v01'))
  assert.ok(first.includes('total: {chapters: 2, words: 31, accepted: 1}'))
  rebuildIndex(novel)
  assert.equal(readFileSync(path.join(novel, 'index.yml'), 'utf8'), first)

  const empty = makeTmpRoot()
  const emptyNovel = path.join(empty, 'novel')
  mkdirSync(emptyNovel, { recursive: true })
  assertFails(() => rebuildIndex(emptyNovel), 404)
})

test('readChapter：返回 frontmatter 对象 + 正文；穿越 403；缺文件 404', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const chapter = readChapter(novel, 'v01-c001.md', { yamlLib: null })
  assert.equal(chapter.ok, true)
  assert.equal(chapter.file, 'v01-c001.md')
  assert.equal(chapter.frontmatter.title, '雪夜来客')
  assert.equal(chapter.frontmatter.status, 'accepted')
  assert.ok(chapter.body.startsWith('雪下了三天'))
  // outline（五期）：outlines/ 同 stem 章纲在位 → { file, words, body }
  assert.ok(chapter.outline, 'v01-c001 应带对应章纲')
  assert.equal(chapter.outline.file, 'v01-c001.md')
  assert.ok(chapter.outline.words > 0)
  assert.ok(chapter.outline.body.includes('章纲'), 'outline.body 应为章纲原文')

  // 无对应章纲的章 → outline 为 null（不告警，抽屉显示「暂无章纲」）
  const noOutline = readChapter(novel, 'v01-c002.md', { yamlLib: null })
  assert.equal(noOutline.outline, null)

  assertFails(() => readChapter(novel, '../project.yml', { yamlLib: null }), 403)
  assertFails(() => readChapter(novel, 'nope.md', { yamlLib: null }), 404)
})

test('readOutlineFile：章纲全文 { ok, file, words, body }；缺文件 404；非章纲文件名 422', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  // 孤儿章纲（chapters/ 无对应文件）同样可读——章纲弹层的主要取数路径
  const outline = readOutlineFile(novel, 'v01-c003.md')
  assert.deepEqual(Object.keys(outline).sort(), ['body', 'file', 'ok', 'words'])
  assert.equal(outline.ok, true)
  assert.equal(outline.file, 'v01-c003.md')
  assert.ok(outline.words > 0)
  assert.ok(outline.body.includes('冻河'))

  assertFails(() => readOutlineFile(novel, 'v01-c099.md'), 404, '章纲不存在')
  writeFileSync(path.join(novel, 'outlines', 'scratch.md'), '随手记，不合 vXX-cXXX 命名\n', 'utf8')
  assertFails(() => readOutlineFile(novel, 'scratch.md'), 422, '非章纲文件名')
  assertFails(() => readOutlineFile(novel, 'v01-c003.txt'), 422, '非章纲文件名')
  assertFails(() => readOutlineFile(novel, '../project.yml'), 403) // 穿越在 safeFileName 一刀切
})

test('readChapter：hash / outline.hash 等于各自文件原文 sha256（面板编辑保存的 base_hash 基线）', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const chapter = readChapter(novel, 'v01-c001.md', { yamlLib: null })
  assert.equal(chapter.hash, sha256Hex(readFileSync(path.join(novel, 'chapters', 'v01-c001.md'), 'utf8')))
  assert.equal(chapter.outline.hash, sha256Hex(readFileSync(path.join(novel, 'outlines', 'v01-c001.md'), 'utf8')))
})

test('mutateChapterBody：基线一致 → 围栏前逐字节保留、正文整段替换、返回写后新指纹', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'chapters', 'v01-c001.md')
  const before = readFileSync(target, 'utf8')
  // 闭合围栏行（含其换行）是「围栏前原文」的终点——正文刀口从这之后开始
  const fenceEnd = before.indexOf('\n---\n') + '\n---\n'.length
  const baseline = sha256Hex(before)

  const newBody = '全新正文第一段。\n\n全新正文第二段。'
  const res = mutateChapterBody(novel, 'v01-c001.md', newBody, { baseHash: baseline })
  const after = readFileSync(target, 'utf8')
  assert.equal(res.ok, true)
  assert.deepEqual(Object.keys(res), ['ok', 'hash'])
  assert.equal(after.slice(0, fenceEnd), before.slice(0, fenceEnd), 'frontmatter 围栏（含闭合行）应逐字节保留')
  assert.ok(after.endsWith('全新正文第二段。\n'), '正文应整段替换且末尾补换行')
  assert.ok(!after.includes('雪下了三天'), '旧正文不应残留')
  assert.equal(res.hash, sha256Hex(after), '返回 hash 应等于落盘原文指纹')

  // 回读：readChapter 看到新正文，hash 与返回值一致
  const reread = readChapter(novel, 'v01-c001.md', { yamlLib: null })
  assert.ok(reread.body.includes('全新正文第二段'))
  assert.equal(reread.hash, res.hash)

  // 基线接写后新指纹连存：不该被自家 409 拦住（假冲突）
  assert.equal(mutateChapterBody(novel, 'v01-c001.md', '二改正文。', { baseHash: res.hash }).ok, true)
})

test('mutateChapterBody：过期基线 409 不落盘；无围栏 422；body 非 string 422；缺省 baseHash 兼容', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'chapters', 'v01-c001.md')
  const before = readFileSync(target, 'utf8')
  const baseline = sha256Hex(before)

  // 模拟外部改动（状态流转）后旧基线过期：409 点名外部修改，全文逐字节未动
  mutateChapterStatus(novel, 'v01-c001.md', 'writing')
  const dirty = readFileSync(target, 'utf8')
  assert.notEqual(dirty, before)
  assertFails(() => mutateChapterBody(novel, 'v01-c001.md', '覆盖未遂', { baseHash: baseline }), 409, '外部修改')
  assert.equal(readFileSync(target, 'utf8'), dirty, '409 拒写不得落盘')

  // 无 frontmatter 围栏 → 422（先补齐再编辑）
  writeFileSync(target, '没有围栏的裸正文\n', 'utf8')
  assertFails(() => mutateChapterBody(novel, 'v01-c001.md', '正文'), 422, 'frontmatter 围栏')

  // body 非 string 422；章节不存在 404；穿越 403
  writeFileSync(target, before, 'utf8')
  assertFails(() => mutateChapterBody(novel, 'v01-c001.md', 42), 422, 'body')
  assertFails(() => mutateChapterBody(novel, 'nope.md', '正文'), 404)
  assertFails(() => mutateChapterBody(novel, '../project.yml', '正文'), 403)

  // 缺省 baseHash（旧调用方兼容）：跳过旧版检测直接写
  assert.deepEqual(Object.keys(mutateChapterBody(novel, 'v01-c001.md', '无基线正文')), ['ok', 'hash'])
  assert.ok(readFileSync(target, 'utf8').endsWith('无基线正文\n'))

  // 基线大小写宽容：大写 hex 归一后视为同值
  const upper = sha256Hex(readFileSync(target, 'utf8')).toUpperCase()
  assert.equal(mutateChapterBody(novel, 'v01-c001.md', '大写基线正文', { baseHash: upper }).ok, true)
})

test('mutateOutlineBody：整文件替换；文件名或 stem 皆可；过期基线 409；穿越/坏 stem 拒；不存在 404', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'outlines', 'v01-c001.md')
  const baseline = sha256Hex(readFileSync(target, 'utf8'))

  // 文件名形式（章节文件名 → 同 stem 章纲）
  const res = mutateOutlineBody(novel, 'v01-c001.md', '重写后的章纲。', { baseHash: baseline })
  assert.deepEqual(Object.keys(res), ['ok', 'hash'])
  assert.equal(readFileSync(target, 'utf8'), '重写后的章纲。\n', '整文件替换，旧内容不残留')
  assert.equal(res.hash, sha256Hex(readFileSync(target, 'utf8')), '返回 hash 应等于落盘原文指纹')

  // stem 形式也行（调用方手里是章节上下文，不强迫换算）
  assert.equal(mutateOutlineBody(novel, 'v01-c001', 'stem 形式也行。', { baseHash: res.hash }).ok, true)
  assert.ok(readFileSync(target, 'utf8').includes('stem 形式也行'))

  // 过期基线 409：全文逐字节未动
  const staleBase = sha256Hex(readFileSync(target, 'utf8'))
  writeFileSync(target, '外部改动\n', 'utf8')
  assertFails(() => mutateOutlineBody(novel, 'v01-c001.md', '覆盖未遂', { baseHash: staleBase }), 409, '外部修改')
  assert.equal(readFileSync(target, 'utf8'), '外部改动\n', '409 拒写不得落盘')

  // 校验面：穿越 403、空 stem 422、不合 vXX-cXXX 422、body 非 string 422、章纲不存在 404
  assertFails(() => mutateOutlineBody(novel, '../project.yml', 'x'), 403)
  assertFails(() => mutateOutlineBody(novel, '.md', 'x'), 422)
  assertFails(() => mutateOutlineBody(novel, 'scratch.md', 'x'), 422)
  assertFails(() => mutateOutlineBody(novel, 'v01-c001.md', 42), 422, 'body')
  assertFails(() => mutateOutlineBody(novel, 'v01-c099.md', 'x'), 404, '章纲不存在')
})

test('createChapterFromOutline：落盘 pending 空章（frontmatter 各键 + 标题「章纲」后缀剥离）；重复/非法拒', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  // 章纲标题带大纲师惯用的「章纲」后缀：建章时应剥离
  writeFileSync(path.join(novel, 'outlines', 'v01-c005.md'), '# 第 5 章 雪夜异客 章纲\n\n- 本章目标：冻河异客登场。\n', 'utf8')

  assert.deepEqual(createChapterFromOutline(novel, 'v01-c005.md'), { ok: true, file: 'v01-c005.md', title: '第 5 章 雪夜异客' })

  // 落盘内容：frontmatter 各键逐一对（回退解析，确定性），正文留空待写
  const chapter = readChapter(novel, 'v01-c005.md', { yamlLib: null })
  assert.equal(chapter.ok, true)
  assert.equal(chapter.frontmatter.volume, 'v01')
  assert.equal(chapter.frontmatter.num, 5)
  assert.equal(chapter.frontmatter.title, '第 5 章 雪夜异客')
  assert.equal(chapter.frontmatter.status, 'pending')
  assert.equal(chapter.frontmatter.summary, '')
  for (const k of FIVE_DIM_KEYS) assert.equal(chapter.frontmatter[k], '', `五维键 ${k} 应留空`)
  assert.equal(chapter.body.trim(), '', '正文应留空待写')
  // 快照联动：新章进 chapters 清单且 status=pending（建后走既有 pending 流转）
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  const created = snap.chapters.find((c) => c.file === 'v01-c005.md')
  assert.ok(created, '新章应进快照 chapters 清单')
  assert.equal(created.status, 'pending')

  // 已存在 409（先到先建，绝不覆盖既有正文——夹具既有的 v01-c001 同理）
  assertFails(() => createChapterFromOutline(novel, 'v01-c005.md'), 409, '章节已存在')
  assertFails(() => createChapterFromOutline(novel, 'v01-c001.md'), 409)
  // 章纲缺失 404；非章纲文件名 422
  assertFails(() => createChapterFromOutline(novel, 'v01-c099.md'), 404)
  assertFails(() => createChapterFromOutline(novel, 'scratch.md'), 422)
})

test('createChapterFromOutline：chapters/ 目录缺失时自动补建（测试夹具/手工项目兜底）', () => {
  const root = makeTmpRoot()
  const novel = path.join(root, 'novel')
  mkdirSync(path.join(novel, 'outlines'), { recursive: true })
  writeFileSync(path.join(novel, 'outlines', 'v02-c001.md'), '# 卷二开篇 章纲\n\n- 本章目标：新卷起手。\n', 'utf8')
  const res = createChapterFromOutline(novel, 'v02-c001.md')
  assert.equal(res.ok, true)
  assert.equal(res.title, '卷二开篇')
  assert.ok(existsSync(path.join(novel, 'chapters', 'v02-c001.md')), 'chapters/ 目录应自动补建')
  assert.ok(readFileSync(path.join(novel, 'chapters', 'v02-c001.md'), 'utf8').startsWith('---\n'), '落盘应为 frontmatter 围栏开头')
})

test('parseStateSnapshot：outlines/ 目录不存在 → 空数组且不告警（老项目兼容）', () => {
  const root = makeTmpRoot()
  const novel = path.join(root, 'novel')
  mkdirSync(novel, { recursive: true })
  writeFileSync(path.join(novel, 'project.yml'), 'title: 有章无纲\n', 'utf8')
  mkdirSync(path.join(novel, 'chapters'), { recursive: true })
  writeFileSync(path.join(novel, 'chapters', 'v01-c001.md'), `---
volume: v01
num: 1
title: 有章无纲
status: pending
---

正文。
`, 'utf8')
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  assert.deepEqual(snap.outlines, [])
  assert.ok(!snap.warnings.some((w) => w.includes('outlines')), `不应有 outlines 告警，实得 ${JSON.stringify(snap.warnings)}`)
})

test('parseStateSnapshot：outlines/ 里不合 vXX-cXXX 规范的散文件不列', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  writeFileSync(path.join(novel, 'outlines', 'scratch.md'), '随手记，不是章纲。\n', 'utf8')
  writeFileSync(path.join(novel, 'outlines', 'v01-c002.md'), '# 第二章 章纲\n\n- 本章目标：冻河尸语。\n', 'utf8')
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  // 散文件被跳过；合规范的照列且仍按卷-章号升序
  assert.deepEqual(snap.outlines.map((o) => o.file), ['v01-c001.md', 'v01-c002.md', 'v01-c003.md'])
  assert.equal(snap.outlines[1].chapter, 'v01-c002.md')
})

test('写操作与快照联动：状态流转后快照 totals 同步变化', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  mutateChapterStatus(novel, 'v01-c002.md', 'accepted')
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  assert.deepEqual(snap.totals.byStatus, { pending: 0, writing: 0, review: 0, accepted: 2 })
  mutateForeshadowStatus(novel, 'fs-001', 'resolved')
  assert.equal(parseStateSnapshot(novel, { yamlLib: null }).foreshadows[0].status, 'resolved')
})

test('PanelError 带 statusCode（路由层按它回状态码）', () => {
  const err = new PanelError(409, '冲突')
  assert.equal(err.statusCode, 409)
  assert.equal(err instanceof Error, true)
})

// ── 生产默认 yaml 真解析路径（staging 缺席优雅 skip，对照 composition.test.mjs）──

const YAML_STAGING = '/tmp/yamlcheck/node_modules/yaml'

test('生产默认路径：不传 options 时从 DSH_HOME 惰性借 yaml 包，readProject / parseFrontmatterMeta / collectArrayYml 走真解析', (t) => {
  if (!existsSync(YAML_STAGING)) return t.skip('本机没有 /tmp/yamlcheck 的 yaml 包（npm install --no-save --prefix /tmp/yamlcheck yaml@2 可补）')
  // 把 staging 的 yaml 包搬进 TEST_HOME/node_modules——yamlLibOf 的默认路径
  // （loadYamlLib(resolveDshHome())，DSH_HOME 已钉在 TEST_HOME）由此真命中
  // 主探针 <home>/node_modules，机制对照 test/installer-shape.test.mjs 的 yamlOf()。
  mkdirSync(path.join(TEST_HOME, 'node_modules'), { recursive: true })
  cpSync(YAML_STAGING, path.join(TEST_HOME, 'node_modules', 'yaml'), { recursive: true })
  const borrowed = loadYamlLib(TEST_HOME)
  assert.ok(borrowed && typeof borrowed.parse === 'function', 'loadYamlLib 应能从 TEST_HOME 借到 yaml 包')

  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  // 关键：不传 options（不显式给 yamlLib）——走生产默认借包路径，而非回退。
  const snap = parseStateSnapshot(novel)

  // readProject 真分支：8 键契约（含五期 mode），值来自真解析
  assert.deepEqual(Object.keys(snap.project), ['title', 'author', 'genre', 'length', 'language', 'phase', 'mode', 'description'])
  assert.equal(snap.project.mode, 'ai-draft')
  assert.equal(snap.project.title, '雪葬长夜')

  // parseFrontmatterMeta 真分支：age 真数字、markers 真数组（[] 形状也认）
  const lin = snap.characters.find((c) => c.file === 'lin-waner.md')
  assert.equal(lin.age, 19)
  assert.deepEqual(lin.markers, ['紧张时摩挲袖口', '说话前先抿嘴'])
  assert.deepEqual(snap.characters.find((c) => c.file === 'shen-mo.md').markers, [])

  // collectArrayYml 真分支：relations 条目为真映射；裸标量坏条目照旧跳过记警告
  assert.equal(snap.relations.length, 1)
  assert.equal(snap.relations[0].intensity, 4)
  assert.equal(snap.relations[0].ended, '')
  assert.ok(snap.warnings.some((w) => w.includes('foreshadows.yml')), '真解析下裸标量条目也应记警告')

  // 差异断言（证明真分支确实在跑）：流式映射值真 yaml 解析为对象 → strOrNull 归
  // null；回退解析器不认流式形态，会给出原样字符串——两者结果可区分。
  const root2 = makeTmpRoot()
  mkdirSync(path.join(root2, 'novel'), { recursive: true })
  writeFileSync(path.join(root2, 'novel', 'project.yml'), 'title: 差异断言\ndescription: {nested: 数据规范禁深嵌套}\n', 'utf8')
  assert.equal(parseStateSnapshot(path.join(root2, 'novel')).project.description, null)
})

// ── 受管文件写面（0.1.20「全量可编辑写面」）：白名单 / 结构校验 / 读存建删 ──────

test('managedRelCheck：白名单矩阵——六个账本 yml、四个 md 目录 slug、outlines 章纲、chapters 仅删', () => {
  // 允许形态与 kind 归类
  assert.deepEqual(managedRelCheck('relations.yml', 'save'), { dir: '', name: 'relations.yml', kind: 'yml' })
  assert.deepEqual(managedRelCheck('clue-board.yml', 'read'), { dir: '', name: 'clue-board.yml', kind: 'yml' })
  assert.deepEqual(managedRelCheck('volumes.yml', 'save'), { dir: '', name: 'volumes.yml', kind: 'yml' })
  assert.deepEqual(managedRelCheck('characters/lin-waner.md', 'read'), { dir: 'characters', name: 'lin-waner.md', kind: 'md' })
  assert.deepEqual(managedRelCheck('world/new-place.md', 'create'), { dir: 'world', name: 'new-place.md', kind: 'md' })
  assert.deepEqual(managedRelCheck('science/lab-note.md', 'save'), { dir: 'science', name: 'lab-note.md', kind: 'md' })
  assert.deepEqual(managedRelCheck('research/deep-dive.md', 'delete'), { dir: 'research', name: 'deep-dive.md', kind: 'md' })
  assert.deepEqual(managedRelCheck('outlines/v01-c001.md', 'save'), { dir: 'outlines', name: 'v01-c001.md', kind: 'outline' })
  assert.deepEqual(managedRelCheck('chapters/v01-c001.md', 'delete'), { dir: 'chapters', name: 'v01-c001.md', kind: 'chapter' })
})

test('managedRelCheck：白名单外与形状违规逐一拒（403/422 分明，形状先于白名单）', () => {
  // chapters 只删：save / read / create 全 403（正文读写各有专用路由）
  assertFails(() => managedRelCheck('chapters/v01-c001.md', 'save'), 403, '只开放删除')
  assertFails(() => managedRelCheck('chapters/v01-c001.md', 'read'), 403, '只开放删除')
  assertFails(() => managedRelCheck('chapters/v01-c001.md', 'create'), 403, '只开放删除')
  // 有意排除的核心配置（面板永不直改）
  assertFails(() => managedRelCheck('index.yml', 'save'), 403, '白名单')
  assertFails(() => managedRelCheck('project.yml', 'save'), 403, '白名单')
  assertFails(() => managedRelCheck('Big.md', 'save'), 403, '白名单')
  // 穿越 / 绝对路径 / 反斜杠 / 深层嵌套
  assertFails(() => managedRelCheck('../project.yml', 'save'), 403, '白名单')
  assertFails(() => managedRelCheck('/etc/hosts', 'save'), 403, '')
  assertFails(() => managedRelCheck('a/b/c.yml', 'save'), 403, '一层深度')
  assertFails(() => managedRelCheck('characters\\x.md', 'save'), 403, '反斜杠')
  // 形状 422：空 rel / slug 不合 / 非章纲 stem / 非 vXX-cXXX 章节
  assertFails(() => managedRelCheck('', 'save'), 422, '缺少 rel')
  assertFails(() => managedRelCheck('characters/Bad_Slug.md', 'save'), 422, 'slug')
  assertFails(() => managedRelCheck('characters/new', 'create'), 422, 'slug')
  assertFails(() => managedRelCheck('outlines/scratch.md', 'save'), 422, 'vXX-cXXX')
  assertFails(() => managedRelCheck('chapters/extra.md', 'delete'), 422, 'vXX-cXXX')  // chapterSortKey 宽容位宽（v01-c1 也认），非章号才拒
})

test('validateManagedText：账本 yml 数组口径（回退与真解析同判）+ md 围栏 + outlines 跳过', (t) => {
  const good = '- id: r1\n  from: 林晚\n  to: 沈默\n'
  // 回退口径（yamlLib=null，确定性主路）
  validateManagedText('relations.yml', good, null)
  validateManagedText('relations.yml', '', null) // 空文件按空表放行（与快照同宽容）
  validateManagedText('relations.yml', '[]', null) // flow 空数组放行
  assertFails(() => validateManagedText('relations.yml', 'title: 不是数组', null), 422, '顶层不是数组')
  // 快照会静默丢弃的条目形态：裸标量 / null / 数组条 / 空对象条——存时一并 422
  assertFails(() => validateManagedText('foreshadows.yml', '- 顺手记的一笔', null), 422, '快照会静默丢弃')
  assertFails(() => validateManagedText('foreshadows.yml', '- null', null), 422, '快照会静默丢弃')
  assertFails(() => validateManagedText('foreshadows.yml', '- []', null), 422, '快照会静默丢弃')
  assertFails(() => validateManagedText('foreshadows.yml', '- {}', null), 422, '快照会静默丢弃')
  // md 实体卡：围栏成对即放行（语义全不问），缺围栏 422
  validateManagedText('characters/new.md', '---\nname: 新人\nrole: supporting\n---\n\n正文。\n', null)
  assertFails(() => validateManagedText('characters/new.md', '没有围栏的文本', null), 422, 'frontmatter')
  // outlines：纯 markdown 无围栏也放行（章纲不是实体卡）
  validateManagedText('outlines/v01-c001.md', '# 章纲\n\n- 本章目标\n', null)
  // 真解析路径（借得到 yaml 包才跑）：两条解析路必须同一结论
  const yamlLib = loadYamlLib(TEST_HOME)
  if (yamlLib) {
    validateManagedText('relations.yml', good, yamlLib)
    assertFails(() => validateManagedText('relations.yml', 'title: 不是数组', yamlLib), 422, '顶层不是数组')
    assertFails(() => validateManagedText('foreshadows.yml', '- 顺手记的一笔', yamlLib), 422, '快照会静默丢弃')
  } else {
    t.log('本机无可借的 yaml 包，真解析分支未覆盖')
  }
})

test('readManagedFile：返回原文+指纹（hash=原文 sha256），缺文件 404', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const got = readManagedFile(novel, 'relations.yml')
  const raw = readFileSync(path.join(novel, 'relations.yml'), 'utf8')
  assert.deepEqual(Object.keys(got), ['ok', 'rel', 'text', 'hash'])
  assert.equal(got.text, raw)
  assert.equal(got.hash, sha256Hex(raw))
  assertFails(() => readManagedFile(novel, 'characters/ghost.md'), 404, '不存在')
})

test('saveManagedFile：落盘带尾换行 + 返回写后指纹；过期基线 409 逐字节不动；缺失 404；坏文本 422', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const target = path.join(novel, 'relations.yml')
  // 不带 base_hash（缺省跳过基线检查，同 style-save 口径）
  const clean = '- id: r1\n  from: 林晚\n  to: 沈默\n  kind: ally\n  intensity: 4\n'
  const result = saveManagedFile(novel, 'relations.yml', clean, {})
  assert.equal(result.ok, true)
  assert.equal(result.rel, 'relations.yml')
  assert.equal(readFileSync(target, 'utf8'), clean, '原文已带尾换行，应逐字节一致')
  assert.equal(result.hash, sha256Hex(clean))

  // 无尾换行补一个 \n（POSIX 文本惯例），指纹按补后的全文算
  const noEol = '- id: r2\n  from: A\n  to: B'
  const r2 = saveManagedFile(novel, 'relations.yml', noEol, {})
  assert.equal(readFileSync(target, 'utf8'), `${noEol}\n`)
  assert.equal(r2.hash, sha256Hex(`${noEol}\n`))

  // base_hash 过期 → 409 拒写，磁盘逐字节不动（文案与 project-save 同口径）
  const fresh = readFileSync(target, 'utf8')
  assertFails(() => saveManagedFile(novel, 'relations.yml', '- id: x\n  a: b\n', { baseHash: 'deadbeef' }), 409, '外部修改')
  assert.equal(readFileSync(target, 'utf8'), fresh)

  // 缺失 404（新建走 file-create）；类型/结构 422（校验先于基线检查）
  assertFails(() => saveManagedFile(novel, 'characters/nope.md', '---\nname: x\n---\n', {}), 404, '不存在')
  assertFails(() => saveManagedFile(novel, 'relations.yml', 42, {}), 422, '字符串')
  assertFails(() => saveManagedFile(novel, 'relations.yml', 'title: x', {}), 422, '顶层不是数组')
  assertFails(() => saveManagedFile(novel, 'characters/lin-waner.md', 'x', {}), 422, 'frontmatter')
})

test('createManagedFile：新 slug 落盘 + 返回指纹；已存在 409 不覆盖；形状坏 422', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const tpl = '---\nname: 新角\nrole: supporting\n---\n\n'
  const made = createManagedFile(novel, 'characters/new-girl.md', tpl)
  assert.equal(made.ok, true)
  assert.equal(readFileSync(path.join(novel, 'characters', 'new-girl.md'), 'utf8'), tpl)
  assert.equal(made.hash, sha256Hex(tpl))
  // 已存在 → 409（先到先建，绝不覆盖），原文件逐字节不动
  const before = readFileSync(path.join(novel, 'characters', 'lin-waner.md'), 'utf8')
  assertFails(() => createManagedFile(novel, 'characters/lin-waner.md', tpl), 409, '已存在')
  assert.equal(readFileSync(path.join(novel, 'characters', 'lin-waner.md'), 'utf8'), before)
  // slug 不合规 422；账本 yml 结构坏 422
  assertFails(() => createManagedFile(novel, 'characters/Bad.md', tpl), 422, 'slug')
  // 结构 422 走在 existsSync 之后：新 rel（不存在）+ 坏结构才探得到这道门
  assertFails(() => createManagedFile(novel, 'world/bad-card.md', '没有围栏', {}), 422, 'frontmatter')
})

test('deleteManagedFile：删章节与删实体卡落盘；重复删 404', () => {
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const chPath = path.join(novel, 'chapters', 'v01-c002.md')
  assert.deepEqual(deleteManagedFile(novel, 'chapters/v01-c002.md'), { ok: true, rel: 'chapters/v01-c002.md' })
  assert.equal(existsSync(chPath), false)
  assertFails(() => deleteManagedFile(novel, 'chapters/v01-c002.md'), 404, '不存在')
  // 实体卡同路：先建后删（create + delete 闭环）
  createManagedFile(novel, 'research/temp-note.md', '---\nlabel: known\n---\n\n')
  assert.equal(deleteManagedFile(novel, 'research/temp-note.md').ok, true)
  assert.equal(existsSync(path.join(novel, 'research', 'temp-note.md')), false)
})
