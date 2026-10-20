/**
 * panel-core 单测：快照契约字段逐一断言 + 写操作三件套（正常流转 / 非法值拒 /
 * 替换计数 ≠1 拒 409）+ 路径穿越拒 403。全部跑在 /tmp 临时工作区上。
 *
 * 解析走两条路都断言：yamlLib 显式置 null（极简回退，确定性）为主；
 * 若本机 loadYamlLib 能借到 yaml 包，再加一轮真解析抽查（数组字段是真数组）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 测试全程把 DSH_HOME 钉在一次性临时目录——parseStateSnapshot 默认路径
// （loadYamlLib(resolveDshHome())）绝不落到真实 ~/.dsh 上。
import { makeTmpRoot } from './fixtures.mjs'

const TEST_HOME = makeTmpRoot('maoying-home-')
process.env.DSH_HOME = TEST_HOME

const {
  listWorkspaces,
  parseStateSnapshot,
  readChapter,
  resolveNovelRoot,
  mutateChapterStatus,
  mutateForeshadowStatus,
  mutatePhase,
  rebuildIndex,
  PanelError,
} = await import('../lib/panel-core.mjs')
const { loadYamlLib } = await import('../lib/yaml-loader.mjs')
const { buildSampleNovel, makeRegistry } = await import('./fixtures.mjs')

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
  assert.deepEqual(Object.keys(snap.project).sort(), ['author', 'description', 'genre', 'language', 'length', 'phase', 'title'])
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

  // relations
  assert.equal(snap.relations.length, 1)
  assert.deepEqual(snap.relations[0], {
    a: 'lin-waner', b: 'shen-mo', type: '宿敌',
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

test('parseStateSnapshot：未初始化（无 project.yml）found=false 其余缺省', () => {
  const root = makeTmpRoot()
  const novel = path.join(root, 'novel')
  mkdirSync(novel, { recursive: true })
  const snap = parseStateSnapshot(novel, { yamlLib: null })
  assert.deepEqual(snap, { ok: true, root: path.resolve(root), novelDir: path.resolve(novel), found: false, warnings: [] })
})

test('parseStateSnapshot：yaml 包可用时真解析（条件执行，本机借不到就跳过）', () => {
  const yamlLib = loadYamlLib(TEST_HOME)
  if (!yamlLib) {
    test.skip('本机无可借的 yaml 包')
    return
  }
  const root = makeTmpRoot()
  const novel = buildSampleNovel(root)
  const snap = parseStateSnapshot(novel, { yamlLib })
  const lin = snap.characters.find((c) => c.file === 'lin-waner.md')
  assert.deepEqual(lin.markers, ['紧张时摩挲袖口', '说话前先抿嘴'])
  assert.equal(lin.age, 19)
  assert.equal(snap.totals.words, 31)
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
