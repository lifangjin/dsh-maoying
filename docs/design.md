# dsh-maoying（毛颖）设计文档

网文创作辅助 DSH 插件。以 MIT 发布。

命名：毛颖，典出韩愈《毛颖传》——毛笔拟人得名「毛颖」。

## 1. 核心洞察与架构

常见 AI 小说工具的链路是 LLM → function calling（30+ 工具）→ Express API → SQLite；毛颖走 DSH 里天然更省的一条：

```
maoying:  agent → glob/grep/read/edit/write → 工作区 novel/ 结构化文件
```

小说项目 = 一个结构化 markdown/YAML 目录。查「所有未回收伏笔」就是 grep foreshadows.yml，无需 API 层与数据库；人可直接改文件、git 可版本化。

插件形态（一期，无 UI 面板）：

```
dsh-maoying/
  package.json            # name: dsh-maoying, engines: dsh >=0.1.7 <0.3, type: module
  cordis.patch.yml        # bundle insert → 挂载 index.mjs（启动时安装预设）
  index.mjs               # cordis 插件：启动时 ensurePresetInstalled（幂等）
  icon.svg
  presets/maoying/        # 预设源（会被复制到 ~/.dsh/.agent-presets/maoying/）
    preset.yml            #   name/description/order
    agent.cordis.yml      #   完整组合：主编人设 + 5 角色委派 + 工具行
    restrict.mjs          #   主编工具面白名单（system-prompt/assemble 瀑布）
    delegation-labels.mjs #   委派标签带角色显示名（tools/pre-execute 瀑布）
  bin/maoying.mjs         # CLI：init / stats / index / export / brief / check
  templates/novel/        # init 脚手架模板
  docs/                   # design.md（本文）、spec.md（数据规范）
```

### 安装机制

1. `dsh plugin --profile web add dsh-maoying`：包经 pnpm 装进 profile，包内 cordis.patch.yml 声明 bundle insert（`- insert: [- id: maoying-installer, name: dsh-maoying]`），boot 时并入补丁树。
2. index.mjs（cordis 插件 main）启动时执行 ensurePresetInstalled：
   - 解析 dsh home（`DSH_HOME` 或 `~/.dsh`）；
   - 把 `presets/maoying/` 四个文件复制到 `<home>/.agent-presets/maoying/`（内容或版本变化即覆盖，写入 `.installed-version` 标记）；
   - 在 `<home>/cordis.patch.yml` 写托管块（`# --- dsh-maoying preset managed (auto-generated; do not edit) ---` 起止标记），内容为声明行：

     ```yaml
     - insert:
         - id: preset-maoying
           name: '@deepseek-ai/dsh-agent-preset'
           config:
             id: maoying
             name: "毛颖创作"
             description: <preset.yml description>
             order: 6
             plugins: <agent.cordis.yml 解析后的完整数组>
     ```

   - 全程幂等：标记块已存在且版本一致则跳过；不一致则整块替换。YAML 解析/序列化运行时从 dsh home 惰性借宿主自带的 `yaml` 包（lib/yaml-loader.mjs 多级探针），借不到回退内置极简解析（JSON 单行回退同样合法 YAML）——仓库零 npm 依赖，dependencies 恒为空。
   - 按宿主版本自动选委派行形状：≥0.2.1-rc.2 写 v2 AgentPreset 六行块（agent.cordis.v2.yml），确知 <0.2.1-rc.2 写 v1 内联单行块；宿主版本完全未知（五级探针全败）时不写声明行、预设文件照落走 partial 自愈（下次启动版本可读时自动补写）——绝不把可能已 ≥0.2.1-rc.2 的宿主声明成 v1 内联。宿主升降级重启即整块切换，不再需要任何降级提示（形态依据见 §8，支持面见 §6）。
3. 卸载 `dsh plugin remove dsh-maoying` 后：bundle 行消失，托管块与 .agent-presets/maoying/ 需手动删（README 写明两条 rm 命令）。

## 2. 功能裁决（一期范围）

| 功能 | maoying 一期 | 载体 |
|---|---|---|
| 项目管理（类型/篇幅/语言） | novel/project.yml | 文件规范 |
| 7 阶段工作流状态机 | 保留，写 project.yml phase | 主编人设 |
| Writing 6 步写作法 | 保留改写 | 主编人设（委派映射：大纲→outline、正文→write、审稿→review） |
| Collab 4 步共创 | 保留改写 | 主编人设 |
| 五维叙事字段 | 保留（章节 frontmatter 五键） | 文件规范 |
| 角色卡 + 出场记录 | characters/*.md；出场记录入 memories.yml（category: appearance） | 文件规范 |
| 世界观 / 科学设定三色 | world/*.md、science/*.md（label: known/extrapolation/hypothesis） | 文件规范 |
| 伏笔状态机 | foreshadows.yml（planted/progressing/resolved/abandoned + 预期回收章节 + 优先级） | 文件规范 |
| 时间线 / 叙事记忆（promise）/ 线索板 | timeline.yml / memories.yml / clue-board.yml | 文件规范 |
| 人物关系图可视化 | relations.yml 纯数据（一期无图） | 文件规范 |
| 上下文注入（全量角色+章节+伏笔） | 改为分层门控按需读：常驻项（project/style/主角卡/金手指与核心冲突条目/活跃伏笔）恒读，其余角色卡与 world 条目写到谁读谁、长条目只读 `## 锚点` 段；主编先读 index.yml 概览，写到哪章读哪章的上下文（前章结尾+该章大纲+出场角色卡+活跃伏笔） | 主编人设纪律 |
| AI 工具集 function calling | 天然消失（agent 直接用文件工具） | DSH 架构红利 |
| 一致性检查（冲突/时间线/伏笔/设定 + 连贯六维） | review 角色（审校）：一致性扫描 + 审稿清单 | 委派角色 |
| 导出 EPUB/MD/TXT | **已交付**：`maoying export`（见 §8）；HTML 从未规划 | CLI |
| Token 用量统计 | 无需（DSH 自带） | — |
| Web 管理面板 | **三期** | — |
| 素材考据调研 | **research 角色**：web 检索历史/地理/专业素材，笔记落 novel/research/ | 委派角色（DSH 差异化优势） |

## 3. novel/ 数据规范（决策定稿）

```
novel/
  README.md            # 数据规范速查（init 时从模板生成；主编不确定格式时读它）
  project.yml          # title/author/genre/length/language/phase/mode/description
  index.yml            # 派生概览（maoying index 重建；主编每次开工先读）
  volumes.yml          # - {id: v01, title, summary, chapters: "001-020"}
  chapters/
    v01-c001.md        # frontmatter: volume/num/title/status/summary + 五维键；
                       #   正文在 body。status: pending|writing|review|accepted
  characters/
    <slug>.md          # frontmatter: name/age/gender/role(protagonist|antagonist|supporting|minor)/
                       #   appearance/personality/background/motivation/arc/markers[]/可选 never_do[]；body 为备注
  world/
    <slug>.md          # frontmatter: category(地点|组织|概念|事件)/tags[]；body 为描述
  science/
    <slug>.md          # frontmatter: label(known|extrapolation|hypothesis)/references[]；body
  relations.yml        # - {a, b, type, description, intensity: 1-5, started, ended}
  foreshadows.yml      # - {id: fs-001, title, status, priority, planted_chapter,
                       #    expected_resolve, resolved_chapter, notes}
  timeline.yml         # - {year, title, description, importance: 1-5, chapter}
  memories.yml         # - {category: character|location|item|event|promise|appearance|arc|other,
                       #    content, source_chapter}
  clue-board.yml       # - {kind: clue|red-herring|deduction|question, content,
                       #    related_chapter, resolved: bool}
  research/            # research 角色考据笔记落这里（<topic>.md）
  exports/             # maoying export 导出产物（默认 <dir>/exports/，--out 可改）
```

要点：五维字段键名用英文（cognitive_frame / emotional_anchor / world_texture / suspense / interpersonal_tension，YAML 工具安全），值中文；模板文件内注释给中文说明。frontmatter 用 `---` 围栏。所有 yml 顶层是数组或平键，禁止深嵌套——grep 友好。

## 4. 编排预设：主编 + 五帮手

主 agent = 主编（创作总监），带方法论人设；重活委派：

| toolName | 角色 | 干什么 | backgroundMode | 工具面（toolFilter.allow） |
|---|---|---|---|---|
| outline | 大纲师 | 卷章规划、章节大纲+五维字段 | continuable | read read_image glob grep write edit bash skill ask_user_question todo_write |
| write | 写手 | 章节正文（按大纲写、衔接前章、回报设定变更） | continuable | read read_image glob grep write edit bash skill ask_user_question todo_write |
| review | 审校 | 审稿清单 + 一致性扫描（冲突/时间线/伏笔/设定 + 连贯六维，只读、出报告不改稿） | one-shot | read read_image glob grep skill todo_write ask_user_question |
| lore | 设定管理员 | 章节/角色/世界观/伏笔/时间线/记忆/线索板维护，出场记录与伏笔状态推进 | continuable | read glob grep write edit bash skill ask_user_question todo_write |
| research | 素材调研员 | 联网考据（历史/地理/专业领域），笔记落 novel/research/ | one-shot | web_search web_fetch glob grep read write bash ask_user_question todo_write |

主编工具面（restrict.mjs 白名单）：outline write review lore research + send_message list_agents interrupt_agent + glob grep read read_image bash + todo_write ask_user_question get_goal create_goal update_goal exit_plan_mode job_output job_list job_kill + edit（主编亲笔小修小补不过委派）。其中 'write' 一名双义——单条 'write' 同时放行 tool-fs 的文件写工具与 delegation-write 以 toolName: write 注册的委派工具（白名单按工具名匹配，宿主 registry 对同名工具的处理仓内无法核实，改名前必须先核实）。registry deny: ['skill']（堵 ~1.3k 技能目录注入）。

注意：toolFilter.allow 一律不放 mcp__* 工具（子代理创建时 tools.restrict 校验名字必须在注册面，MCP 是否挂载是 host 事实，硬编码会让未装 tavily 的宿主直接建不出子代理）；skill 仅用于按 persona 加载 maoying-* 方法论技能（审校同样只读不改）。

delegation-labels 静态角色名映射：{outline: 大纲师, write: 写手, review: 审校, lore: 设定管理员, research: 素材调研员}。

## 5. 主编人设（核心 IP，中文）

persona prefix 内容骨架（agent.cordis.yml 内联，中文书写）：

1. **身份**：网文主编/创作总监，管 project 目录 novel/，重活委派五帮手，自己只做规划、衔接、验收、状态推进。
2. **开工纪律**：先读 novel/project.yml + index.yml + style.md（若有）；不确定文件格式读 novel/README.md；取上下文分层门控：常驻项恒读（project.yml/style.md/主角卡/金手指与核心冲突条目/活跃伏笔），按需项出场才读（其余角色卡与非核心 world 条目，长条目只读 `## 锚点` 段），跨卷剧情先读 memories.yml 的 arc 卷摘要；不全量读章节，写到哪章读哪章上下文（前章结尾 ~1500 字 + 该章 frontmatter + 按需角色卡 + 活跃伏笔节选）。
3. **七阶段状态机**（每阶段推进写 project.yml phase）：idea 选题 → setting 设定 → outline 大纲 → writing 写作 → review 审阅 → consistency 一致性 → export 导出。每完成一个里程碑必须推进 phase 并告知用户。
4. **Writing 六步法**（逐章循环）：
   ① 衔接检查：读前章结尾，确认无断裂；
   ② 委派 outline 出/改本章大纲（含五维字段），主编过目；
   ③ 委派 write 写正文（写手人设要求：按大纲覆盖五维、不写崩人设、章尾留钩子），status→writing；
   ④ 委派 review 审稿（清单：语言/节奏/人设符合/不剧透/伏笔推进合理/前后矛盾/风格符合），status→review；
   ⑤ 审稿问题回 write 修（continuable 就地续修）或主编微调；
   ⑥ 定稿维护（原子动作）：委派 lore 一次跑完章纲对照结论（共创模式）+ 五本账（memories/timeline/relations/foreshadows/clue-board）+ `maoying index` 重建概览 + 一致性核对，全部落盘后 status→accepted；中途断了汇报缺口清单再续。
   循环检查：还有非 accepted 章节 → 回 ①。
5. **Collab 四步共创**（新书冷启动）：设定共创（最小设定集逐项对齐 + 世界观与核心角色卡落盘，设用户拍板点）→ 分卷规划（volumes.yml + 各卷 summary，设用户拍板点）→ 前三章交付（机械自检设定件齐备后走黄金三章：第一章立世界观钩子、第二章立主角动机、第三章立核心冲突）→ 交接循环写作（切 Writing 六步法）。
6. **简短确认即执行（分级）**：逐章滚动中用户回「ok/可以/继续」直接推进下一步，不再复述确认；冷启动里程碑（设定共创、分卷规划）是方向性拍板点，须列决策点等用户实质回应。
7. **设定变更上报**：写手回报的临场设定变更（新角色/新地点/伏笔异动）必须经 lore 落盘才算数；发现与既有设定冲突，先停笔报告主编。
8. **失败处理**：委派失败按 DSH 委派 SOP（diagnose by stop reason，max-tokens 拆章，refusal 换路）。

各帮手 persona 一段话（内联在各委派行），写明本行工具纪律与回报格式（如 review 固定输出一致性扫描表格（含连贯六维） + 清单勾选）。

## 6. 兼容面

- 支持：DSH 0.1.7 – 0.2.1-rc.1（patch 声明行 + 内联委派行形状）。
- 0.2.1-rc.2+：dsh-tool-subagent 拒内联 persona/toolFilter——**已适配**：安装器按宿主版本自动切换 v1 内联 / v2 AgentPreset 形状，见 §8 与 README「兼容面」。
- ≤0.1.6 目录扫描轨道：不做（已淘汰）。
- 当前开发宿主：0.2.0-rc.2（内联形状 OK）。

## 7. CLI（bin/maoying.mjs，零依赖 node:fs）

- `maoying init [dir]`：从 templates/novel/ 脚手架生成 novel/（已存在文件跳过，绝不覆盖），README.md + 各 yml 带中文注释示例。
- `maoying stats [dir]`：逐章与总字数（CJK 计数）、状态分布、phase 展示。
- `maoying index [dir]`：从 chapters/ 重建 index.yml（卷/章/标题/状态/字数/一句话梗概）。
- `maoying export [dir]`：导出全书为 md / txt / epub（默认 md；`--out` 改输出目录，缺省 `<dir>/exports/`；同名自动加序号不覆盖）。
- `maoying brief [dir] <chapter>`：组装单章写作卡（章纲 + 前章结尾 + 出场角色卡 + 活跃伏笔）；`--out <文件>` 落盘，缺省打到 stdout。
- `maoying check [dir]`：静态体检（不调模型），与面板/规范同一套规则（frontmatter 完整性、枚举、章号、伏笔引用、时间线年份、关系卡引用、phase 阶段就绪判据）。
- 主编人设里写明：定稿维护后由 lore 角色直接重写 index.yml（文件规范写明格式），CLI `maoying index` 仅供人工兜底；stats / init 供人工使用。

## 8. 二期路线

- ✅ **技能包（黄金三章/爽点节奏/审校清单/伏笔管理）**——已做：skills/ 四目录随包分发，安装器复制到 `<home>/skills/maoying-*`（逐字节比较幂等 + .installed-version 标记，见 index.mjs installSkills）。
- ✅ **导出（MD/TXT/EPUB）**——已做：`maoying export [dir] --format md|txt|epub [--out <目录>]`；EPUB 由 lib/epub.mjs 零依赖打包（手写 stored zip + CRC32 表格法，EPUB 3 最小合法结构）。
- ✅ **0.2.1-rc.2+ AgentPreset 形态适配**——已做：presets/maoying/agent.cordis.v2.yml（主编 + 5 角色 preset 的 v2 组合源）+ index.mjs composeManagedRows 按宿主版本双形态切换（v1 内联 / v2 AgentPreset，宿主升降级重启即整块换形状；防漂移由 test/composition.test.mjs 逐字节断言，见 README「兼容面」）。
- ✅ **Web 创作台面板**——已做：/api/maoying/* 二十三条路由 + 左侧栏入口 + 会话中栏全页面板，九视图（概览（含书稿元信息编辑）/章节/角色/伏笔看板/关系图/时间线/设定/写作风格/索引板）；设计与契约见 docs/creator-panel.md。

## 9. 五期：共创模式（作者亲笔稿）

定位：作者自己写正文，毛颖从「代笔」转「备料 + 审稿 + 记账」。P0 改流程与规范，P1 补工具。

### 9.1 模式开关

project.yml 加 `mode` 字段：`ai-draft`（默认，现状）/ `co-write`（逐章指派谁写）/ `author-draft`（全书作者写）。章节 frontmatter 可选 `writer: author | ai`（co-write 下用；缺省按 mode 推）。

### 9.2 主编共创流程（author-draft / co-write 的 author 章）

- **永不代写**：主编不产出章节正文，不委派 write 写 author 章；
- 循环：大纲师出下一章章纲 → 作者自写 → 作者交稿（贴文或说「第 X 章写完了」）→ 主编收稿：review 意见清单 + lore 账本回填 + 重建 index.yml + 汇报本章伏笔/时间线变动 → 出再下一章章纲；
- co-write 下主编动笔前必须问清本章归谁；author-draft 下 write 角色闲置是正常态。

### 9.3 章纲 outlines/

`novel/outlines/vXX-cXXX.md`，**纯 markdown 无 frontmatter**（作者编辑器里打开不碍眼）：本章目标、节拍、出场角色、需埋/需收伏笔、与前章接口、章尾钩子（独立成 `## 钩子` 节：钩子类型 + 内容，类型对照 maoying-beat-pacing 钩子类型库）。大纲师产物、作者创作输入、review 收稿时的对照基准。不入 index.yml，面板与 brief 现查现拼。

### 9.4 账本回填（lore 收稿流程）

作者正文偏离章纲是常态，账本必须跟正文走：lore 读新稿 → 提取**实际发生**的伏笔埋设/回收、时间线事件、新关系、承诺线、线索 → 更新五本账；foreshadows.yml 条目加可选 `source: plan | backfill`（缺省 plan，回填的标 backfill）。使用约定：novel/ 纳 git，账本变动看 diff。

### 9.5 作者稿圣域（全部模式生效）

- `chapters/` 正文唯作者可改；agent 在 author-draft / co-write 的 author 章上只许动 frontmatter 的 summary / 五维字段，且以建议为先；
- review 输出意见清单，不改稿（工具面本就只读，人设立规矩）；
- ai-draft 章节不受此限（write 照旧）。

### 9.6 P1 工具

- `maoying brief <dir> <章号>` 写作卡：章纲 + 前章结尾约 1500 字 + 出场角色卡 + 活跃伏笔节选，打成一个 md（stdout 或 --out）。给作者带去任意编辑器/其他 AI；
- `maoying check <dir>` 静态体检（**不调模型**——LLM 审校走主编）：frontmatter 完整性、五维缺键、状态枚举、章号/卷号规范、伏笔章号引用存在性、时间线年份乱序、角色卡悬空引用、phase 枚举与阶段就绪判据（outline 起查主角卡/核心反派卡/世界观条目/分卷规划）；
- 面板三件：章节抽屉加章纲对照栏 + 复制文件路径按钮；伏笔看板卡上 `source: backfill` 显示「回填」徽章；章节 tab 顶部「按单写作」区块（有章纲且 status=pending 的章，按序列章纲节选；未建章的孤儿章纲照列——可看章纲全文、一键建章，0.1.15 起）。
