# 毛颖创作台（Web 面板）设计 · v1

三期交付：DSH Web 左侧栏「毛颖创作台」入口 + 会话中栏全页面板 + `/api/maoying/*` 路由。机制与实现全部原创。

## 0. 定位与边界

面板管**可视化、状态，以及作者本人的稿件编辑**：小说内容的生产仍归主编（agent）与作者在编辑器/共创流程里协作，面板负责「一眼看清全局 + 状态快捷流转」，同时给作者本人一个带护栏的正文/章纲编辑入口（textarea + 手动保存 + hash 旧版检测，见 §2 的 `chapter-save` / `outline-save`）。agent 的创作边界不变：共创模式下 agent 依旧不得碰 author 章节的正文（spec §作者稿圣域）——面板编辑是**人**用的刀，不是给 agent 开的新通道。

## 1. 包接线（单包形态，不建子包）

- `package.json`：
  - `main` 不变（index.mjs，Node 侧 = 安装器 + 创作台路由）；
  - 新增 `exports["./client"]`: `"./lib/client.js"`；
  - 新增 `dsh.client`: `{ platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-connection"] }`；
  - `files` 补 `lib/`（已含）。
- cordis.patch.yml 不变（bundle insert 已挂主包）。
- 浏览器 bundle：`window.__ModuleLoader__.load({ id, factory })`，**id 从 currentScript.src 动态解析**（`/\/plugins\/([^/]+)\/client\.js/` 首段），解析不到回退 `'dsh-maoying'`——宿主合并 bundle 下 currentScript 是唯一可靠线索（踩坑教训：宿主合并 bundle 下 id 不可写死）。
- factory 内 `require('react')` + `require('@deepseek-ai/dsh-client-ui-primitives')`；图标做跨版本兜底可简化：只用 Regular 系（0.1.7+ 命名），旧宿主（≤0.1.6）不承诺。
- CSS：`lib/base.css` 独立文件，Node 侧 `GET /api/maoying/client.css` 现读下发（no-cache），客户端首次物化幂等注入 `<link data-plugin-css="maoying-creator/base">`——改样式无需重启，GUI 刷新即生效。设计令牌用 `--dsw-alias-*`，深色主题随 `body[data-ds-dark-theme]` 自动跟随。

## 2. Node 侧：/api/maoying/* 路由

注册形态：

```js
export const inject = ['webServer', 'workspaceRegistry']   // webRuntime 经 ctx.get 读，不进 inject
webServer.register({ kind: 'prefix', path: '/api/maoying', handler: async (req, res) => {...} })
```

- **信任围栏**：isTrustedApiRequest 信任围栏（Host 回环或 webRuntime.trustedHosts + 拒 cross-site + origin 同源校验），403 走 `{ error: 'forbidden' }`。读取 trustedHosts 每请求实时 `ctx.get('webRuntime')?.trustedHosts ?? []`，自捕不抛。
- duplicate prefix route 短重试（8 次 × 30ms）。
- 所有响应 JSON；错误形状统一 `{ ok: false, error }`（读路由可省 ok，直接 `{ error }` + 状态码）。
- **路径安全**：凡是带 `path` 参数的请求，必须 resolve 后与 workspaceRegistry 列出的某个 workspace root **严格相等**（不做子路径、不做 ~ 展开）；novel 目录恒为 `<root>/novel`，file 参数 basename 化 + 规范化后必须落在 novel 根内（防穿越）。不满足一律 403。
- 全程 try/catch，路由崩溃不弄死宿主；注册失败只 warn（安装器语义不变）。

### 路由清单

| 路由 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `client.css` | GET | — | text/css（lib/base.css 现读，no-cache） |
| `update-check` | GET | — | `{ ok, current, latest, updateAvailable, releaseUrl, checkedAt, error, source }`——新版检测（npm registry → npmmirror → GitHub 三级源，1h 缓存 + 7 天 stale-if-error，全败静默降级为 latest=null / error 非空） |
| `self-update` | POST | — | `{ ok: true, kind: 'installed', from, to, restartRequired: true }` / `{ ok: true, kind: 'up-to-date', from }` 或 `{ ok: false, kind, error }`——面板内一键升级：安装形态 + profile 就绪预检 + 版本预检（registry 失败再 mirror，拿不到 latest 不动手）通过后，在 profile 目录里直跑 `pnpm add dsh-maoying@<精确版本>`（pnpm 候选链逐个 spawn：裸 pnpm → corepack pnpm → homebrew / node@XX keg-only / execPath 同目录 corepack → PNPM_HOME 落位，仅 ENOENT 换下一路；180s 超时）。仅支持 `<dshHome>/profiles/<profile>/node_modules/dsh-maoying` 真实目录安装；symlink/dev 检出（dev-link）、非 profile 布局（unsupported-layout）、profile 未初始化（profile-missing）、拿不到最新版（no-target）、pnpm 缺失（pnpm-missing，message 带手动出路）、超时（timeout）、pnpm 非零退出（nonzero）一律 200 + ok:false。**装完只换磁盘包，运行中进程仍是旧代码，restartRequired 恒 true——重启 DeepSeek 后生效** |
| `host-debug` | GET | — | `{ ok, hostVersion, trace, shape, registry, runtime }`——现场诊断（见下节） |
| `workspaces` | GET | — | `{ ok, workspaces: [{ path, name, hasNovel }] }`——workspaceRegistry.list() 逐根探测 `<root>/novel/project.yml` |
| `state` | GET | `path=<root>` | 全量快照（见 §3 契约） |
| `check` | GET | `path=<root>` | `{ ok, problems: [{ level, file, message }] }`——静态体检：与 CLI check 同源的 checkProject，读章节 frontmatter 原文（快照会把越枚举 status 归一成 pending，这里透出原始问题清单；level ∈ error/warn，可为空数组），概览「静态体检」黄条取数 |
| `chapter` | GET | `path`, `file`（chapters/ 下文件名） | `{ ok, file, frontmatter, body, hash, outline }`——正文全文 + 原文 sha256 指纹（正文编辑保存 `chapter-save` 的 `base_hash` 基线）+ 对应章纲（`{ file, words, body, hash }`，outlines/ 无对应文件时 null，hash 同为章纲编辑保存的基线），章节阅读页用 |
| `outline` | GET | `path`, `file`（outlines/ 下 vXX-cXXX 命名的文件名） | `{ ok, file, words, body }`——章纲全文（章纲纯 markdown 无 frontmatter，body 即原文，words 为 CJK 计数），章节 tab 的章纲弹层用；非章纲文件名 422、章纲不存在 404 |
| `style` | GET | `path=<root>` | `{ ok, found, text, hash, template }`——写作风格基准 novel/style.md 全文 + sha256 指纹（hash 为 style-save `base_hash` 的基线）；`found: false` = 文件尚未创建（常态非错误，text/hash 为 null，不回 404）；`template` 恒为插件内置默认基线（templates/novel/style.md）全文，读不到为 null（客户端据此禁用「用默认基线创建」） |
| `chapter-status` | POST | `{ path, file, status }` | `{ ok }`——frontmatter status 行原地替换；status 必须 ∈ pending/writing/review/accepted |
| `chapter-create` | POST | `{ path, file }`（outlines/ 下章纲文件名） | `{ ok, file, title }`——从章纲建章：chapters/ 落同 stem 的 status=pending 空章节（frontmatter 按 chapters/vXX-cXXX.md 模板，summary 与五维留空、正文待写；title 取章纲首条 `#` 标题行、去结尾「章纲」后缀），建后走既有 pending 流转；目标章节已存在 409、章纲不存在 404、非章纲文件名 422 |
| `foreshadow-status` | POST | `{ path, id, status }` | `{ ok }`——foreshadows.yml 对应条目 status 行替换；∈ planted/progressing/resolved/abandoned |
| `phase` | POST | `{ path, phase }` | `{ ok }`——project.yml phase 行替换；七态枚举 |
| `project-save` | POST | `{ path, values, base_hash? }`（values 为 8 平键 title/author/genre/length/language/phase/mode/description；base_hash 为表单载入时的 project.yml 指纹，即快照 `project_hash`） | `{ ok, project_hash }`——mutateProject 逐键改写保行尾注释、缺键按模板补齐；phase/mode 越枚举与空书名 422；base_hash 与写入前现读原文不一致 → 409「外部修改冲突」拒写不落盘（人工改动保护：表单载入后文件被作者/agent 改过即拒绝静默覆盖；缺省 base_hash 跳过检查，兼容旧调用方）。project_hash 为写后新指纹，客户端可作下一轮基线 |
| `style-save` | POST | `{ path, text, base_hash? }`（text 为 style.md 全文；base_hash 为编辑器载入时的 style.md 指纹，即 `style` 路由的 `hash`） | `{ ok, hash }`——style.md 整文件覆写：纯 markdown 基准文档、无行级键位可言，整文件替换即最小手术（写前读、原子写，与 agent 的写法兼容）；text 非 string 422，空文本允许保存（空文件 = 无基准，agent 侧优雅降级）；base_hash 与写入前现读原文不一致 → 409「外部修改冲突」拒写不落盘（人工改动保护，与 project-save 同口径；文件不存在且带 base_hash 同样 409；缺省 base_hash 跳过检查 = 创建路径）。hash 为写后新指纹，客户端作下一轮基线 |
| `chapter-save` | POST | `{ path, file, body, base_hash? }`（file 为 chapters/ 下文件名；body 为正文全文；base_hash 为进入编辑态时 `chapter` 路由的 `hash`） | `{ ok, hash }`——正文整段替换：frontmatter 围栏（含闭合行）之前逐字节保留、围栏后整段替换（正文是自由形态文本，无行级键位可手术，整段替换即最小干预，对 git diff 的扰动天然只落在正文段内）；body 非 string / 章节缺 frontmatter 围栏 422、章节不存在 404、穿越 403；正文末尾无换行补一个 `\n`；base_hash 与写入前现读原文不一致 → 409「章节文件已被外部修改…」拒写不落盘（人工改动保护，与 project-save 同口径；缺省 base_hash 跳过检查，兼容旧调用方）。hash 为写后新指纹，客户端作下一轮基线 |
| `outline-save` | POST | `{ path, file, body, base_hash? }`（file 为章节文件名或 stem，目标恒为 outlines/ 下同 stem 章纲；body 为章纲全文；base_hash 为章纲载入时的指纹，即 `chapter` 路由的 `outline.hash`） | `{ ok, hash }`——章纲整文件替换：纯 markdown 无 frontmatter（spec §outlines），整文件替换即最小手术（与 style-save 同一判断）；body 非 string / stem 不合 vXX-cXXX 规范 422、章纲不存在 404（面板不新建章纲文件）、穿越 403；base_hash 检测同上 → 409「章纲文件已被外部修改…」拒写不落盘。hash 为写后新指纹，客户端作下一轮基线 |
| `rebuild-index` | POST | `{ path }` | `{ ok, chapters }`——照 CLI index 同一逻辑重建 index.yml |

共 19 条。写操作全部「行级原地替换」：只在 frontmatter/目标 yml 的对应行上做字符串手术，写前读、写后校验（替换计数 ≠1 即 409 拒写并报错），不做整文件重排——把对 git diff 的扰动压到最小，也与 agent 的写法兼容。（`self-update` 是例外：它不碰小说文件，跑的是 pnpm 安装；`chapter-create` 是另一例外：它从章纲落一个全新章节文件，不动任何既有文件的字节；`style-save` 亦是例外：style.md 是纯 markdown 基准文档、无行级键位可言，整文件覆写就是它的最小手术，写前读、原子写；`chapter-save` 亦是例外：正文是自由形态文本，写原语是「frontmatter 围栏定位 + 围栏后整段替换」，围栏（含闭合行）之前逐字节保留；`outline-save` 同理：章纲纯 markdown，整文件替换。）

### host-debug 端点（现场诊断）

用途：面板「有新版不显示 / 形态判定可疑」时现场定位宿主版本读到的是哪一份。响应：

- `hostVersion`：五级探针（argv[1] → 全 argv 扫描 → app.asar / desktop-runtime → Electron API → home 全局兜底）命中的版本；全落空为 null。
- `trace`：每级探针一条轨迹 `{ probe, hit, via?, note? }`，能看到每级看到了什么、为什么落空。
- `shape`：托管块形态判定（v1/v2，读不到宿主版本保守 v1）。
- `registry`：预设注册表内窥（逐 preset 的 broken 激活诊断，尽力而为）。
- `runtime`：argv / execPath / cwd / electron / node。

围栏与脱敏：与所有路由同一信任围栏（回环 + 可信 Host）；出口统一 sanitizeDeep——trace.via、runtime.argv / execPath / cwd 等本机绝对路径一律换 `~`，诊断信息照给、路径不出门。

## 3. state 快照契约（前后端共同遵守，字段名冻结）

```jsonc
{
  "ok": true,
  "root": "<workspace root>",
  "novelDir": "<root>/novel",
  "found": true,                          // false 时其余字段缺省，面板显示「未初始化」引导
  "project_hash": "9f86d0…",              // sha256(project.yml 原文) hex——面板保存回传 project-save 的 base_hash 做旧版检测（人工改动保护），读不到为 null；found:false 时恒为 null
  "project": { "title","author","genre","length","language","phase","mode","description" },  // mode: ai-draft|co-write|author-draft（五期）
  "chapters": [{ "file","volume","num","title","status","words","summary",
                 "cognitive_frame","emotional_anchor","world_texture",
                 "suspense","interpersonal_tension" }],     // 按 volume,num 升序；words 为 CJK 计数
  "volumes": [{ "id","title","summary","chapters" }],        // volumes.yml 分卷规划原样；chapters 为 001-020 计划范围串，非章节清单
  "characters": [{ "file","name","age","gender","role","appearance","personality",
                   "background","motivation","arc","markers" }], // markers 数组，缺省 []
  "relations": [{ "a","b","type","description","intensity","started","ended" }], // a/b：relations.yml 里是角色 slug，出快照时对得上角色卡的端点归一成 name（关系图按 name 找节点），对不上原样保留
  "foreshadows": [{ "id","title","status","priority","planted_chapter",
                    "expected_resolve","resolved_chapter","notes","source" }], // source: plan|backfill，缺省 plan
  "timeline": [{ "year","title","description","importance","chapter" }],
  "memories": [{ "category","content","source_chapter" }],
  "clues": [{ "kind","content","related_chapter","resolved" }],
  "world": [{ "file","category","tags","name","description" }],
  "science": [{ "file","label","name","description","references" }],
  "research": [{ "file","topic","sources","description" }],  // sources 为 frontmatter sources 的 URL 数组，description 为笔记正文
  "outlines": [{ "file","chapter","words","excerpt" }],  // outlines/ 章纲清单，chapter 为对应章节文件名，excerpt 为章纲节选（前 120 字，面板按单写作区块用），无章纲的章不列
  "totals": { "chapters": 12, "words": 38412,
              "byStatus": { "pending": 3, "writing": 2, "review": 1, "accepted": 6 } },
  "generatedAt": "2026-10-19T…Z"
}
```

解析层：`lib/panel-core.mjs` 新建，**与 CLI 共享**——把 bin/maoying.mjs 里的 frontmatter 解析 / CJK 计数 / collectChapters / index.yml 重建抽到 `lib/novel-parse.mjs`，CLI 与面板都 import（CLI 行为零变化，改动后跑一遍 CLI 验收）。YAML 解析走 index.mjs 现有 loadYamlLib（dsh home 的 yaml 包），不可用时回退：frontmatter 用正则平键解析，数组 yml 用「条目块 + 平键」极简解析（顶层只允许数组或平键——数据规范本来就禁深嵌套），解析不了的条目跳过并记 `warnings`。
所有实体字段缺省为 null/[]，绝不让一个坏文件炸掉整个快照；坏文件进 `warnings: ["<file>: <原因>"]`，面板顶部黄条显示。

## 4. 浏览器侧：面板结构

挂载：
- 左侧栏底部动作位入口「毛颖创作台」（sidebar.footer.action 键控槽，ctx.effect 注入 + MutationObserver 自愈）；
- 会话中栏全页 overlay：`html[data-dsh-maoying-active]` 驱动，`dsh-panel-activate` 事件与 mnemon/taskboard/ssh 等全页面板互斥，点侧栏会话行自动关闭；
- 顶部工作区选择器（workspaces 路由取数，hasNovel 的排前；无 novel 工作区显示引导卡：一句 `maoying init` 提示 + 复制按钮）。面板懒挂载、关闭不卸载，故每次打开都借 `dsh-panel-activate` 广播重拉一次 workspaces——外部新建/删除的工作区重开即见。

九个 tab（顺序即默认排布）：

1. **概览**：project 卡（书名大字 + 类型/篇幅/语言 pills + 阶段徽章 + 简介，卡右上「编辑」按钮展开书稿元信息表单——原「小说设置」tab 并入，见 §4.1「小说设置并入概览」条目）；统计卡（总字数/章节数/状态分布条）；最近更新（chapters 按 mtime 前 5）；warnings 黄条；静态体检黄条（check 路由问题清单，见 §4.1「人工改动保护 + 静态体检黄条」（0.1.14）条目）。
2. **章节**：表格（卷-章/标题/状态徽章/字数/梗概），状态筛选 pills；表格上方「按单写作」区块——有章纲且 status=pending 的章按序列出（章纲节选 + 状态徽章），未建章的孤儿章纲照列（「未建章」徽章 + 「建章」一键：POST chapter-create 落 pending 空章并重拉快照；行点击开章纲全文弹层，0.1.15 起），共创模式的主工作清单；行点击开整页阅读视图（0.1.12 起替代原右侧抽屉——fixed 侧弹层会被 DSH 侧边栏遮挡）：返回按钮 + GET chapter 正文 + 章纲对照栏（左右分栏或折叠段）+ 复制文件路径按钮 + 五维字段卡 + 状态流转按钮（当前态 → 下一态一键，pending→writing→review→accepted）；正文与章纲对照栏均可就地编辑保存（textarea + 手动保存，POST chapter-save / outline-save 携 base_hash 409 人工改动检测——frontmatter 围栏逐字节保留，外部改动拒写并放回磁盘最新内容，0.1.19 起）。
3. **角色**：卡墙（姓名/role 徽章四色/年龄性别/性格一句/动机一行），点击看全卡（含 arc/markers/background）。
4. **伏笔**：四列看板（埋设/推进/已回收/弃用），卡片含 priority 色点（high 红/normal 灰/low 淡）、`source: backfill` 的「回填」小徽章（账本回填来的条目，区别于写前规划）、埋设章→预期回收章、notes 全文直显（0.1.10 去掉两行截断）；卡片按钮：推进到下一状态（planted→progressing→resolved；abandoned 只能从看板拖不动、按钮给「弃用」）。列头计数。
5. **关系图**：canvas 力导向图——节点=角色（radius 随出场无关、固定 18px，名字 label 下方），边=relations（intensity 1-5 → 线宽 1-4px，type 标在边中点 hover 显示 description）；拖拽节点、空白处滚轮缩放、双击复位；右上角 ＋/－ 缩放按钮（钳制同滚轮 0.4-2.5）与全屏按钮（Fullscreen API 能力检测，不支持则不渲染；进入全屏走 ResizeObserver 自动重铺）；intensity 缺省 3。角色多于 30 个时只画与 relations 相连的节点，其余进「未入图」列表。
6. **时间线**：垂直轴，importance 1-5 → 点大小/颜色深浅，year 左列右卡片。
7. **设定**：子 tab 三分区切换（世界观/科学设定/资料检索，各带条目计数，仅渲染当前激活分区）——world 按 category 分组列表；science 三色标签（known 绿/extrapolation 黄/hypothesis 紫，标签下 references 链接列表）；research 逐条渲染，空态也常驻可切。
8. **写作风格**：novel/style.md 写作风格基准的查看与编辑——视图态 MdView 渲染全文，卡头「编辑」进整文件编辑态（textarea + 取消/保存，保存 POST style-save 携 base_hash 409 人工改动保护，写后新指纹接下一轮基线）；文件缺失时显示空态卡，可用插件内置默认基线一键预填创建（保存即落盘），空文本允许保存。
9. **索引板**：clues 按 kind 分组（线索/红鲱鱼/推理/疑问，resolved 划线置灰）+ memories 按 category 分组（promise 类高亮）。

状态徽章色（全局统一）：pending 灰 / writing 蓝 / review 橙 / accepted 绿；phase 七态沿用七色 pill。文案全中文、禁 emoji 图标（用 ui-primitives 图标或纯 CSS）。

## 4.1 后续迭代记录（0.1.10 起）

- **MaskPortal**：抽屉/弹层统一 portal 到 `document.body`——面板容器挂在宿主会话中栏，中栏 transform/overflow 会把 `position: fixed` 劫持成相对自身并连同裁剪（桌面端「点了没反应」实测病灶）；无 createPortal 的老宿主退回原地渲染。
- **顶栏版本区**：当前版本号常驻；`update-check` 路由（模仿 dsh-paoding：npm registry → npmmirror → GitHub 三级源，1h 缓存 + 7 天 stale-if-error，全败静默）发现新版时亮「有新版 ↗」徽章。
- **系统设置**：齿轮弹窗，字号六档（100/110/120/130/140/150%）——面板根与 portal 节点读同一 `--myt-zoom` 变量整体 zoom，localStorage 记忆。
- **界面语言**：系统设置可选中文/English——全部 UI 文案走 `I18N` 词典（zh/en 各 258 条，`tt`/`tf` 取词 + `{x}` 插值，zh 值与历史硬编码逐字一致保证中文界面零回归），切换立即生效整树重渲并 localStorage 记忆；语言自称（中文/日本語）与侧栏入口品牌名不翻译。
- **Markdown 渲染**：零依赖渲染器（先整体转义再变换），章纲对照与世界观/科学设定描述不再裸显 md 源码；正文手稿仍走 pre。
- **章节整页阅读**：替代右侧抽屉（侧边栏遮挡问题），返回按钮 + 章纲对照 + 五维 + 状态流转原位保留；阅读态隐藏 tab 条。
- **小说设置 tab**（第 9 个）：project.yml 平键表单化编辑，`POST project-save` → `mutateProject` 逐键改写保行尾注释、缺键按模板补齐、phase/mode 越枚举与空书名 422。
- **字号六档改百分比**（0.1.13）：档位从中文名（小/标准/大…）改为 100/110/120/130/140/150% 直读，旧 localStorage 档位值回落 100%。
- **人工改动保护 + 静态体检黄条**（0.1.14）：快照顶层新增 `project_hash`（project.yml 原文 sha256，读不到为 null）——小说设置保存回传 `base_hash`，表单载入后 project.yml 被作者手改或 agent（如 mutatePhase 推进 phase）动过时 `project-save` 409 拒写并报「外部修改冲突」，客户端重拉快照把表单放回磁盘真值，不再静默覆盖同名键丢人工改动；概览新增「静态体检」黄条（GET `check`，与 CLI check 同源的 checkProject，透出快照归一掩盖的越枚举等问题，含 error 级时整条转错误色）。路由 11 → 12 条；I18N zh/en 各 209 → 211 条（check.title / check.fullHint）。
- **面板内一键升级**（0.1.14）：`POST self-update`（lib/self-update.mjs，依赖全部可注入）——顶栏新版徽章旁加「一键升级」按钮，安装形态（`<dshHome>/profiles/<profile>/node_modules/dsh-maoying` 真实目录，symlink/dev 检出一票否决）与 pnpm 可执行性（PATH → homebrew/pnpm 官方安装位候选）双闸通过后跑 `pnpm --dir <profileDir> add dsh-maoying@latest`（180s 超时、无 shell、模块级 in-flight 去重），成功后失效版本检测缓存并提示「已安装 {to}，重启 DeepSeek 后生效」——**装完只换磁盘包，重启才生效，UI 文案照实说**；安装中按钮禁用（前端该请求超时放宽到 200s），「已安装，待重启」后徽章收起。路由 12 → 13 条；I18N zh/en 各 211 → 219 条（header.upgrade* / toast.selfUpdate.*）。
- **按单写作兼容孤儿章纲**（0.1.15）：章纲先于正文时面板不再零入口——「按单写作」区块在联交（有章纲且 status=pending 的章）之外照列未建章的孤儿章纲（按章纲序保序混排）：「未建章」徽章 + 章纲节选 + 字数 + 两个动作（行点击开章纲全文弹层：MaskPortal + MdView 渲染 GET `outline` 的 body、words 一并显示；「建章」按钮 POST `chapter-create` 在 chapters/ 落 status=pending 空章——frontmatter 按 chapters/vXX-cXXX.md 模板、title 取章纲首条标题行去「章纲」后缀，成功 toast 后重拉快照，新章进表格、走既有 pending 流转，孤儿行按新快照自然消失）；chapters/ 为空而 outlines/ 非空时空态改提示「下方按单写作已列出未建章章纲」。路由 13 → 15 条（outline GET / chapter-create POST）；I18N zh/en 各 219 → 230 条（chapters.outlineRowTip / noChapter / createBtn / creating / createTip / emptyWithOutlines、toast.chapterCreated、outline.modalAria / closeAria / loading / loadFailed）。
- **小说设置并入概览**（0.1.15）：原第 9 个「小说设置」tab 撤销（八个 tab），改为概览书稿卡右上「编辑」按钮——点击后 hero 卡原位切换为书稿元信息表单（ProjectMetaForm，8 平键 + 取消/保存），保存链路不变（`POST project-save` 携 `base_hash` 409 人工改动保护，成功重拉快照并退出编辑态，取消直接退出不落盘）。路由不变；I18N zh/en 各 230 → 232 条（tabs.settings 移除，overview.edit / overview.editTip / novel.cancel 新增）。
- **role 徽章本地化**（0.1.15）：角色卡墙与全卡弹层的 role 徽章不再直出角色卡 frontmatter 原文——契约四态（`protagonist|antagonist|supporting|minor`）按界面语言出标签（主角/反派/配角/龙套；英文面板 Protagonist/Antagonist/Supporting/Minor），role 是自由文本、契约外取值原样展示不翻译；tone 归色逻辑（roleTone 关键词匹配）不变。I18N zh/en 各 232 → 236 条（role.protagonist / antagonist / supporting / minor）。
- **分卷规划卡 + 考据笔记正文**（0.1.18）：快照顶层新增 `volumes`（volumes.yml 原样：id/title/summary/chapters 计划范围串）——概览新增「分卷规划」卡（有卷才显，卷头 id · 卷名 + 计划范围 tag + 卷定位一句），分卷拍板件在面板有复核位（配合 CLI check 的 phase 阶段就绪判据）；research 快照从只取 topic 扩为 sources + description，设定 tab「资料检索」从标签行改为逐条渲染：topic 标题 + 笔记正文（MdView）+ sources 参考（悬停显全文 URL）。路由不变；I18N zh/en 各 +1 条（overview.volumes）。
- **pnpm 候选链对齐 dsh-paoding**（0.1.18）：修复一键升级「未找到 pnpm」误报。病因（实机验证）：本机 pnpm 由 corepack 管理但未 `corepack enable`，PATH 里没有裸 pnpm，PNPM_HOME 落位也没有——旧版 existsSync+accessSync(X_OK) 文件预筛（PATH 目录扫描 + homebrew/pnpm 官方落位）全落空直接报 pnpm-missing；且 desktop Electron 进程 PATH 可能是 launchd 最小集（实测最小 PATH 下裸 corepack 也 ENOENT），`/opt/homebrew/bin/corepack` 不在，只有 `/opt/homebrew/opt/node@24/bin/corepack` 在盘上。机制照 dsh-paoding tools/lib/upgrade.mjs 对齐：① **spawn ENOENT 探测链**替代文件预筛——逐候选真 spawn，仅 err.code==='ENOENT' 换下一路（EACCES / 超时 / 非零退出是真实运行结果，如实返回不换通道），绝对路径候选才 existsSync 预筛（不存在不浪费 spawn）；新候选链：裸 pnpm → 裸 corepack（+`pnpm` 参数前缀）→ `/opt/homebrew/bin/corepack` → `/opt/homebrew/opt/node@XX/bin/corepack`（readdirSync 过滤 node 前缀目录拼路径，多版本按序全收；目录不存在跳过）→ execPath 同目录 corepack（桌面 Electron 下无用但无害，headless/web profile 有用）→ `~/Library/pnpm`、`~/.local/share/pnpm`。② **升级前版本预检**：fetchLatestFromRegistry(10s) 失败再 fetchLatestFromMirror(10s)，拿不到 latest 不做半截升级（kind: no-target，message 带两路错误）；compareVersions(target, current)<=0 短路 kind: 'up-to-date'（`{ ok: true, kind: 'up-to-date', from }`，前端 toast「已是最新版」后按钮恢复可点、不进已安装态）；装精确版本 `dsh-maoying@<target>` 而非 @latest（避开 pnpm 新鲜度防护 / 镜像 packument 滞后的静默空转）。③ **cwd = profile 目录**（pnpm 操作对象就是它），去掉 --dir。④ profile 目录缺 package.json → 诚实失败 kind: 'profile-missing'。⑤ win32 pnpm/corepack 是 .cmd shim：spawn shell:true（CVE-2024-27980 加固）+ 命令补 .cmd 后缀、参数保持数组；darwin/linux 恒 shell:false。⑥ 子进程输出尾部 2KB → 8KB（合并 stdout+stderr）；全候选 ENOENT 的 pnpm-missing message 带可操作出路：「可先在终端执行 corepack enable 并重启 DSH 后重试；或手动升级：cd <profileDir> && corepack pnpm add dsh-maoying@<目标版本>」，dev-link 的 message 保留 git pull 出路。spawnImpl 契约改 paoding 形状 `(command, args, options, timeoutMs, timeoutLabel) → { code, output, error?, errorCode? }`（缺省 defaultSpawn 合并输出、超时 SIGTERM、5s 宽限后 SIGKILL 兜底、收敛 errorCode 'ETIMEDOUT'）；退出码非零 kind 从 pnpm-failed 更名 nonzero。前端 pnpm-missing 等失败 message 服务端已带出路文案，toast 直显不截断。安全闸（realpath 形态两道闸 / 模块级 in-flight 去重 / 成功后 invalidateVersionCache）与依赖全注入风格不变。路由仍 15 条；I18N zh/en 各 237 → 238 条（toast.selfUpdate.upToDate）。
- **概览补显共创模式**（0.1.18）：书稿卡阶段行 phase pill 后补「共创模式」短标签徽章（悬浮出全称；快照 mode 缺失或越枚举时不显示，老项目无该键不误标）。路由不变；I18N zh/en 各 238 → 241 条（modeShort.aiDraft / coWrite / authorDraft）。
- **一键升级顺带全局 CLI**（0.1.18）：本机常见两份独立安装——desktop profile（`<dshHome>/profiles/desktop/node_modules/dsh-maoying`，一键升级的更新对象）与全局 CLI（`npm i -g` 装的 `<npm 全局>/node_modules/dsh-maoying`，如 `/opt/homebrew/bin/maoying` → `/opt/homebrew/lib/node_modules/dsh-maoying/bin/maoying.mjs`）——只更 profile 会版本偏斜；方案 B：profile 阶段落定（installed 装完 / up-to-date 短路）后跑独立全局阶段，把两份收敛到同一精确版本。**检测**（detectGlobalCli，零 spawn 纯文件系统）：PATH 各目录 + `/opt/homebrew/bin` + `/usr/local/bin` 找 `maoying`（win32 `maoying.cmd`），existsSync 预筛；命中后 realpathSync 该 bin 两级上溯得包根（`bin/maoying.mjs` → 包根），包根 package.json 的 name 必须是 `dsh-maoying` 才认（防怪链接）；包根 realpath 落在本 profile 目录内（如 profile 自带 `.bin/maoying`）→ 不算全局，跳过该候选继续找；全落空 → 不 spawn。**更新**走 npm 候选链（与 pnpm 链同款 spawn ENOENT 探测）：裸 npm → execPath 同目录 → `/opt/homebrew/bin` → `/usr/local/bin` → `/opt/homebrew/opt/node@XX/bin`，spawn `npm i -g dsh-maoying@<target>`（cwd=os.tmpdir()、独立 120s 超时，profile pnpm 仍 180s）。**返回形状**：成功对象新增 `globalCli` 字段——`{ ok: true, skipped: 'missing' }`（没装全局，跳过）/ `{ ok: true, skipped: 'same', version }`（已同版）/ `{ ok: true, from, to }` / `{ ok: false, error, output? }`（error 中文、含手动出路 `npm i -g dsh-maoying@<target>`）——**全局失败不拖累 profile 安装**：整体仍 ok:true，重启照常生效，失败如实透出；dev-link / unsupported-layout / no-target / profile-missing 等失败路径维持整单拒绝，不碰全局。路由把 globalCli 原样透传（up-to-date 与 installed 两个成功分支）。前端成功 toast 主文案不变、按 globalCli 拼第二句（missing / same 不提零噪音，真更新了显「全局 maoying CLI a → b」，失败如实报错），up-to-date 分支同样拼接，toast 文本容器加 `white-space: pre-line` 承接换行；self-update 请求前端超时 200s → 340s（180 + 120 + 40 余量）。路由不变；I18N zh/en 各 241 → 243 条（toast.selfUpdate.globalOk / globalFail）。
- **写作风格 tab**（0.1.19）：novel/style.md 写作风格基准（0.1.18 落的数据文件与四角色加载纪律）在面板有了入口——设定与索引板之间新增「写作风格」tab：视图态 MdView 渲染全文，卡头「编辑」进整文件编辑态（textarea + 取消/保存；保存 POST `style-save` 携 base_hash，409 人工改动保护链路照 ProjectMetaForm——成功接写后新指纹防连续保存假冲突，409 重拉磁盘真值把编辑器原地重置、停留编辑态让用户自行取舍）；文件缺失时空态卡「用默认基线创建」——插件模板（templates/novel/style.md）预填编辑态、保存即创建（模板读不到时按钮禁用）；空文本允许保存（空文件 = 无基准，agent 侧优雅降级），挂载/换工作区按需拉取 GET `style`（请求序号防过期响应）。路由 15 → 17 条（style GET / style-save POST）；I18N zh/en 各 243 → 250 条（tabs.style / style.note / style.editTip / style.empty / style.createFromTpl / style.loadFailed / toast.styleSaved）；九个 tab。
- **正文/章纲面板编辑**（0.1.19）：作者本人直接在面板写章节正文与章纲——章节阅读页「编辑」进正文编辑态（textarea + 取消/保存，无自动保存），章纲对照栏卡头「编辑」进章纲编辑态；保存 POST `chapter-save` / `outline-save`：正文写原语是「frontmatter 围栏定位 + 围栏后整段替换」（正文自由形态无行级键位可手术，围栏含闭合行之前逐字节保留），章纲纯 markdown 整文件替换；`GET chapter` 出参补顶层 hash 与 outline.hash（保存响应接写后新指纹作下一轮基线，防连续保存假冲突），base_hash 与写入前现读不一致 → 409 拒写不落盘（人工改动保护链路照 StyleTab：草稿丢弃、重拉磁盘真值放回编辑器，正文末尾无换行自动补齐；缺围栏/坏 stem 422、章纲不存在 404——面板不新建章纲文件、穿越 403）；切章自动退出编辑态清草稿，防 A 章文字写进 B 章。路由 17 → 19 条（chapter-save / outline-save POST）；I18N zh/en 各 250 → 258 条（reader.edit / reader.editTip / reader.save / reader.bodyEditHint / outline.editTip / outline.editHint / toast.chapterSaved / toast.outlineSaved）；顶栏副标题与 README 的「只读正文」边界声明同步改写（spec §作者稿圣域不变——面板编辑是给人用的刀，agent 的圣域规则原样）。
- **设定 tab 改子 tab 展示**（0.1.19）：设定 tab 内世界观/科学设定/资料检索三张卡从纵向堆叠改为子 tab 条切换（各带条目计数，仅渲染当前激活分区）；research 空时原实现整卡隐藏，现子 tab 恒在、空态文案常驻可切。路由不变；I18N zh/en 各 258 → 260 条（world.researchEmpty / world.subTabsAria）。
- **关系图工具角标**（0.1.19）：关系图右上角新增工具条——＋/－ 缩放按钮（步进 ×1.25 / ÷1.25，钳制与滚轮同口径 0.4-2.5；React 按钮够不着绘图 effect 闭包里的 sim，经 zoomApiRef 桥调用，effect 清理时置 null 防旧闭包误触）与全屏切换按钮（Fullscreen API 能力检测——wrap 有 requestFullscreen/webkitRequestFullscreen 且 document.fullscreenEnabled 非假才渲染，否则不占位；监听 fullscreenchange/webkitfullscreenchange 同步「全屏/退出全屏」文案，浏览器 ESC 退出也跟上；进/出全屏 wrap 尺寸变化走既有 ResizeObserver 自动 resize 重铺 canvas，Chromium UA 全屏样式覆盖 480px 定高）。纯前端，路由不变；I18N zh/en 各 260 → 264 条（relations.zoomIn / zoomOut / fs / exitFs），relations.help 文案同步更新（提缩放按钮与右上角全屏）。

## 5. 验收基线

- Node 侧：临时 workspace（/tmp）+ 假 workspaceRegistry 不行——路由从 ctx.workspaceRegistry 取；单测直接 import lib/panel-core.mjs 的函数（parseStateSnapshot / mutateChapterStatus / mutateForeshadowStatus / mutatePhase / rebuildIndex）跑断言；路由层用 node 起一个最小 ctx 假件（webServer.register 收集 handler，workspaceRegistry 返回临时 root）模拟请求验证围栏 403 / 状态流转 / 防穿越。
- 浏览器侧：`node --check` 不适用（browser bundle 用 var/require factory 语法）——冒烟脚本 `npm run smoke`（scripts/smoke-client.mjs，零依赖）已落地：new Function 包裹整份源码做编译检查 → stub window/document 求值截获 `__ModuleLoader__.load` → factory 传 react/UI 原语 stub 求值，断言导出面 `{ inject: ["slots"], apply }` 与 slots 注入 / disposer 折返语义。CI（Node 18/20/22 矩阵）与 `npm test` 同跑；真浏览器验收仍由用户重启后做。
- 不写死任何真实路径；测试全在 /tmp；真实 ~/.dsh 不碰。
