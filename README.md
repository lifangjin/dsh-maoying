# dsh-maoying（毛颖）

毛颖者，笔也——韩愈作《毛颖传》，把一支毛笔写成有封地有爵位的臣子。dsh-maoying 把这支笔装进 DSH（DeepSeek Harness）：**一支管着一班帮手、守着一摞书稿的毛笔**——网文创作辅助插件，全部实现原创，MIT 发布。

装上之后，主 agent 变身**网文主编（创作总监）**：带七阶段工作流与六步写作法，把大纲、正文、审校、设定维护、素材考据分别委派给五个只带本行工具的帮手；整部小说就是工作区里的 `novel/` 结构化 markdown/YAML 目录（角色卡、伏笔状态机、时间线、线索板、叙事记忆）——agent 直接读写文件，**没有数据库，没有 API 层**。查「所有未回收伏笔」就是 grep 一行。

## 功能特性

- **主编 + 五帮手**：主 agent 当主编，只做规划、衔接、验收、状态推进；大纲师（outline）、写手（write）、审校（review）、设定管理员（lore）、素材调研员（research）各带本行工具随叫随到。找文件、查伏笔状态这类顺手小事主编自己 glob/grep 就办，不绕委派。
- **novel/ 文件数据库**：角色卡、世界观、科学设定三色标注、关系图、伏笔账本、时间线、叙事记忆、线索板，全部是 grep 友好的平键/顶层数组 YAML——人可直接改，git 可版本化，无迁移无运维。
- **七阶段工作流**：idea 选题 → setting 设定 → outline 大纲 → writing 写作 → review 审阅 → consistency 一致性 → export 导出。阶段记在 project.yml 的 phase 键，每完成一个里程碑主编推进并简报。
- **Writing 六步法**：衔接检查 → 出大纲 → 写正文 → 审稿 → 修改 → 定稿维护，逐章循环；配合 Collab 四步共创（设定共创 → 分卷规划 → 黄金三章 → 交接循环）把新书从零带到滚动更新。
- **伏笔状态机**：planted（埋设）→ progressing（推进）→ resolved（回收）/ abandoned（弃用），埋设与回收记章节号、预期回收章节排期、优先级分档——长篇不断线，活跃伏笔超 15 条主编主动提醒清理。
- **上下文按需取**：主编先读 index.yml 概览，写到哪章读哪章（前章结尾约 1500 字 + 该章大纲 + 出场角色卡 + 活跃伏笔节选），不把整本书塞进上下文。
- **工具面收窄**：主编只见「角色委派 + 内部检索 + 协调」白名单，帮手各带本行工具（审校只读、考据只带联网+落笔记）；每次请求的工具开销与上下文占用随之下降。
- **素材考据**：research 帮手联网检索历史/地理/专业领域素材，笔记落 `novel/research/`，区分史实/通说/演义并附来源——DSH 架构的红利。
- **CLI 兜底**：`maoying init / stats / index` 三条零依赖命令管脚手架、字数统计与章节概览重建。

## 快速开始

前置：**Node.js ≥ 18**、已装好的 DSH host（**0.1.7+**，见「兼容面」）。

官方插件通道——一条命令，装完重启即用：

```bash
dsh plugin --profile web add dsh-maoying
```

**重启 DSH（`dsh web`）**：插件启动时自动把预设装进 `~/.dsh/.agent-presets/maoying/`，并在 `~/.dsh/cordis.patch.yml` 写好声明行托管块，无需再点任何按钮。新会话的预设选择器里选「**毛颖创作 (Maoying)**」即可开写；要设为默认，在 Settings → Agent Presets 里选。

开发检出（想改插件或预设源码）用 link 形态直连仓库，改动经重启生效：

```bash
git clone https://github.com/lifangjin/dsh-maoying.git
dsh plugin --profile web add link:"$PWD/dsh-maoying"
```

## 怎么用

选好预设后，对主编说话即可，它按工作流自己路由：

**开新书（Collab 四步共创）**：

> 我想写一本东方玄幻，主角靠「听懂器物说话」的金手指鉴宝升级。

主编与你对齐题材与基调，委派设定管理员建核心角色卡与世界观条目，委派大纲师做分卷规划，然后把黄金三章（立世界钩子、立主角动机、立核心冲突）写出来交付。

**逐章写作（Writing 六步法）**：

> 第三章可以开写了吗？

主编做衔接检查，委派大纲师出本章大纲（含五维叙事字段），过目后派写手写正文、审校审稿（清单 + 四维一致性扫描），有问题回写手修，通过后置 accepted 并委派设定管理员做定稿维护——你只需要在决策点拍板。

**集中审查**：

> 前 20 章做一次一致性检查。

主编推进 phase 到 consistency，审校扫描冲突/时间线/伏笔/设定四维，问题按严重度排好交回写手。

用户回「ok / 可以 / 继续」即视为确认，主编直接推进，不复述确认。

## 方法论技能

随插件带 4 个网文方法论技能，插件启动时安装器把它们落盘到 `~/.dsh/skills/`（即 `<home>/skills/`）下的 `maoying-*` 四个目录，宿主技能面板可直接看到；大纲师、写手、审校、设定管理员按场景自动加载，你不用手动操作：

| 技能 | 一句话说明 |
|---|---|
| maoying-golden-opening | 黄金三章：前三章职能分工（世界钩子 → 动机确立 → 冲突引爆）、前 300 字出事原则、信息释放纪律与自检清单 |
| maoying-beat-pacing | 爽点节奏：爽点类型库、压抑-释放配比、单章/中/大三级节奏曲线与章尾钩子选型 |
| maoying-review-checklist | 审校清单：语言/节奏/人设/逻辑/伏笔/剧透六层逐项检查，按 P0/P1/P2 三档严重度输出 |
| maoying-foreshadow-discipline | 伏笔管理：埋设即登记、推进节奏排期、回收「意外 + 合理」标准与台账清理阈值 |

安装器只认 `maoying-*` 前缀目录，`~/.dsh/skills/` 下你自己的技能一个字节不动。卸载插件后技能目录需手动清理（四目录一起删）：

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/"maoying-*
```

## novel/ 数据规范

`novel/` 目录是整个插件的数据库：project.yml（元信息与七阶段 phase）、volumes.yml、chapters/（frontmatter 五维叙事字段 + 正文）、characters/（角色卡）、world/、science/（三色设定）、relations.yml、foreshadows.yml（伏笔状态机）、timeline.yml、memories.yml（含出场记录与承诺账）、clue-board.yml、research/、exports/。全部格式、示例与设计理由见：

- 速查版：项目初始化后的 `novel/README.md`（模板源 [templates/novel/README.md](templates/novel/README.md)）
- 完整版：[docs/spec.md](docs/spec.md)（为什么不用 SQLite、五维字段定义、伏笔状态机语义、出场记录约定）

## CLI

```bash
maoying init [dir]     # 生成 novel/ 脚手架（默认 ./novel；已存在文件一律跳过，绝不覆盖）
maoying stats [dir]    # 逐章 CJK 字数、状态分布、当前 phase
maoying index [dir]    # 从 volumes.yml + chapters/ 重建 index.yml（派生文件）
maoying export [dir]   # 导出全书：--format md|txt|epub（默认 md），--out <目录> 改输出位置
```

export 示例：

```bash
maoying export novel                      # Markdown，落到 novel/exports/
maoying export novel --format txt         # 纯文本
maoying export novel --format epub        # EPUB 3（零依赖打包，可直接导入阅读器）
maoying export novel --format epub --out ~/Downloads   # 换输出目录
```

输出目录默认 `<dir>/exports/`，文件名 `<书名>-<YYYYMMDD>.<扩展名>`（书名取 project.yml 的 title）；章节解析与 stats/index 同一套逻辑，frontmatter 不会混进正文。

零依赖（node:fs/path/url/crypto），任意 cwd 可用；npm 全局安装或 `pnpm link` 后可直接 `maoying` 调用，否则 `node <插件目录>/bin/maoying.mjs` 等价。日常写作中 index.yml 由设定管理员直接重建，CLI 主要给人用。

## 卸载

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/.agent-presets/maoying"
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/"maoying-*
```

宿主是 DSH 0.1.7+ 时再补一步：删去 `~/.dsh/cordis.patch.yml` 里的 dsh-maoying 托管块（`# --- dsh-maoying preset managed (auto-generated; do not edit) ---` 到 `# --- end dsh-maoying preset managed ---` 之间的整段，含两行标记），免得留下指向已删目录的声明行。`novel/` 目录是你的书稿，卸载插件不会动它。

## 兼容面

插件启动时读宿主版本（`<home>/node_modules/@deepseek-ai/dsh/package.json`），按版本自动选择委派行形状——**宿主升级后重启即切换，无需重装插件**：

- **DSH 0.1.7 – 0.2.1-rc.1 → v1 内联形状**：5 个角色委派行直接内联 persona 与 toolFilter，托管块 1 条声明行。
- **DSH 0.2.1-rc.2+ → v2 AgentPreset 形状**：该版本起 dsh-tool-subagent 拒绝内联 persona/toolFilter，插件改用 [presets/maoying/agent.cordis.v2.yml](presets/maoying/agent.cordis.v2.yml)——托管块写 6 条声明行（主编 preset + 大纲师/写手/审校/设定管理员/素材调研员 5 张角色 preset），主编委派行以 `agentPreset` 指向角色 preset，角色的工具面由 preset 里的实体工具行承载（审校只读、考据带联网检索）。
- **角色预设会出现在预设选择器**（宿主对预设没有隐藏机制），name 带「（内部）」标明：日常写作由主编委派自动选用，不经主编、想单独开一个写手/考据会话时直接选中即可。
- 两种形状的 persona 文本同源逐字一致（[test/composition.test.mjs](test/composition.test.mjs) 逐字节把关）；宿主版本读不到时保守按 v1 处理。
- ≤0.1.6 的目录扫描轨道：不做（宿主已淘汰）。

## 许可

[MIT](LICENSE) © 2026 lifangjin

## 致谢

- 编排机制（bundle patch 挂载、预设启动安装器、托管块手术、工具面收窄）参考同作者 [lifangjin/dsh-paoding](https://github.com/lifangjin/dsh-paoding)（MIT）的已验证路径。
- 「毛颖」得名于韩愈《毛颖传》，与庖丁（dsh-paoding，典出《庄子》）同一命名脉络。
