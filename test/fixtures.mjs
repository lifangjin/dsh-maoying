/**
 * 测试夹具：临时工作区 + 样例 novel/ 项目 + 假 ctx 假件。
 *
 * 全部落 /tmp（mkdtemp），不碰真实 ~/.dsh；零测试依赖，node:test 直接吃。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 建一个一次性临时根目录。 */
export function makeTmpRoot(prefix = 'maoying-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 递归建目录后写文本文件。 */
function put(base, rel, text) {
  const target = path.join(base, rel)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
}

/**
 * 在 root 下造一套完整样例 novel/（覆盖全部实体类型 + 两类故意坏文件：
 * characters/broken.md 是冒充 md 的目录——读取必炸，验证 warnings 不炸快照；
 * foreshadows.yml 首条是裸标量条目——验证坏条目跳过并记警告）。
 * 另有 fs-003 故意不带 status 行，供「替换计数为 0 → 409」用例。
 * 返回 novel 目录。
 */
export function buildSampleNovel(root) {
  const novel = path.join(root, 'novel')

  put(novel, 'project.yml', `# project.yml 测试样例
title: 雪葬长夜
author: 试笔人
genre: 东方玄幻
length: 约100万字
language: zh
phase: writing             # 七阶段：idea|setting|outline|writing|review|consistency|export
description: 北境雪灾后的长生局。
`)

  put(novel, 'volumes.yml', `- id: v01
  title: 第一卷 北境风雪
  summary: 雪灾揭幕，玉佩现世。
  chapters: 001-002
`)

  put(novel, 'chapters/v01-c001.md', `---
volume: v01
num: 1
title: 雪夜来客
status: accepted
summary: 当铺夜客以半块玉佩抵债，主角看出端倪。
cognitive_frame: 读者与主角同步发现玉佩缺口暗合族徽
emotional_anchor: 寒夜孤灯下的戒备与好奇
world_texture: 北境当铺的规矩与冻河夜景
suspense: 玉佩为何避开了掌柜的验看
interpersonal_tension: 主角与掌柜互相试探
---

雪下了三天，长夜镇的灯火压在雪壳下面……
`)

  put(novel, 'chapters/v01-c002.md', `---
volume: v01
num: 2
title: 冻河尸语
status: writing
summary: 冻河之下浮出第二块玉佩。
cognitive_frame: 读者先于主角确认玉佩成对
emotional_anchor: 目击者的恐惧
world_texture: 凿冰取水的水户行当
suspense: 尸体的口中有线头
interpersonal_tension: 水户与主角的同乡关系被利用
---

冻河在夜里发出骨头相碰的声响……
`)

  put(novel, 'characters/lin-waner.md', `---
name: 林晚儿
age: 19
gender: 女
role: supporting
appearance: 眉眼冷淡，袖口磨得发白
personality: 谨慎，记账式待人
background: 当铺孤女，识得古物
motivation: 赎回祖屋
arc: 从旁观者到执棋人
markers:
  - 紧张时摩挲袖口
  - 说话前先抿嘴
---

当铺掌柜的远房侄女。
`)

  put(novel, 'characters/shen-mo.md', `---
name: 沈默
age: 34
gender: 男
role: antagonist
appearance: 面白无须，指节有茧
personality: 不动声色
motivation: 收齐玉佩
markers: []
---

来历不明的当铺常客。
`)

  // 故意坏文件：目录冒充 md 文件，readFileSync 必抛 EISDIR
  mkdirSync(path.join(novel, 'characters', 'broken.md'), { recursive: true })

  put(novel, 'relations.yml', `- a: lin-waner
  b: shen-mo
  type: 宿敌
  description: 当铺交锋结下的梁子
  intensity: 4
  started: v01-c003
  ended: ""
`)

  put(novel, 'foreshadows.yml', `- 顺手记的一笔
- id: fs-001
  title: 老者留下的半块玉佩
  status: planted
  priority: high
  planted_chapter: v01-c001
  expected_resolve: v01-c020
  resolved_chapter: ""
  notes: 玉佩成对，另一块在冻河下
- id: fs-002
  title: 掌柜的旧账本
  status: progressing
  priority: normal
  planted_chapter: v01-c002
  expected_resolve: v01-c030
  resolved_chapter: ""
  notes: 账本缺页
- id: fs-003
  title: 没写状态的伏笔
  priority: low
  planted_chapter: v01-c002
`)

  put(novel, 'timeline.yml', `- year: 玄历三年冬
  title: 北境雪灾
  description: 三日大雪封镇
  importance: 4
  chapter: v01-c001
`)

  put(novel, 'memories.yml', `- category: appearance
  content: 林晚儿于 v01-c003 首次登场
  source_chapter: v01-c003
`)

  put(novel, 'clue-board.yml', `- kind: clue
  content: 当铺掌柜认得玉佩却装作不识
  related_chapter: v01-c003
  resolved: false
`)

  put(novel, 'world/north-realm.md', `---
category: 地点
tags:
  - 北境
  - 长夜镇
---

长夜镇：北境边陲的小镇，一年封冻八个月。
`)

  put(novel, 'science/spirit-freezing.md', `---
label: extrapolation
references:
  - known:灵气密度与纬度
---

灵气遇寒则凝，冻河底部灵脉最盛。
`)

  put(novel, 'research/bei-jing-feng-su.md', `---
topic: 北境封冻期风物考
sources:
  - https://example.com/fengsu
---

封冻八个月的镇子靠凿冰取水。
`)

  return novel
}

/** 假 workspaceRegistry：list() 返回给定根（带 title）。 */
export function makeRegistry(roots) {
  return {
    list: () => roots.map((p) => ({ id: path.basename(p), path: p, title: path.basename(p) })),
  }
}

/**
 * 假 cordis ctx：webServer.register 只收集路由（返回空 disposer）；
 * ctx.get('webRuntime') 默认返回 null（非 web 部署形态）。
 */
export function makeFakeCtx({ registry, webRuntime = null } = {}) {
  const routes = []
  const warns = []
  const ctx = {
    logger: {
      info() {},
      warn(...args) {
        warns.push(args.map(String).join(' '))
      },
      error() {},
    },
    workspaceRegistry: registry,
    get(key) {
      return key === 'webRuntime' ? webRuntime : undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, warns }
}
