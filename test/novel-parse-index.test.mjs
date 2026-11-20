/**
 * novel-parse 单测：index 派生文件组（导航 index.yml + index/ 卷片）。
 *
 * buildIndexYaml 是确定性纯函数，直接喂章节与卷表数据断言 files 集合与全文
 * 快照：多卷 + orphans + 空卷、无卷空态、title 非 string 置空串、逐字节确定性；
 * pruneStaleIndexShards 断言 stale 卷片清理只删期望文件集之外的 *.yml。
 * 不落盘（除 prune 用例），不碰 fixtures.mjs 的样例项目。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildIndexYaml, pruneStaleIndexShards } from '../lib/novel-parse.mjs'

/** 章节对象按 collectChapters 产出的字段形状收窄（本组函数只认这几个键）。 */
function mkChapter(stem, volume, num, title, status, words, summary) {
  return { stem, volume, num, title, status, words, summary }
}

test('buildIndexYaml：多卷 + orphans + 空卷 → files 集合与全文快照', () => {
  const chapters = [
    mkChapter('v01-c001', 'v01', 1, '雪夜来客', 'accepted', 3200, '一句话梗概'),
    mkChapter('v01-c002', 'v01', 2, '冻河尸语', 'writing', 1800, '一句话梗概二'),
    mkChapter('v09-c005', 'v09', 5, '无主之地', 'pending', 900, '未归卷'),
  ]
  const volumesRaw = [
    { id: 'v01', title: '初入江湖', summary: '卷定位一句话（不进导航）' },
    { id: 'v02', title: '塞北风云' }, // 空卷：0 章
  ]

  const { files, volumesCount, chaptersCount, orphansCount, totalWords } = buildIndexYaml(chapters, volumesRaw)

  // 文件集合：导航 + 每卷一片 + orphans 卷片（rel 相对 novel/ 根）
  assert.deepEqual(
    files.map((f) => f.rel),
    ['index.yml', 'index/v01.yml', 'index/v02.yml', 'index/orphans.yml'],
  )
  assert.deepEqual({ volumesCount, chaptersCount, orphansCount, totalWords }, { volumesCount: 2, chaptersCount: 3, orphansCount: 1, totalWords: 5900 })

  // 导航全文快照：每卷一行 flow mapping 汇总；卷 summary 不进导航
  assert.equal(
    files[0].text,
    [
      '# index.yml —— 派生导航文件，可由 lore 角色或 `maoying index` 重建；手工改动会被覆盖。',
      '# 每卷一行汇总；章级明细（题/状态/字数/一句话梗概）在 index/<卷id>.yml 卷片，未归卷章节在 index/orphans.yml；写到哪卷读哪片，不整读。',
      'volumes:',
      '  - {id: v01, title: 初入江湖, chapters: 2, words: 5000, accepted: 1}',
      '  - {id: v02, title: 塞北风云, chapters: 0, words: 0, accepted: 0}',
      'orphans: {chapters: 1, words: 900}',
      'total: {chapters: 3, words: 5900, accepted: 1}',
      '',
    ].join('\n'),
  )
  assert.ok(!files[0].text.includes('卷定位一句话'), '卷 summary 不应重复进导航')

  // v01 卷片：章节行同字段同顺序同转义（volume/num/title/status/words/summary）
  assert.equal(
    files[1].text,
    [
      '# index/v01.yml —— 派生卷片（全书导航见 index.yml）；由 `maoying index` 或 lore 角色重建；手工改动会被覆盖。',
      'volume: {id: v01, title: 初入江湖}',
      'chapters:',
      '  - {volume: v01, num: 1, title: 雪夜来客, status: accepted, words: 3200, summary: 一句话梗概}',
      '  - {volume: v01, num: 2, title: 冻河尸语, status: writing, words: 1800, summary: 一句话梗概二}',
      '',
    ].join('\n'),
  )

  // 空卷卷片：chapters: 下 []
  assert.equal(
    files[2].text,
    [
      '# index/v02.yml —— 派生卷片（全书导航见 index.yml）；由 `maoying index` 或 lore 角色重建；手工改动会被覆盖。',
      'volume: {id: v02, title: 塞北风云}',
      'chapters:',
      '  []',
      '',
    ].join('\n'),
  )

  // orphans 卷片：未归卷章节（带 volume 键）
  assert.equal(
    files[3].text,
    [
      '# index/orphans.yml —— 派生卷片：未归卷章节；由 `maoying index` 或 lore 角色重建；手工改动会被覆盖。',
      'chapters:',
      '  - {volume: v09, num: 5, title: 无主之地, status: pending, words: 900, summary: 未归卷}',
      '',
    ].join('\n'),
  )
})

test('buildIndexYaml：无卷空态（volumesRaw null）→ volumes: []，全部章节进 orphans 卷片', () => {
  const chapters = [
    mkChapter('v01-c001', 'v01', 1, '雪夜来客', 'accepted', 3200, '一句话梗概'),
  ]
  const { files, volumesCount, chaptersCount, orphansCount } = buildIndexYaml(chapters, null)
  assert.deepEqual(files.map((f) => f.rel), ['index.yml', 'index/orphans.yml'])
  assert.deepEqual({ volumesCount, chaptersCount, orphansCount }, { volumesCount: 0, chaptersCount: 1, orphansCount: 1 })
  assert.ok(files[0].text.includes('volumes:\n  []\n'), '无卷时 volumes: 下空数组占位')
  assert.ok(files[1].text.includes('  - {volume: v01, num: 1, title: 雪夜来客, status: accepted, words: 3200, summary: 一句话梗概}'))

  // 空项目：零章节零卷，orphans 卷片仍恒产出
  const empty = buildIndexYaml([], [])
  assert.deepEqual(empty.files.map((f) => f.rel), ['index.yml', 'index/orphans.yml'])
  assert.deepEqual({ chaptersCount: empty.chaptersCount, orphansCount: empty.orphansCount, totalWords: empty.totalWords }, { chaptersCount: 0, orphansCount: 0, totalWords: 0 })
  assert.ok(empty.files[0].text.includes('volumes:\n  []\n'))
  assert.ok(empty.files[0].text.includes('total: {chapters: 0, words: 0, accepted: 0}'))
  assert.ok(empty.files[1].text.includes('chapters:\n  []\n'))
})

test('buildIndexYaml：title 非 string 置空串；确定性（同输入两次调用逐字节相同）', () => {
  const chapters = [mkChapter('v01-c001', 'v01', 1, '雪夜来客', 'accepted', 3200, '一句话梗概')]
  const volumesRaw = [{ id: 'v01', title: 42 }] // 非 string title → ""
  const first = buildIndexYaml(chapters, volumesRaw)
  assert.ok(first.files[0].text.includes('- {id: v01, title: "", chapters: 1, words: 3200, accepted: 1}'))
  assert.ok(first.files[1].text.includes('volume: {id: v01, title: ""}'))
  const second = buildIndexYaml(chapters, volumesRaw)
  assert.deepEqual(second, first, '同输入两次重建应得到逐字节相同的全部产物')
})

test('pruneStaleIndexShards：只删期望文件集之外的 *.yml，目录与非 yml 不动', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'maoying-prune-'))
  try {
    const indexDir = path.join(root, 'index')
    mkdirSync(path.join(indexDir, 'dir.yml'), { recursive: true }) // 目录冒充 *.yml：跳过不删
    writeFileSync(path.join(indexDir, 'v99.yml'), '# 旧卷片\n', 'utf8')
    writeFileSync(path.join(indexDir, 'keep.yml'), '# 期望文件\n', 'utf8')
    writeFileSync(path.join(indexDir, 'notes.txt'), '非 yml 不动\n', 'utf8')

    pruneStaleIndexShards(root, ['index/keep.yml', 'index/orphans.yml'])

    assert.equal(readFileSync(path.join(indexDir, 'keep.yml'), 'utf8'), '# 期望文件\n')
    assert.equal(readFileSync(path.join(indexDir, 'notes.txt'), 'utf8'), '非 yml 不动\n')
    assert.equal(existsSync(path.join(indexDir, 'v99.yml')), false, 'stale 卷片应被删除')
    assert.equal(existsSync(path.join(indexDir, 'dir.yml')), true, '目录冒充 *.yml 不应被 unlink')
    // index/ 不存在（从未重建过）：空操作不炸
    assert.equal(pruneStaleIndexShards(path.join(root, 'no-such'), []).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
