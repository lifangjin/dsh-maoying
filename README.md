# dsh-maoying（毛颖）

中文 | [English](README.en.md)

毛颖者，笔也——韩愈作《毛颖传》，把一支毛笔写成有封地有爵位的臣子。dsh-maoying 把这支笔装进 DSH（DeepSeek Harness）：**一支管着一班帮手、守着一摞书稿的毛笔**——网文创作辅助插件，全部实现原创，MIT 发布。

装上之后，主 agent 变身**网文主编（创作总监）**：带七阶段工作流与六步写作法，把大纲、正文、审校、设定维护、素材考据分别委派给五个只带本行工具的帮手；整部小说就是工作区里的 `novel/` 结构化 markdown/YAML 目录（角色卡、伏笔状态机、时间线、线索板、叙事记忆）——agent 直接读写文件，**没有数据库，没有 API 层**。查「所有未回收伏笔」就是 grep 一行。

## 功能特性

- **主编 + 五帮手**：主 agent 当主编，只做规划、衔接、验收、状态推进；大纲师（outline）、写手（write）、审校（review）、设定管理员（lore）、素材调研员（research）各带本行工具随叫随到。找文件、查伏笔状态这类顺手小事主编自己 glob/grep 就办，不绕委派。
- **novel/ 文件数据库**：角色卡、世界观、科学设定三色标注、关系图、伏笔账本、时间线、叙事记忆、线索板，全部是 grep 友好的平键/顶层数组 YAML——人可直接改，git 可版本化，无迁移无运维。
- **七阶段工作流**：idea 选题 → setting 设定 → outline 大纲 → writing 写作 → review 审阅 → consistency 一致性 → export 导出。阶段记在 project.yml 的 phase 键，每完成一个里程碑主编推进并简报；推进有完成判据（核心设定落盘、分卷规划与目标章大纲在案才进 writing），不满足就回上一阶段补齐。
- **Writing 六步法**：衔接检查 → 出大纲 → 写正文 → 审稿 → 修改 → 定稿维护，逐章循环；配合 Collab 四步共创（设定共创 → 分卷规划 → 黄金三章 → 交接循环）把新书从零带到滚动更新；设定一览与分卷规划各设一个用户拍板点，前三章在设定齐备前不开工。
- **伏笔状态机**：planted（埋设）→ progressing（推进）→ resolved（回收）/ abandoned（弃用），埋设与回收记章节号、预期回收章节排期、优先级分档——长篇不断线，活跃伏笔超 15 条主编主动提醒清理。
- **上下文按需取**：主编先读 index.yml 概览，写到哪章读哪章（前章结尾约 1500 字 + 该章大纲 + 出场角色卡 + 活跃伏笔节选），不把整本书塞进上下文。
- **工具面收窄**：主编只见「角色委派 + 内部检索 + 协调」白名单，帮手各带本行工具（审校只读、考据只带联网+落笔记）；每次请求的工具开销与上下文占用随之下降。
- **素材考据**：research 帮手联网检索历史/地理/专业领域素材，笔记落 `novel/research/`，区分史实/通说/演义并附来源——DSH 架构的红利。
- **创作台面板**：DSH 侧栏一键打开的全页可视化面板——概览（含书稿元信息编辑与分卷规划）/章节/角色/伏笔/关系图/时间线/设定/写作风格/索引板九个 tab；章节整页阅读（章纲对照 + 正文/章纲编辑保存 + 五维 + 状态流转）、project.yml 表单化编辑、写作风格查看与编辑（缺失时用默认基线创建）、账本与实体卡的人工编辑写面（编辑/新建/删除，带结构校验与确认弹层）、顶栏字号六档缩放与自动新版检测。
- **CLI 兜底**：`maoying init / stats / index / export / brief / check` 六条零依赖命令管脚手架、统计、索引重建、导出、写作卡打包与静态体检。

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

只要命令行工具、不装插件的读者：零依赖 CLI 单独可用，`npx` 即跑，或装成全局命令（均为 npm 通道，与插件互不相干）：

```bash
npx maoying init                 # 免安装直接跑
npm install -g dsh-maoying       # 或装成全局 maoying 命令
```

## 怎么用

选好预设后，对主编说话即可，它按工作流自己路由：

**开新书（Collab 四步共创）**：

> 我想写一本东方玄幻，主角靠「听懂器物说话」的金手指鉴宝升级。

主编与你逐项对齐设定（题材、金手指、基调、主角三要素、对抗主线），设定管理员落盘核心角色卡与世界观条目后交你拍板；大纲师出分卷规划再交你拍板——设定与分卷都定了，才动笔黄金三章（立世界钩子、立主角动机、立核心冲突）交付。

**逐章写作（Writing 六步法）**：

> 第三章可以开写了吗？

主编做衔接检查，委派大纲师出本章大纲（含五维叙事字段），过目后派写手写正文、审校审稿（清单 + 一致性扫描：冲突/时间线/伏笔/设定 + 连贯六维：行为/因果/资源/身份/伤势/战力），有问题回写手修，通过后由设定管理员一次跑完定稿维护（章纲对照 + 五本账 + index 重建 + 一致性核对，全部落盘才置 accepted）——你只需要在决策点拍板。

**集中审查**：

> 前 20 章做一次一致性检查。

主编推进 phase 到 consistency，审校扫描冲突/时间线/伏笔/设定与连贯六维（行为/因果/资源/身份/伤势/战力），问题按严重度排好交回写手。

用户回「ok / 可以 / 继续」即视为确认，主编直接推进，不复述确认。

## 创作台面板

DSH 左侧栏底部点「**毛颖创作台**」打开全页面板（改文件、跑流程之外，给肉眼看的驾驶舱）：

- **章节**：状态筛选 + 按单写作清单；点章节进整页阅读——返回按钮、章纲对照（Markdown 渲染）、正文与章纲就地编辑保存（textarea 手动保存；文件在编辑期间被外部改过时拒绝保存并放回磁盘最新内容，不覆盖人工改动）、五维叙事字段、一键状态流转。
- **概览**：书稿卡右上「编辑」按钮展开 project.yml 的书名/作者/题材/篇幅/语言/工作流阶段/共创模式/简介表单化编辑（原「小说设置」tab 并入），保存保留文件里原有注释；表单载入后 project.yml 被外部（作者手改 / agent 推进阶段）改过时拒绝保存并提示重改，不覆盖人工改动。概览另设「分卷规划」卡，列出 volumes.yml 各卷定位与计划章节范围——拍板过的分卷有处可查，卡头「编辑源文件」可整文件编辑 volumes.yml。
- **受管文件写面**：角色/设定/科学设定卡与六本账本（关系/时间线/记忆/线索板/伏笔/分卷）均可从面板编辑源文件——墙头「新建」、卡详情「编辑源文件/删除文件」、各账本卡头「编辑源文件」（时间线/关系图空态也给入口）；保存时结构校验（账本须是条目数组、实体卡须带 frontmatter 围栏，不合即拒存），外部改动保护与正文编辑同口径；章节阅读页可新建章纲（本章目标/节拍/出场角色/需埋需收伏笔/与前章接口五件骨架预填）、删除章纲与删除章节——删除均确认弹层，不可逆，后悔靠 git，静态体检会把孤儿引用标出来。
- **顶栏**：当前版本号常驻；npm 上有新版时亮「有新版 ↗」徽章直连发布页，旁边「一键升级」按钮直接用 pnpm 把最新包装进当前 DSH 档（仅支持 profile 目录安装，pnpm 缺失时自动回落 corepack；检测到全局 `maoying` CLI 时顺带以同一精确版本更新，未装则跳过；装完需重启 DeepSeek 才生效）；「检测更新」按钮随时手动现测线上最新版（绕过 1h 缓存——面板打开时只自动拉一次，页面开久了也不聋）；齿轮打开系统设置，界面语言中文/English 可切、字号六档（100%–150%）整体缩放，均立即生效并记忆。

面板写状态（章节状态、project.yml、index.yml 重建），正文/章纲/账本/实体卡等全部人工编辑入口只给人用（hash 旧版检测 + 结构校验，外部改动一律拒绝覆盖）——agent 的创作边界不变：共创模式下正文永远归作者与主编。

## 共创模式（作者亲笔）

不是谁都想让 AI 代笔。project.yml 的 `mode` 键决定正文归谁写，三种模式一句话：`ai-draft`（默认）AI 代笔，走 Writing 六步法；`co-write` 逐章指派谁写，主编动笔前先问清本章归谁；`author-draft` 全书作者亲笔，毛颖只备料、审稿、记账，永不代写。

author-draft 下的协作循环——你只管写，交稿即接管杂务：

> 第 5 章写完了，贴给你。（正文直接粘进对话，或者说一声第 X 章写完、指个文件）

主编收稿后你会拿到三样东西：**审校意见清单**（只挑问题、不代改，改不改随你）、**账本回填**（伏笔/时间线/关系/记忆/线索五本账按你正文实际发生的记，计划外的改动也能认领，来源标 `backfill`）、**下一章章纲**（`novel/outlines/vXX-cXXX.md`，拿着就能写）。圣域纪律：`chapters/` 正文唯作者可改，agent 至多更新 frontmatter 的 summary 与五维字段，且先建议后动手。

配套命令：`maoying brief <dir> <章号>` 打包写作卡（章纲 + 前章结尾 + 角色卡 + 活跃伏笔，带去任意编辑器或其他 AI），`maoying check <dir>` 做零模型静态体检（frontmatter 完整性、伏笔章号引用与超期、章纲钩子小节、时间线乱序、AI 味统计（句式重复/比喻密度/句长节奏）等，不调模型——LLM 审校走主编）。

## 方法论技能

随插件带 4 个网文方法论技能，插件启动时安装器把它们落盘到 `~/.dsh/skills/`（即 `<home>/skills/`）下的 `maoying-*` 四个目录，宿主技能面板可直接看到；大纲师、写手、审校、设定管理员按场景自动加载，你不用手动操作：

| 技能 | 一句话说明 |
|---|---|
| maoying-golden-opening | 黄金三章：前三章职能分工（世界钩子 → 动机确立 → 冲突引爆）、前 300 字出事原则、信息释放纪律与自检清单 |
| maoying-beat-pacing | 爽点节奏：爽点类型库、压抑-释放配比、单章/中/大三级节奏曲线与章尾钩子选型 |
| maoying-review-checklist | 审校清单：语言/节奏/人设/逻辑/伏笔/剧透/风格七层逐项检查，按 P0/P1/P2 三档严重度输出 |
| maoying-foreshadow-discipline | 伏笔管理：埋设即登记、推进节奏排期、回收「意外 + 合理」标准与台账清理阈值 |

安装器只认 `maoying-*` 前缀目录，`~/.dsh/skills/` 下你自己的技能一个字节不动。卸载插件后技能目录需手动清理（四目录一起删）：

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/"maoying-*
```

## novel/ 数据规范

`novel/` 目录是整个插件的数据库：project.yml（元信息与七阶段 phase）、style.md（写作风格基准）、volumes.yml、chapters/（frontmatter 五维叙事字段 + 正文）、characters/（角色卡）、world/、science/（三色设定）、relations.yml、foreshadows.yml（伏笔状态机）、timeline.yml、memories.yml（出场记录、承诺账、卷级梗概）、clue-board.yml、research/、exports/。全部格式、示例与设计理由见：

- 速查版：项目初始化后的 `novel/README.md`（模板源 [templates/novel/README.md](templates/novel/README.md)）
- 完整版：[docs/spec.md](docs/spec.md)（为什么不用 SQLite、五维字段定义、伏笔状态机语义、出场记录约定）

## CLI

```bash
maoying init [dir]     # 生成 novel/ 脚手架（默认 ./novel；已存在文件一律跳过，绝不覆盖）
maoying stats [dir]    # 逐章 CJK 字数、状态分布、当前 phase
maoying index [dir]    # 从 volumes.yml + chapters/ 重建 index.yml（派生文件）
maoying export [dir]   # 导出全书：--format md|txt|epub（默认 md），--out <目录> 改输出位置
maoying brief [dir] <chapter>  # 组装单章写作卡（章纲+前章结尾+角色卡+活跃伏笔）；--out 落盘，缺省 stdout
maoying check [dir]    # 静态体检（不调模型）：frontmatter/枚举/章号/伏笔引用与超期/章纲钩子/AI 味统计/时间线年份/关系卡引用/phase 就绪判据
```

export 示例：

```bash
maoying export novel                      # Markdown，落到 novel/exports/
maoying export novel --format txt         # 纯文本
maoying export novel --format epub        # EPUB 3（零依赖打包，可直接导入阅读器）
maoying export novel --format epub --out ~/Downloads   # 换输出目录
```

输出目录默认 `<dir>/exports/`，文件名 `<书名>-<YYYYMMDD>.<扩展名>`（书名取 project.yml 的 title）；章节解析与 stats/index 同一套逻辑，frontmatter 不会混进正文。

零依赖（node:fs/path/url/crypto），任意 cwd 可用。装法三选一：`npm install -g dsh-maoying`、随用随取的 `npx maoying <命令>`、或开发机的 `npm link`（仓库检出即改即生效）。三样都没有时 `node <插件目录>/bin/maoying.mjs` 等价（dsh 插件安装也会把包落进 profile，可直接指过去）。日常写作中 index.yml 由设定管理员直接重建，CLI 主要给人用。

## 卸载

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/.agent-presets/maoying"
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/"maoying-*
```

宿主是 DSH 0.1.7+ 时再补一步：删去 `~/.dsh/cordis.patch.yml` 里的 dsh-maoying 托管块（`# --- dsh-maoying preset managed (auto-generated; do not edit) ---` 到 `# --- end dsh-maoying preset managed ---` 之间的整段，含两行标记），免得留下指向已删目录的声明行。`novel/` 目录是你的书稿，卸载插件不会动它。

## 兼容面

插件启动时读宿主版本，按版本自动选择委派行形状——**宿主升级后重启即切换，无需重装插件**。版本探测是五级探针（argv[1] → 全 argv 扫描 → app.asar / desktop-runtime → Electron API → home 全局兜底），前四级锚定当前进程的真实宿主，`<home>/node_modules/@deepseek-ai/dsh/package.json` 那份 home 全局安装只做最后兜底（老 CLI 残留可能陈旧几个大版本）；每级读到了什么可查创作台面板的 `host-debug` 端点（路径已脱敏）：

- **DSH 0.1.7 – 0.2.1-rc.1 → v1 内联形状**：5 个角色委派行直接内联 persona 与 toolFilter，托管块 1 条声明行。
- **DSH 0.2.1-rc.2+ → v2 AgentPreset 形状**：该版本起 dsh-tool-subagent 拒绝内联 persona/toolFilter，插件改用 [presets/maoying/agent.cordis.v2.yml](presets/maoying/agent.cordis.v2.yml)——托管块写 6 条声明行（主编 preset + 大纲师/写手/审校/设定管理员/素材调研员 5 张角色 preset），主编委派行以 `agentPreset` 指向角色 preset，角色的工具面由 preset 里的实体工具行承载（审校只读、考据带联网检索）。
- **角色预设会出现在预设选择器**（宿主对预设没有隐藏机制），name 带「（内部）」标明：日常写作由主编委派自动选用，不经主编、想单独开一个写手/考据会话时直接选中即可。
- 两种形状的 persona 文本同源逐字一致（[test/composition.test.mjs](test/composition.test.mjs) 逐字节把关）；宿主版本完全未知（五级探针全败）时不写声明行、预设文件照落走 partial 自愈，绝不把可能已 ≥0.2.1-rc.2 的宿主声明成 v1 内联（下次启动版本可读时自动补写）。
- ≤0.1.6 的目录扫描轨道：不做（宿主已淘汰）。

## 许可

[MIT](LICENSE) © 2026 lifangjin

## 致谢

- 「毛颖」得名于韩愈《毛颖传》：毛笔拟人，有封地有爵位。
