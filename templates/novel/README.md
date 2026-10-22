# novel/ 数据规范速查

本目录是一部网文项目的全部状态：结构化 markdown/YAML 文件就是数据库。查「所有未回收伏笔」就是 grep foreshadows.yml——不需要数据库，不需要 API 层；人可以直接改文件，git 可以版本化。主编（agent）开工先读 project.yml 与 index.yml 掌握全局；不确定格式就读本文件。

## 总原则

- **所有 yml 顶层是数组或平键，禁止深嵌套**——grep 友好，一眼可查、一处一行。
- **index.yml 是派生文件**：由 lore 角色或 `maoying index` 重建，手工改动会被覆盖；不要在它上面记东西。
- 章节、角色卡等 md 文件用 `---` 围栏包 frontmatter，键值一行一个（简单标量），正文写在第二个 `---` 之后（body）。
- 枚举值一律用下列全称，不要自造缩写：
  - 章节状态 `status`：`pending`（待写）→ `writing`（写作中）→ `review`（审阅中）→ `accepted`（已定稿）
  - 伏笔状态 `status`：`planted`（埋设）→ `progressing`（推进）→ `resolved`（回收）；弃用走 `abandoned`
  - 阶段 `phase`（七态）：`idea` `setting` `outline` `writing` `review` `consistency` `export`
  - 角色 `role`：`protagonist`（主角）`antagonist`（反派）`supporting`（重要配角）`minor`（龙套）
  - 考据 `label`：`known`（史实/公理）`extrapolation`（合理推演）`hypothesis`（自设假说）
  - 记忆 `category`：`character` `location` `item` `event` `promise` `appearance` `other`
  - 线索 `kind`：`clue`（线索）`red-herring`（误导）`deduction`（推理）`question`（悬问）
- 章节文件名 `v<卷号2位>-c<章号3位>.md`（如 `v01-c001.md`）；frontmatter 里的 `volume`/`num` 与文件名保持一致。
- 角色/世界观/考据文件用小写英文短横线 slug 命名（如 `lin-waner.md`）；其他文件引用角色时用同一个 slug。

## project.yml

书稿元信息，平键。`phase` 是七阶段工作流的状态机指针，每完成一个里程碑由主编推进（setting→outline 须核心角色卡与世界观核心条目落盘；outline→writing 须 volumes.yml 与目标章大纲在案）；`mode` 决定正文归谁写。

```yaml
title: 未命名书稿      # 书名
author: ""            # 作者笔名
genre: 东方玄幻        # 题材
length: 约100万字      # 预期篇幅
language: zh          # 正文语言
phase: idea           # 七阶段：idea|setting|outline|writing|review|consistency|export
mode: ai-draft        # 共创模式：ai-draft（AI 代笔，默认）| co-write（逐章指派谁写）| author-draft（全书作者亲笔）
description: 一句话简介
```

`mode` 三值：`ai-draft`（默认）AI 代笔，走 Writing 六步法；`co-write` 逐章指派谁写，章节 frontmatter 可记 `writer: author | ai`；`author-draft` 全书作者亲笔，主编只备料、审稿、记账，`chapters/` 正文唯作者可改。缺省（含旧项目无此键）按 `ai-draft`。

## volumes.yml

分卷规划，顶层数组，每卷一条。`id` 与章节文件名前缀一致；由大纲师维护。

```yaml
- id: v01             # 卷号（chapters/v01-cXXX.md 的前缀）
  title: 第一卷 北境风雪
  summary: 本卷主线与卷末大高潮的一句话定位
  chapters: 001-020   # 章节号范围
```

## chapters/vXX-cXXX.md

章节文件。frontmatter 记大纲与状态，body 是正文；五维叙事字段是大纲的核心，每项 1-3 句、具体到本章。

```markdown
---
volume: v01
num: 1
title: 雪夜来客
status: pending          # pending|writing|review|accepted
summary: 一句话梗概（index.yml 与 stats 直接引用）
cognitive_frame: 本章读者的认知被如何推动（信息差/误解/顿悟点）
emotional_anchor: 本章要锚定的情绪与共情对象
world_texture: 本章着墨的世界细节层面（风物/规矩/器物）
suspense: 章尾钩子与本章悬念的问题化表述
interpersonal_tension: 本章人物关系中的压力与变化
---

正文……
```

## outlines/vXX-cXXX.md

章纲：共创模式（co-write / author-draft）下大纲师写给作者的创作输入，与章节文件一一对应（`outlines/v01-c005.md` ↔ `chapters/v01-c005.md`）。纯 markdown、无 frontmatter——作者在任意编辑器打开就要能看。五件内容写全：

```markdown
# 第 5 章 雪夜来客

- 本章目标：……（这章要完成什么叙事任务）
- 节拍：……（场景推进顺序与情绪起伏）
- 出场角色：……（谁上场、各带什么目的）
- 需埋/需收伏笔：……（对照 foreshadows.yml 报 id）
- 与前章接口：……（从哪个钩子接、结尾钩到哪）
```

颗粒度标准：作者拿着就能动笔。章纲是计划不是章节事实，不入 index.yml；大纲师写、作者读、review 收稿时对照评偏离——作者没照章纲写不算错，账本永远跟正文走。

## characters/<slug>.md

角色卡。`markers` 是角色的辨识性口癖/习惯清单（审校盯人设用）；body 写备注。

```markdown
---
name: 林晚儿
age: 19
gender: 女
role: supporting         # protagonist|antagonist|supporting|minor
appearance: 外貌一句话
personality: 性格两三个关键词 + 一句展开
background: 出身与关键经历
motivation: 行动动机
arc: 全书成长弧线（从什么到什么）
markers:                 # 辨识标记，一行一个
  - 紧张时摩挲袖口
---

备注……
```

## world/<slug>.md

世界观条目。`category` 用中文四类：`地点` `组织` `概念` `事件`；body 是描述。

```markdown
---
category: 地点            # 地点|组织|概念|事件
tags:                     # 检索标签，一行一个
  - 北境
---

描述……
```

## science/<slug>.md

科学/超凡设定，三色标注可信度，防止后期写崩。body 是设定正文。

```markdown
---
label: extrapolation      # known（史实/公理）|extrapolation（合理推演）|hypothesis（自设假说）
references:               # 依据来源，一行一个（已知设定 id 或现实出处）
  - known:灵气密度与纬度
---

设定正文……
```

## relations.yml

人物关系，顶层数组，每条关系一条。`a`/`b` 用角色 slug。

```yaml
- a: lin-waner            # 角色卡 slug
  b: shen-mo
  type: 宿敌              # 关系类型（师徒/宿敌/恋人/同门……自定）
  description: 一句话说明这段关系的张力所在
  intensity: 4            # 关系强度 1-5
  started: v01-c003       # 关系开始的章节号
  ended: ""               # 结束章节号，未结束留空
```

## foreshadows.yml

伏笔账本（状态机语义见上文「总原则」的伏笔状态枚举）。埋设与回收必须记章节号；活跃伏笔（planted/progressing）超过 15 条时应提醒清理。

```yaml
- id: fs-001              # 编号不复用
  title: 老者留下的半块玉佩
  status: planted         # planted|progressing|resolved|abandoned
  priority: high          # high|normal|low
  source: plan            # 可选：plan（章纲/大纲计划登记，缺省）| backfill（共创收稿从作者正文回填）
  planted_chapter: v01-c001
  expected_resolve: v01-c020
  resolved_chapter: ""    # resolved 时必填
  notes: 回收方式备忘
```

`source` 可选：共创收稿时 lore 从作者正文里回填认领的伏笔标 `backfill`，章纲/大纲阶段计划登记的标 `plan`（缺省）。账本跟随正文而非章纲——作者没照章纲写，以正文为准回填。

## timeline.yml

世界内时间线（故事内纪年，不是写作顺序），按故事内时间排序。

```yaml
- year: 玄历1024年冬       # 故事内纪年，须含数字（check 按数字解析）
  title: 北境雪灾
  description: 补充说明（可空）
  importance: 4            # 1-5，5 = 改写主线走向的大事
  chapter: v01-c002        # 事件发生在正文里的章节号
```

## memories.yml

叙事记忆：正文里已成立的事实账。`appearance` 是出场记录（谁在哪章登过场），`promise` 是角色说出口的承诺（读者记着账）。只记已写进正文的事实，不记计划。

```yaml
- category: appearance    # character|location|item|event|promise|appearance|other
  content: 林晚儿于 v01-c003 首次登场，与主角在当铺交锋
  source_chapter: v01-c003
```

## clue-board.yml

线索板：悬念、误导与推理的调度台。

```yaml
- kind: clue              # clue|red-herring|deduction|question
  content: 当铺掌柜认得玉佩却装作不识
  related_chapter: v01-c003
  resolved: false          # 误导揭示/悬问解答/推理兑现后置 true
```

## research/

素材调研员的考据笔记（`<topic>.md`）：frontmatter 记 `topic` 与 `sources`（来源 URL 列表），body 是可直接用于写作的结论要点，区分史实/通说/演义并标注可信度。其余角色不改动此目录。

## exports/

导出产物：`maoying export` 的默认落盘点（--format md|txt|epub，--out 可改到别处），init 只建目录。
