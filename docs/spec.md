# novel/ 数据规范（完整版）

本文是 `templates/novel/README.md`（速查版）的扩写：给每个文件补上设计理由与边界约定。日常查阅用速查版即可；改机制、起争议时以本文为准。速查版与本文冲突时，以本文为准并回报仓库 issue。

## 0. 设计理由：为什么是文件而不是 SQLite

常见做法是 LLM → function calling → Express API → SQLite；毛颖砍成 agent → 文件工具 → `novel/` 目录。这不是省事，是同一种创作负载下的更优解：

- **查询形态匹配**。小说创作的查询是「所有未回收伏笔」「这个角色出场过几章」「v01 的时间线」——全是 grep 一行的事，不需要 JOIN，更不需要 ORM。SQLite 的强项（并发写、随机读、事务）在单人单会话的写作流里用不上。
- **人机共读**。作者随时打开 foreshadows.yml 看账本、手改一个错字；数据库要做到同样的事得先写一层 UI 或 CLI——而文件天然免费。
- **git 即版本控制**。整本书的历史就是目录的历史：哪一章改了什么、伏笔账本何时被谁推进，`git log -p` 一目了然；回滚一章就是回滚一个文件。SQLite 的 blob 历史在 git 里是噪音。
- **零迁移零运维**。schema 演进 = 在 README 里补两行说明 + 旧文件照读；没有 migration 脚本，没有锁文件，没有「数据库被另一个进程占用」。
- **上下文按需取（分层门控）**。取上下文分两层：**常驻项**恒读——project.yml、style.md、主角卡、金手指与核心冲突的 world 条目、活跃伏笔；**按需项**出场/涉及时才读——其余角色卡与非核心 world 条目，写到哪章读哪章；长条目（>100 行）不整读，只读开头锚点段与相关小节（约定条目用 `## 锚点` 开头放 10 行内摘要，见速查版 world/ 说明）。在此之上主编不全量读章节：先读 index.yml 概览，写到哪章读哪章的上下文（前章结尾 + 该章 frontmatter + 按需角色卡 + 活跃伏笔节选）。文件粒度就是天然的上下文裁剪单元。

什么时候该换数据库：多人同时写同一本书、单书章节数到千级、需要全文检索正文以外的高级查询。一期都不在诉求内。

## 1. 总约束

- **所有 yml 顶层是数组或平键，禁止深嵌套**。深嵌套的 YAML 人读着费劲、diff 噪音大、grep 不到——「查所有 high 优先级伏笔」必须能靠 `grep -A3 'priority: high' foreshadows.yml` 完成。需要表达从属关系时用键值引用（slug、章节号），不要用嵌套结构。
- **frontmatter 用 `---` 围栏**，键值一行一个、简单标量；正文（body）在第二个 `---` 之后。frontmatter 键名用英文（工具安全），值用中文。
- **枚举一律全称**，见速查版「总原则」一节；新增枚举值属于规范变更，须同步本文与主编人设。
- **index.yml 是派生文件**，任何手工改动都会被 `maoying index` 或 lore 角色覆盖。
- 章节文件名 `v<卷号2位>-c<章号3位>.md`；frontmatter 的 `volume`/`num` 与文件名一致（CLI 与 index 重建以文件名为主键，frontmatter 为辅）。

## 2. 逐文件规范

字段与最小示例见速查版（`templates/novel/README.md`），此处只补约定：

### project.yml
`phase` 七态 `idea|setting|outline|writing|review|consistency|export` 只能由主编推进（帮手不得越权改），且必须顺序推进不可跳越；推进时主编须向用户简报。推进有完成判据：setting → outline 须核心角色卡（主角、核心反派）与世界观核心条目（金手指规则、对抗格局）已落盘，且 characters/ 有两张及以上角色卡时 relations.yml 不为空（关系网须登记）；outline → writing 须 volumes.yml 在案且目标章大纲已出；判据不满足回上一阶段补齐。冷启动（Collab 四步）在设定落盘与分卷规划两处各设一个用户拍板点——主编简报列决策点，等用户实质确认才进下一步。`language` 影响写手与审校的语言纪律（如 `zh` 不允许成段外文）。`mode` 三值决定正文归谁写：`ai-draft`（缺省，AI 代笔，主编走 Writing 六步法）/ `co-write`（逐章指派谁写，主编动笔前先问清本章归谁）/ `author-draft`（全书作者亲笔，主编只备料、审稿、记账，永不代写）。文件里没有 `mode` 键的旧项目一律按 `ai-draft` 处理。

### style.md
写作风格基准（人称视角、语言基调、节奏、对话、情绪与爽点、禁忌），写手/大纲师/审校一律遵守；纯 markdown、无 frontmatter，作者随时手改、改完即生效；冷启动由主编与用户对齐后落盘，旧项目缺失时按通用网文基线执行。设计理由：风格集中在一个可手改文件里，而不是写死在 persona——persona 只写加载纪律（读它、服从它、冲突上报主编），风格内容随书可变，作者不改插件就能改风格；旧项目没有该文件时优雅降级（各 persona 与审校风格层均写「若有」）；审校风格层以其为裁判基准，文件缺席时退回通用网文基线抽查明显风格跳变，并在报告注明「无风格基准」。

### volumes.yml
`id` 与章节文件名前缀严格一致（`v01` ↔ `chapters/v01-cXXX.md`），index.yml 的卷分组按本文件顺序输出。`chapters` 范围写法 `001-020` 是给人看的计划值，运行时以章节文件实况为准。

### chapters/vXX-cXXX.md
- `status` 流转 `pending → writing → review → accepted`，由主编控制：写手只允许把 `pending/writing` 置为 `writing`，审校不改状态，`accepted` 之前的放行是主编的裁决。
- 五维叙事字段（写手按大纲覆盖、审校逐项对照）：
  - `cognitive_frame` 认知框架：本章读者的认知被如何推动——抛出什么信息差、制造什么误解、在哪里顿悟。防止「读者全知视角写惊悚」的经典翻车。
  - `emotional_anchor` 情感锚点：本章要锚定的情绪与共情对象。网文的核心交付是情绪，不是情节；情节为情绪服务。
  - `world_texture` 世界质感：本章着墨的世界细节层面（风物/规矩/器物/习俗）。逐章小剂量投放，避免设定集中倾泻。
  - `suspense` 具体悬念：本章悬念与章尾钩子的问题化表述（必须是「读者会问出的问题」，不是「作者知道的事实」）。
  - `interpersonal_tension` 人际张力：本章人物关系中的压力与变化（谁与谁的矛盾升温/缓和/变质）。
- 五维字段在大纲阶段（outline 角色）写定、写作阶段（write 角色）覆盖、审校阶段（review 角色）对照——三处都用同一组键，这就是「按大纲写」的可检查形态。
- 可选 `writer` 键（co-write 用）：`author | ai`，记本章正文归谁写；缺省按 project.yml 的 `mode` 推——`author-draft` 下整本按 author、`ai-draft` 下整本按 ai。键只做记录与面板展示，状态机仍看 `status`。

### outlines/vXX-cXXX.md
章纲：共创模式（`co-write` / `author-draft`）下大纲师给作者的创作输入，与章节文件一一对应（`outlines/v01-c005.md` ↔ `chapters/v01-c005.md`）。**纯 markdown、无 frontmatter**——作者会在任意编辑器里打开它，`---` 围栏只会碍眼（第 1 节「frontmatter 用围栏」的总约束不适用本目录）。六件内容写全：本章目标、节拍（场景推进顺序与情绪起伏）、出场角色（谁上场、各带什么目的）、需埋/需收伏笔（对照 foreshadows.yml 报 id）、与前章接口（从哪个钩子接）、章尾钩子——独立成 `## 钩子` 节（钩子类型 + 内容，类型对照 maoying-beat-pacing 的钩子类型库，写明下一章前提被什么改变）。颗粒度标准：作者拿着就能动笔，不写「参见大纲」式的空转。

约定：章纲是计划不是章节事实，**不入 index.yml**（index 只索引章节实况），面板与 `maoying brief` 现查现拼。谁写谁读：大纲师写，作者读，review 收稿时对照评偏离——作者没照章纲写不算错，偏离如实报给主编裁决，账本永远跟正文走。

### characters/<slug>.md
`role` 四态 `protagonist|antagonist|supporting|minor`。`markers`（辨识标记）是审校盯人设的抓手：口癖、习惯动作、禁忌。可选 `never_do`（字符串数组）是行为红线——此角色绝不会做的事（如「绝不当众认输」「从不撒谎害人」）；写手落笔前过一遍，审校对出场角色逐条对照，越线即 P0（口径见审校清单技能人设层）。角色卡一经 `accepted` 章节引用，改动须过主编（写手发现需要新设定时上报，不得自行改卡）。

### world/<slug>.md
`category` 用中文四类 `地点|组织|概念|事件`（值是给人和 agent 读的，中文检索更直接）；`tags` 供 grep 圈定范围。长条目（>100 行）建议以 `## 锚点` 段开头——10 行内摘要（这是什么、规则边界、与主线的关系），供分层取上下文只读锚点段与相关小节。

### science/<slug>.md
三色标注：`known`（史实/公理，写了不算错）→ `extrapolation`（从 known 合理推演，读者能接受）→ `hypothesis`（自设假说，全书内部自洽即可）。审校的「设定一致性」扫描以此分级裁判：违反 known 是硬伤，hypothesis 之间打架按主编裁决。`references` 指向依赖的其他设定 id 或现实出处，形成可追溯的设定依赖链。

### relations.yml
`a`/`b` 用角色 slug；`intensity` 1-5 是给大纲师排戏剧权重的启发值。关系结束（`ended` 填章节号）不删条目——历史关系是审校查「已死角色复活」类 bug 的依据。

### foreshadows.yml
伏笔状态机语义：

```
planted ──→ progressing ──→ resolved
   │              │
   └──────────────┴────→ abandoned
```

- `planted` 埋设：已在正文出现、读者可感知，`planted_chapter` 必填；
- `progressing` 推进：有中间揭示/强化，多章长线伏笔的常态；
- `resolved` 回收：兑现完成，`resolved_chapter` 必填，且不得早于 `planted_chapter`；
- `abandoned` 弃用：明确决定不回收（不是遗忘）——`notes` 里写弃用原因；被遗忘的伏笔不走 abandoned，由 consistency 阶段的审校捞出、主编决定补收或弃用；
- 转移只按上图的边走；`resolved`/`abandoned` 是终态，回退（如 resolved 又翻案）须主编操作并在 `notes` 记一行；
- `expected_resolve` 是排期承诺：写作推进到预期章节附近仍未回收时，主编须向用户报告并决定顺延或弃用；
- 活跃伏笔（planted + progressing）超过 15 条时主编主动提醒清理——账本膨胀是长篇烂尾的第一征兆；
- 可选 `source` 键：`plan | backfill`，缺省 `plan`。`plan` 是章纲/大纲阶段计划登记的伏笔；`backfill` 是共创收稿时 lore 从作者正文里回填认领的——作者正文偏离章纲是常态，账本必须跟正文走，实际发生了计划外的埋设/回收就补登并标 `backfill`，面板据此挂「回填」徽章区分计划内与回填。

### timeline.yml
记故事内时间（`year` 用故事内纪年），不是写作顺序；`chapter` 把事件锚回正文。审校的「时间线一致性」扫描就是对照本表与章节正文。

### memories.yml
叙事记忆 = 正文里已成立的事实账。约定：

- **出场记录**：`category: appearance`，一章一条记「谁在哪章登场」；主角每章都记（审校查隐身主角），配角记首次登场与关键回场；
- **承诺**：`category: promise`，角色说出口的承诺逐条记账——读者记得每一句「我一定会回来」，审校查兑现；
- **卷级梗概**：`category: arc`，一卷一条，卷末由 lore 从本卷正文与账本凝固——写定不再重写，下一卷另起新条；
- **三层冻结摘要**：章级摘要 = 章节 frontmatter `summary`（`accepted` 后冻结不重写）、卷级摘要 = 本条 `arc`、全书概览 = index.yml（派生重建）——上下文恢复时卷摘要优先、章级细节补差，禁止滚动重写大摘要；
- 只记已写进正文的事实；计划中的事记在章节 frontmatter 或 foreshadows.yml，不进记忆；
- 不改动既有条目（写错了由主编裁决后修正，留 notes 说明）。

### clue-board.yml
`kind` 四类：`clue`（线索）`red-herring`（误导）`deduction`（推理）`question`（悬问）。`resolved: true` 表示该线索的戏剧功能已兑现——误导被揭示、悬问被解答、推理被验证。红鲱鱼（red-herring）必须有意埋设，`content` 里写明「误导什么、真答案是什么」，防止审校误报。

### research/ 与 exports/
`research/<topic>.md` 由素材调研员（research 角色）独占写入；frontmatter 记 `topic` 与 `sources`（URL 列表），body 是可直接用于写作的结论要点，区分史实/通说/演义并逐条附来源。`exports/` 是 `maoying export` 的默认产物目录（`--out` 可改到别处）：`maoying export [dir] --format md|txt|epub`，文件名 `<书名>-<YYYYMMDD>.<ext>`，同名自动加序号不覆盖。

### 作者稿圣域（共创模式）
`chapters/` 目录的正文唯作者可改。author-draft / co-write 的 author 章节上，agent（主编与帮手）只可更新 frontmatter 的 `summary` 与五维字段，且以建议为先、动笔前说明；review 一律只出意见清单不改稿。`ai-draft` 章节不受此限，write 照旧。

收稿循环（author-draft / co-write 的 author 章）：作者交稿 → review 出意见清单 → lore 按正文回填五本账（foreshadows / timeline / relations / memories / clue-board）并重建 index.yml → 主编向作者汇报本章伏笔/时间线/关系变动 → 大纲师出下一章章纲。

Writing 六步法的第⑥步定稿维护是**原子动作**：章纲对照结论（共创模式）+ 五本账（memories / timeline / relations / foreshadows / clue-board）+ index.yml 重建 + 一致性核对一次跑完，全部落盘才算定稿（status 才置 `accepted`）；中途断了必须汇报缺口清单（列明哪几项未落盘）再续跑，不许带半套账定稿。

使用约定：`novel/` 建议纳入 git——账本变动看 diff，lore 回填动了哪条一目了然；作者对某笔回填不认可，`git checkout` 对应文件即是回滚。

## 3. index.yml（派生）

由 lore 角色按本节格式重建，或人工跑 `maoying index` 兜底。格式：

```yaml
# index.yml —— 派生文件，可由 lore 角色或 `maoying index` 重建；手工改动会被覆盖。
volumes:
  - id: v01
    title: 第一卷 北境风雪
    summary: 卷定位一句话
    chapters:
        - {num: 1, title: 雪夜来客, status: accepted, words: 3210, summary: 一句话梗概}
orphans:
  - {volume: v02, num: 5, title: 未归卷章, status: writing, words: 1200, summary: ...}
total: {chapters: 21, words: 65210, accepted: 18}
```

- 卷分组照 volumes.yml 顺序；卷内章节按章号升序；章节行一行一条（num/title/status/words/summary），grep 友好；
- 不在任何卷里的章节落 `orphans`（带 volume 键）——主编每次开工扫一眼 orphans 就知道归档欠账；
- `total` 汇总全书：章节数、CJK 总字数、已定稿章数；
- 重建是全量覆盖、确定性输出（不含时间戳），产物可进 git 且 diff 干净。

## 4. CLI 与本规范的关系

- `maoying init` 生成上述全部骨架（已存在文件绝不覆盖）；
- `maoying stats` 读 project.yml + chapters/，报告逐章 CJK 字数、状态分布、当前 phase；
- `maoying index` 是第 3 节重建逻辑的人工兜底（主编的日常路径是让 lore 角色直接重建）；
- `maoying export [dir]` 导出全书为 md / txt / epub（默认 md；`--out` 改输出目录，缺省 `<dir>/exports/`）；
- `maoying brief [dir] <chapter>` 组装单章写作卡（章纲 + 前章结尾 + 出场角色卡 + 活跃伏笔）；`--out <文件>` 落盘，缺省打到 stdout；
- `maoying check [dir]` 静态体检（不调模型）：frontmatter 完整性、枚举值（含 phase）、章号卷号一致、伏笔章号引用、伏笔超期未推进（planted 超 30 章无进展即 warn）、章纲钩子小节缺失、时间线年份、关系卡引用、AI 味统计（连续同式开头/比喻词密度/句长波动，命中即 warn），并把本节 phase 完成判据落成静态检查——phase 到 outline 及之后仍缺主角卡/核心反派卡/世界观条目/分卷规划，或有两张及以上角色卡而 relations.yml 为空，即报 error（判据不满足回上一阶段补齐）。

六者都零依赖，解析器只认本规范的两类形态（平键映射、顶层数组）；深度嵌套不在支持范围——这是规范约束的执行手段之一。
