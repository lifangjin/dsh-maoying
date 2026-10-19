# dsh-maoying（毛颖）

毛颖者，笔也——韩愈作《毛颖传》，把一支毛笔写成有封地有爵位的臣子。dsh-maoying 把这支笔装进 DSH（DeepSeek Harness）：**一支管着一班帮手、守着一摞书稿的毛笔**——网文创作辅助插件，功能概念改写自 [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen)（GPL-3.0，只借鉴功能概念，未使用其任何代码），全部实现原创，MIT 发布。

装上之后，主 agent 变身**网文主编（创作总监）**：带七阶段工作流与六步写作法，把大纲、正文、审校、设定维护、素材考据分别委派给五个只带本行工具的帮手；整部小说就是工作区里的 `novel/` 结构化 markdown/YAML 目录（角色卡、伏笔状态机、时间线、线索板、叙事记忆）——agent 直接读写文件，**没有数据库，没有 API 层**。查「所有未回收伏笔」就是 grep 一行。

## 功能特性

- **主编 + 五帮手**：主 agent 当主编，只做规划、衔接、验收、状态推进；大纲师（outline）、写手（write）、审校（review）、设定管理员（lore）、素材调研员（research）各带本行工具随叫随到。找文件、查伏笔状态这类顺手小事主编自己 glob/grep 就办，不绕委派。
- **novel/ 文件数据库**：角色卡、世界观、科学设定三色标注、关系图、伏笔账本、时间线、叙事记忆、线索板，全部是 grep 友好的平键/顶层数组 YAML——人可直接改，git 可版本化，无迁移无运维。
- **七阶段工作流**：idea 选题 → setting 设定 → outline 大纲 → writing 写作 → review 审阅 → consistency 一致性 → export 导出。阶段记在 project.yml 的 phase 键，每完成一个里程碑主编推进并简报。
- **Writing 六步法**：衔接检查 → 出大纲 → 写正文 → 审稿 → 修改 → 定稿维护，逐章循环；配合 Collab 四步共创（设定共创 → 分卷规划 → 黄金三章 → 交接循环）把新书从零带到滚动更新。
- **伏笔状态机**：planted（埋设）→ progressing（推进）→ resolved（回收）/ abandoned（弃用），埋设与回收记章节号、预期回收章节排期、优先级分档——长篇不断线，活跃伏笔超 15 条主编主动提醒清理。
- **上下文按需取**：主编先读 index.yml 概览，写到哪章读哪章（前章结尾约 1500 字 + 该章大纲 + 出场角色卡 + 活跃伏笔节选），不把整本书塞进上下文。
- **工具面收窄**：主编只见「角色委派 + 内部检索 + 协调」白名单，帮手各带本行工具（审校只读、考据只带联网+落笔记）；每次请求的工具开销与上下文占用随之下降。
- **素材考据**：research 帮手联网检索历史/地理/专业领域素材，笔记落 `novel/research/`，区分史实/通说/演义并附来源——mythpen 没有的能力，DSH 架构的红利。
- **CLI 兜底**：`maoying init / stats / index` 三条零依赖命令管脚手架、字数统计与章节概览重建。

## 快速开始

前置：**Node.js ≥ 18**、已装好的 DSH host（**0.1.7 – 0.2.1-rc.1**，见「兼容面」）。

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

## novel/ 数据规范

`novel/` 目录是整个插件的数据库：project.yml（元信息与七阶段 phase）、volumes.yml、chapters/（frontmatter 五维叙事字段 + 正文）、characters/（角色卡）、world/、science/（三色设定）、relations.yml、foreshadows.yml（伏笔状态机）、timeline.yml、memories.yml（含出场记录与承诺账）、clue-board.yml、research/、exports/。全部格式、示例与设计理由见：

- 速查版：项目初始化后的 `novel/README.md`（模板源 [templates/novel/README.md](templates/novel/README.md)）
- 完整版：[docs/spec.md](docs/spec.md)（为什么不用 SQLite、五维字段定义、伏笔状态机语义、出场记录约定）

## CLI

```bash
maoying init [dir]     # 生成 novel/ 脚手架（默认 ./novel；已存在文件一律跳过，绝不覆盖）
maoying stats [dir]    # 逐章 CJK 字数、状态分布、当前 phase
maoying index [dir]    # 从 volumes.yml + chapters/ 重建 index.yml（派生文件）
```

零依赖（node:fs/path/url），任意 cwd 可用；npm 全局安装或 `pnpm link` 后可直接 `maoying` 调用，否则 `node <插件目录>/bin/maoying.mjs` 等价。日常写作中 index.yml 由设定管理员直接重建，CLI 主要给人用。

## 卸载

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/.agent-presets/maoying"
```

宿主是 DSH 0.1.7+ 时再补一步：删去 `~/.dsh/cordis.patch.yml` 里的 dsh-maoying 托管块（`# --- dsh-maoying preset managed (auto-generated; do not edit) ---` 到 `# --- end dsh-maoying preset managed ---` 之间的整段，含两行标记），免得留下指向已删目录的声明行。`novel/` 目录是你的书稿，卸载插件不会动它。

## 兼容面

- **支持：DSH 0.1.7 – 0.2.1-rc.1**——patch 声明行 + 内联 persona/toolFilter 委派行形状。
- **0.2.1-rc.2+**：dsh-tool-subagent 拒绝内联 persona/toolFilter，须换代为 AgentPreset 形态——二期适配；插件启动时会检测宿主版本并 warn 提醒。
- ≤0.1.6 的目录扫描轨道：不做（宿主已淘汰）。

## 许可

[MIT](LICENSE) © 2026 lifangjin

## 致谢

- 功能概念改写自 [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen)（GPL-3.0）：七阶段工作流、六步写作法、共创流程、五维叙事字段、伏笔/时间线/线索板的数据模型思路。**未使用其任何代码与 prompt 文本**，本仓库全部实现原创。
- 编排机制（bundle patch 挂载、预设启动安装器、托管块手术、工具面收窄）参考同作者 [lifangjin/dsh-paoding](https://github.com/lifangjin/dsh-paoding)（MIT）的已验证路径。
- 「毛颖」得名于韩愈《毛颖传》，与庖丁（dsh-paoding，典出《庄子》）同一命名脉络。
