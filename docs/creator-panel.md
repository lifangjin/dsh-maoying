# 毛颖创作台（Web 面板）设计 · v1

三期交付：DSH Web 左侧栏「毛颖创作台」入口 + 会话中栏全页面板 + `/api/maoying/*` 路由。机制与实现全部原创。

## 0. 定位与边界

面板管**可视化、状态，以及作者本人的稿件编辑**：小说内容的生产仍归主编（agent）与作者在编辑器/共创流程里协作，面板负责「一眼看清全局 + 状态快捷流转」，同时给作者本人一个带护栏的正文/章纲编辑入口（正文 textarea 自动保存、章纲手动保存 + hash 旧版检测，见 §2 的 `chapter-save` / `outline-save`；正文自动保存见 §4.1「正文编辑直开 + 自动保存 + 段首缩进」条目）。0.1.20 起（§4.1「全量可编辑写面」）六本账本 yml、四目录实体卡 md 与章纲新建也开放人工编辑，编辑纪律统一为「保存时结构校验（解析失败/缺围栏 422 拒存）+ 保存后语义体检（`check`）+ git 回滚兜底」——语义规则（状态机、必填章号等）是 agent 纪律不是人工禁区，但写面只服务人。agent 的创作边界不变：共创模式下 agent 依旧不得碰 author 章节的正文（spec §作者稿圣域）——面板编辑是**人**用的刀，不是给 agent 开的新通道。

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

- **信任围栏**：isTrustedApiRequest 信任围栏（Host 回环或 webRuntime.trustedHosts + 拒 cross-site + origin 同源校验），403 走 `{ ok: false, error: 'forbidden' }`（错误形状与全局契约同形，客户端形状检查不必对这一条网开一面）。读取 trustedHosts 每请求实时 `ctx.get('webRuntime')?.trustedHosts ?? []`，自捕不抛。
- duplicate prefix route 短重试（8 次 × 30ms）。
- **路由随纤维注销**（0.1.23）：register 返回的 disposer 由 apply 挂接 `ctx.effect`——宿主对 `<home>/cordis.patch.yml` 与 profile 级 patch 都有 HMR 热重载（版本升级重写托管块即触发），插件纤维整树重建时路由必须随之出表；否则残留死 handler（inactive context）且新注册被 duplicate 挡住，面板全接口 500。注册完成时纤维已销毁（effect 抛 INACTIVE_EFFECT）则立即手动注销堵竞态窗口。
- 所有响应 JSON；错误形状统一 `{ ok: false, error }`（读路由可省 ok，直接 `{ error }` + 状态码）。
- **路径安全**：凡是带 `path` 参数的请求，必须 resolve 后与 workspaceRegistry 列出的某个 workspace root **严格相等**（不做子路径、不做 ~ 展开）；novel 目录恒为 `<root>/novel`，file 参数 basename 化 + 规范化后必须落在 novel 根内（防穿越）。不满足一律 403。
- 全程 try/catch，路由崩溃不弄死宿主；注册失败只 warn（安装器语义不变）。

### 路由清单

| 路由 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `client.css` | GET | — | text/css（lib/base.css 现读，no-cache） |
| `update-check` | GET | `fresh=1`（可选） | `{ ok, current, latest, updateAvailable, releaseUrl, checkedAt, error, source }`——新版检测（npm registry → npmmirror → GitHub 三级源，1h 缓存 + 7 天 stale-if-error，全败静默降级为 latest=null / error 非空）；`fresh=1` 为手动检测：绕过 1h 缓存强制现测（getVersionInfo `force`，in-flight 已在跑则复用——它本就是缓存失效后的新检测），超时由 3s 放宽到 10s（用户在前端等结果） |
| `self-update` | POST | — | `{ ok: true, kind: 'installed', from, to, restartRequired: true }` / `{ ok: true, kind: 'up-to-date', from }` 或 `{ ok: false, kind, error }`——面板内一键升级：安装形态 + profile 就绪预检 + 版本预检（registry 失败再 mirror，拿不到 latest 不动手）通过后，在 profile 目录里直跑 `pnpm add dsh-maoying@<精确版本>`（pnpm 候选链逐个 spawn：裸 pnpm → corepack pnpm → homebrew / node@XX keg-only / execPath 同目录 corepack → PNPM_HOME 落位，仅 ENOENT 换下一路；180s 超时）。仅支持 `<dshHome>/profiles/<profile>/node_modules/dsh-maoying` 真实目录安装；symlink/dev 检出（dev-link）、非 profile 布局（unsupported-layout）、profile 未初始化（profile-missing）、拿不到最新版（no-target）、pnpm 缺失（pnpm-missing，message 带手动出路）、超时（timeout）、pnpm 非零退出（nonzero）、装后对账不符（verify-failed：装完回读安装位 package.json 的 version 与精确目标不一致，message 带手动重装出路）一律 200 + ok:false。**装完只换磁盘包，运行中进程仍是旧代码，restartRequired 恒 true——重启 DeepSeek 后生效** |
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
| `outline-save` | POST | `{ path, file, body, base_hash? }`（file 为章节文件名或 stem，目标恒为 outlines/ 下同 stem 章纲；body 为章纲全文；base_hash 为章纲载入时的指纹，即 `chapter` 路由的 `outline.hash`） | `{ ok, hash }`——章纲整文件替换：纯 markdown 无 frontmatter（spec §outlines），整文件替换即最小手术（与 style-save 同一判断）；body 非 string / stem 不合 vXX-cXXX 规范 422、章纲不存在 404（本路由只覆写不新建，新建走 `file-create`）、穿越 403；base_hash 检测同上 → 409「章纲文件已被外部修改…」拒写不落盘。hash 为写后新指纹，客户端作下一轮基线 |
| `file-source` | GET | `path`, `rel`（受管白名单内的相对路径，见下表） | `{ ok, rel, text, hash }`——受管文件全文 + 原文 sha256 指纹（hash 为 `file-save` 的 `base_hash` 基线，读与指纹同刻同源）；不存在 404、白名单外/穿越 403 |
| `file-save` | POST | `{ path, rel, text, base_hash? }`（text 为文件全文；base_hash 为编辑器载入时 `file-source` 的 `hash`） | `{ ok, rel, hash }`——受管文件整文件覆写：text 非 string 422、结构校验（`validateManagedText`：账本 yml 须解析为条目数组且条目全平键、md 实体卡须带成对围栏；校验先于基线检查）422、文件不存在 404（新建走 `file-create`）、base_hash 过期 → 409「`{rel}` 已被外部修改，请刷新后基于最新内容重改再存」拒写不落盘；尾无换行补一个 `\n`。hash 为写后新指纹 |
| `file-create` | POST | `{ path, rel, text }` | `{ ok, rel, hash }`——新建受管文件（新角色/设定/科学设定卡、新章纲骨架由客户端模板预填）：已存在 409 先到先建绝不覆盖、结构校验同 `file-save`、目录缺席自动创建 |
| `file-delete` | POST | `{ path, rel }` | `{ ok, rel }`——删除受管文件（含 `chapters/` 章节文件——这是它唯一的通用写通道）；不存在 404；服务端不做二次确认，UI 层强制确认弹层 |
| `rebuild-index` | POST | `{ path }` | `{ ok, chapters }`——照 CLI index 同一逻辑重建 index.yml |

### 受管文件白名单（file-* 四路由共用 `managedRelCheck`）

| rel | kind | 读 | 存 | 建 | 删 |
|---|---|---|---|---|---|
| `relations.yml` / `timeline.yml` / `memories.yml` / `clue-board.yml` / `foreshadows.yml` / `volumes.yml` | yml | ✓ | ✓ | — | — |
| `characters/<slug>.md` / `world/<slug>.md` / `science/<slug>.md` / `research/<slug>.md`（slug=`^[a-z0-9][a-z0-9-]*$`） | md | ✓ | ✓ | ✓ | ✓ |
| `outlines/<stem>.md`（stem 复用 chapterSortKey 的 vXX-cXXX） | outline | ✓ | ✓ | ✓（章纲新建） | ✓ |
| `chapters/<vXX-cXXX>.md` | chapter | —（走 `chapter`） | —（走 `chapter-save`） | —（走 `chapter-create`） | ✓ 仅删 |

校验顺序：rel 形状（反斜杠/深层 403、slug/stem 422）→ 白名单外 403（`index.yml` / `project.yml` / `novel/style.md` 有意排除——前两者是核心配置走专用路由，style 有专用 tab）→ resolve 包含双保险（越界 403）。

共 23 条。写操作全部「行级原地替换」：只在 frontmatter/目标 yml 的对应行上做字符串手术，写前读、写后校验（替换计数 ≠1 即 409 拒写并报错），不做整文件重排——把对 git diff 的扰动压到最小，也与 agent 的写法兼容。（`self-update` 是例外：它不碰小说文件，跑的是 pnpm 安装；`chapter-create` 是另一例外：它从章纲落一个全新章节文件，不动任何既有文件的字节；`style-save` 亦是例外：style.md 是纯 markdown 基准文档、无行级键位可言，整文件覆写就是它的最小手术，写前读、原子写；`chapter-save` 亦是例外：正文是自由形态文本，写原语是「frontmatter 围栏定位 + 围栏后整段替换」，围栏（含闭合行）之前逐字节保留；`outline-save` 同理：章纲纯 markdown，整文件替换。0.1.20 的 `file-save` / `file-create` 是最后一批例外：受管账本 yml 与实体卡 md 由人工整文件改写，结构校验（`validateManagedText`）守住「存得进、快照读得出」的形状底线，语义问题交保存后的 `check` 与 git 回滚兜底。）

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
所有实体字段缺省为 null/[]，绝不让一个坏文件炸掉整个快照；坏文件进 `warnings: ["<file>: <原因>"]`，面板顶部黄条显示。yaml 真/降级解析也各有告警不再静默：yaml 包在场但真解析失败时，先记 `"<file>: yaml 解析失败（…），已降级极简解析"` 再降级；极简解析丢弃的零缩进散键行同样挂上文件名并入 warnings。

## 4. 浏览器侧：面板结构

挂载：
- 左侧栏底部动作位入口「毛颖创作台」（sidebar.footer.action 键控槽，ctx.effect 注入 + MutationObserver 自愈）；
- 会话中栏全页 overlay：`html[data-dsh-maoying-active]` 驱动，`dsh-panel-activate` 事件与 mnemon/taskboard/ssh 等全页面板互斥，点侧栏会话行自动关闭；
- 顶部工作区选择器（workspaces 路由取数，hasNovel 的排前；无 novel 工作区显示引导卡：一句 `maoying init` 提示 + 复制按钮）。面板懒挂载、关闭不卸载（React 状态全保留），故每次打开都借 `dsh-panel-activate` 广播三重重拉——workspaces（外部新建/删除的工作区重开即见）、整份 state 快照（CLI / agent 改动的章节与设定重开即最新，无需手点右上角刷新）、阅读页本章正文（经重开序号透传 ChapterReader 静默重拉；编辑中的草稿不受影响，仍只在 409 冲突出口「载入磁盘版」被重置）。

九个 tab（顺序即默认排布）：

1. **概览**：project 卡（书名大字 + 类型/篇幅/语言 pills + 阶段徽章 + 简介，卡右上「编辑」按钮展开书稿元信息表单——原「小说设置」tab 并入，见 §4.1「小说设置并入概览」条目）；统计卡（总字数/章节数/状态分布条）；最近更新（chapters 按 mtime 前 5）；warnings 黄条；静态体检黄条（check 路由问题清单，见 §4.1「人工改动保护 + 静态体检黄条」（0.1.14）条目）；分卷规划卡卡头「编辑源文件」（volumes.yml 整文件编辑弹层，0.1.20 写面）。
2. **章节**：表格（卷-章/标题/状态徽章/字数/梗概），状态筛选 pills；表格上方「按单写作」区块——有章纲且 status=pending 的章按序列出（章纲节选 + 状态徽章），未建章的孤儿章纲照列（「未建章」徽章 + 「建章」一键：POST chapter-create 落 pending 空章并重拉快照；行点击开章纲全文弹层，0.1.15 起），共创模式的主工作清单；行点击开整页阅读视图（0.1.12 起替代原右侧抽屉——fixed 侧弹层会被 DSH 侧边栏遮挡）：返回按钮 + GET chapter 正文 + 章纲对照栏（左右分栏或折叠段）+ 复制文件路径按钮 + 五维字段卡 + 状态流转按钮（当前态 → 下一态一键，pending→writing→review→accepted）；正文与章纲对照栏均可就地编辑保存（POST chapter-save / outline-save 携 base_hash 409 人工改动检测——frontmatter 围栏逐字节保留，外部改动拒写不落盘、草稿保留并亮「载入磁盘版（放弃草稿）/基于最新版重改」两个出口，0.1.19 起、两出口见 §4.1 末条）：正文编辑态自动保存（约 30s 防抖——0.1.22 起 2s、0.1.23 起放宽到 30s 且手动保存同样停留编辑态不清稿；写盘内容即新基线、纯缩进占位不落盘，编辑 hint 常显正文实时 CJK 字数、与服务端全库字数同口径），待写空章节（body 全空白）与写作中（frontmatter status=writing，0.1.25 起）章节打开即直接进编辑态、不再经「编辑」按钮中转，回车换行自动加段首两个全角空格缩进，编辑器排版与只读正文一致（所见即所得）并随内容自动长高；章纲对照栏仍手动保存（textarea + 取消/保存）；0.1.20 写面：无章纲空态加「新建章纲」（outlines/<stem>.md 五件骨架预填）、章纲对照栏卡头「删除章纲」、阅读顶栏「删除章节」——后两者均确认弹层（不可逆，后悔靠 git，check 会标孤儿引用）。
3. **角色**：卡墙（姓名/role 徽章四色/年龄性别/性格一句/动机一行），点击看全卡（含 arc/markers/background）；0.1.20 写面：墙头「新建角色」（模板预填）+ 全卡弹层底部「编辑源文件/删除文件」。
4. **伏笔**：四列看板（埋设/推进/已回收/弃用），卡片含 priority 色点（high 红/normal 灰/low 淡）、`source: backfill` 的「回填」小徽章（账本回填来的条目，区别于写前规划）、埋设章→预期回收章、notes 全文直显（0.1.10 去掉两行截断）；卡片按钮：推进到下一状态（planted→progressing→resolved；abandoned 只能从看板拖不动、按钮给「弃用」）。列头计数；0.1.20 写面：卡头「编辑源文件」（foreshadows.yml）。
5. **关系图**：canvas 力导向图——节点=角色（radius 随出场无关、固定 18px，名字 label 下方），边=relations（intensity 1-5 → 线宽 1-4px，type 标在边中点 hover 显示 description）；节点按角色配色（0.1.20 起）：主角 #f53f3f 红 / 配角 #165dff 蓝 / 反派 #1d2129 黑 / 龙套与未标注 #fadc19 黄（查表 miss 落 minor，全节点恒有色），拖拽固定态统一加粗描边；脚注带四色图例；拖拽节点、空白处滚轮缩放、双击复位；右上角 ＋/－ 缩放按钮（钳制同滚轮 0.4-2.5）与全屏按钮（Fullscreen API 能力检测，不支持则不渲染；进入全屏走 ResizeObserver 自动重铺）；intensity 缺省 3。角色多于 30 个时只画与 relations 相连的节点，其余进「未入图」列表。防重叠（0.1.20 起）：节点最小间距 62 硬碰撞分离（含名字 label 纵向净空，力式斥力之上兜底，弹簧 rest 120→130 配合多留缝隙）；边为二次曲线——按两侧空旷度选朝向（迟滞防抖）绕开途中节点，同一对角色的重复边偏移放大 + 交替朝向互相分开（type 标签随曲线移到 t=0.5 点）；hover 命中按曲线几何采样。0.1.20 写面：卡头「编辑源文件」（relations.yml，空态同样给入口）。
6. **时间线**：垂直轴，importance 1-5 → 点大小/颜色深浅，year 左列右卡片；0.1.20 写面：卡头「编辑源文件」（timeline.yml，空态同样给入口——账本空不等于不可编辑）。
7. **设定**：子 tab 三分区切换（世界观/科学设定/资料检索，各带条目计数，仅渲染当前激活分区）——world 内多分类时二级子 tab 按 category 切换（每 tab 带条目计数，仅渲染激活分类；单分类/无分类平铺直出，见 §4.1「世界观分类二级子 tab」条目）；science 三色标签（known 绿/extrapolation 黄/hypothesis 紫，标签下 references 链接列表）；research 逐条渲染，空态也常驻可切；0.1.20 写面：world/science 组头「新建设定」（模板预填）+ 条目卡「编辑源文件/删除文件」，research 暂无写面入口（快照有卡，入口下轮再议）。
8. **写作风格**：novel/style.md 写作风格基准的查看与编辑——视图态 MdView 渲染全文，卡头「编辑」进整文件编辑态（textarea + 取消/保存，保存 POST style-save 携 base_hash 409 人工改动保护，冲突时草稿保留、亮「载入磁盘版/基于最新版重改」两出口，写后新指纹接下一轮基线）；文件缺失时显示空态卡，可用插件内置默认基线一键预填创建（保存即落盘），空文本允许保存。
9. **索引板**：clues 按 kind 分组（线索/红鲱鱼/推理/疑问，resolved 划线置灰）+ memories 按 category 分组（promise 类高亮）；0.1.20 写面：两卡头「编辑源文件」（clue-board.yml / memories.yml）。

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
- **重开面板即最新内容**（0.1.20）：面板懒挂载、关闭不卸载，React 状态（快照 / 阅读页章节 / tab 位）跨开关全保留，而 state 原本只在 effectiveWs 变化时拉取——同工作区重开显示的是上次会话的旧快照，得手点右上角刷新。现每次打开借 `dsh-panel-activate` 广播（source 过滤不变）三重重拉：workspaces、整份 state 快照（`reload()`，有旧快照时不闪骨架、原地换血）、阅读页本章（PageShell 重开序号 `reopenSeq` 透传 ChapterReader，effect 按序号触发 `loadDetail(file, { silent: editing })`——编辑中 silent 不闪骨架不打断 textarea，阅读态换最新正文）；首次打开广播早于挂载、mount effect 已覆盖首拉，语义不变。编辑草稿纪律不变：loadState 不碰草稿，正文/章纲草稿仍只在 409 冲突重置路径放回磁盘真值。纯前端，路由不变；I18N 不变。
- **关系图节点角色配色**（0.1.20）：canvas 节点按角色卡 role 上色——主角 #f53f3f 红 / 配角 #165dff 蓝 / 反派 #1d2129 黑 / 龙套与未标注 #fadc19 黄（模块常量 NODE_ROLE_COLORS 映射，越枚举/缺省 role 查表 miss 落 minor——全节点恒有色）；拖拽固定态=统一加粗 accent 描边（lineWidth 1.5 → 3，唯一固定指示，不再有半透明填充分支）；脚注 help 文案旁新增四色图例（色点 + 角色名，复用 role.* 既有标签，龙套一并进图例）；顺手删除无调用者的 toScreen（hitNode/hitEdge 走 toWorld，不受影响）。纯前端，路由不变；I18N 键数不变（relations.help zh/en 文案更新）。
- **关系图防重叠**（0.1.20）：canvas 力导向图三处——①硬碰撞分离：step() 速度积分之后按最小间距 62（两节点半径 18×2 + 名字 label 纵向净空）做两轮位置级互推（固定/拖拽节点不动推对方、双固定跳过，位移不写回速度靠阻尼收敛），弹簧 rest 120→130 配合多留缝隙，节点永不压叠；②边改二次贝塞尔曲线：控制点垂直偏移随边长缩放钳 [12,28]，draw 每帧按曲线两侧对无关节点的最小距离（9 点采样）比空旷度选朝向、另一侧明显更空（+12 世界像素）才翻转（side 挂边对象上迟滞防抖），同一对角色的重复边按 (a,b) 分组序号放大偏移并交替朝向互相分开，type 标签移到曲线 t=0.5 点；③hover 命中检测跟曲线几何走（二次贝塞尔 9 段折线近似，阈值仍 10 世界像素，edgeCtrl 与 draw 同源）。纯前端，路由不变；I18N 不变。注：边完全零交叉在数学上不总成立（非平面图），本改动目标是消除节点压叠、线穿节点、重复边重合与常见交叠，不保证零交叉。
- **关系图工具角标**（0.1.19）：关系图右上角新增工具条——＋/－ 缩放按钮（步进 ×1.25 / ÷1.25，钳制与滚轮同口径 0.4-2.5；React 按钮够不着绘图 effect 闭包里的 sim，经 zoomApiRef 桥调用，effect 清理时置 null 防旧闭包误触）与全屏切换按钮（Fullscreen API 能力检测——wrap 有 requestFullscreen/webkitRequestFullscreen 且 document.fullscreenEnabled 非假才渲染，否则不占位；监听 fullscreenchange/webkitfullscreenchange 同步「全屏/退出全屏」文案，浏览器 ESC 退出也跟上；进/出全屏 wrap 尺寸变化走既有 ResizeObserver 自动 resize 重铺 canvas，Chromium UA 全屏样式覆盖 480px 定高）。纯前端，路由不变；I18N zh/en 各 260 → 264 条（relations.zoomIn / zoomOut / fs / exitFs），relations.help 文案同步更新（提缩放按钮与右上角全屏）。
- **世界观分类二级子 tab**（0.1.20）：设定 tab 世界观条目分区内部再进一层——原纵向分组列表（myt-listHead 分组头 + myt-worldGroup 堆叠）在 world 条目按 category（frontmatter 自由文本，缺省「未分类」）聚出**多个**分类时改为二级子 tab 条（复用 myt-subTabs/myt-subTab + myt-subTabsInner 修饰：字号/padding 收一号），每 tab 带条目计数、仅渲染激活分类的条目（条目 markup 不变）；单分类或全部未分类时平铺直出，不出 tab 条也不出分组头，world 为空维持空态。激活分类记忆在组件 state（切走再切回不丢），快照重拉后所存分类已不存在时回落第一个。category 是数据文件自由文本，分组容器保持 Object.create(null) 防原型污染。纯前端，路由不变；I18N zh/en 各 264 → 265 条（world.catTabsAria）。
- **全量可编辑写面（0.1.20）**：面板剩余只读内容开放为人工可编辑——①路由 19 → 23 条：`file-source`（GET 原文+指纹）/`file-save`（POST 整文件覆写，base_hash 409 + 结构校验 422）/`file-create`（新建，已存在 409）/`file-delete`（删除，服务端不二次确认），四条共用 `managedRelCheck` 白名单（§2 受管文件白名单表）：六个账本 yml 读/存、四个 md 实体目录读/存/建/删（slug=`^[a-z0-9][a-z0-9-]*$`）、outlines 读/存/建/删、chapters 仅删；`index.yml`/`project.yml`/`novel/style.md` 有意排除（各走专用路由/弹层）。②结构校验 `validateManagedText`：账本 yml 须解析为顶层数组且条目全为平键对象（快照会静默丢弃 null/裸标量/数组条/空对象条——存得进读不出等于丢数据，存时一并 422）；md 实体卡只验围栏成对；回退解析与真 yaml 解析两条路同一结论（测试双口径断言）。③UI 九处入口：角色墙头「新建角色」+ 全卡弹层「编辑源文件/删除文件」；world/science 组头「新建设定」（模板预填 `---\ncategory: 地点\n---` / `---\nlabel: known\n---`）+ 条目卡编辑/删除；伏笔/关系图/时间线/索引板两卡卡头「编辑源文件」（时间线/关系图空态也给入口）；概览分卷卡头「编辑源文件」（volumes.yml）；章节阅读页无章纲空态「新建章纲」（五件骨架预填）+ 阅读顶栏「删除章节」+ 章纲卡头「删除章纲」（删除均确认弹层，文案点名不可逆、后悔靠 git、check 会标孤儿引用）。共用三弹层组件（SourceEditorModal 带请求序号防过期响应 / CreateFileModal slug 客户端预校 / ConfirmModal 在途禁双击）。research 快照有卡但 v1 无写面入口。I18N zh/en 各 265 → 294 条（src.* 20 + toast.fileSaved/fileCreated/fileDeleted + reader.createOutline/deleteChapter + outline.deleteBtn + char.createBtn + world.createBtn/createScienceBtn）。测试：panel-core 层 7 例（白名单矩阵/白名单外与形状违规拒/结构校验双口径/读存建删）+ 路由层 2 例（file-source、三态全链路）。

- **Markdown 管道表格**（0.1.20）：零依赖渲染器补 GFM 管道表格——表头行 + `|---|---|` 分隔行 + 数据行，设定卡/章纲里写 `| 职级 | 修为档位 |` 不再渲染成带竖线的纯文本段落；对齐语法 `:---`/`---:`/`:---:` 落 `myt-ta-l/c/r` class（th/td 共用，不用 inline style），转义管道 `\|` 切列豁免（哨兵回填字面 `|`）、首尾外圈竖线丢弃、**表头列数须与分隔行列数相等才认表**（GFM 规范——否则「含 `|` 的段落行 + `---` 分隔线」会被误吞成表头）、数据行列数不齐宽容渲染（缺列补空 td、多列照渲染），段落兜底补表格起始检测（段落后紧跟表格时截断成块，GitHub 语义）。表格包 `myt-mdTableWrap` 宽表横向滚动；`myt-mdTable` 显式 `white-space: normal` 覆盖落点容器（`.myt-outlineBody`/`.myt-worldDesc`）的 pre-wrap，否则单元格内容按源码换行。安全底线不变：先整体转义再变换，单元格文本走既有已转义行 + inlineMd，不自建未转义通道。纯前端，路由不变；I18N 不变；新增 test/md-table.test.mjs（源码切片 `new Function` 求值 renderMd 纯函数直测，切片标记失效带定位报错防静默漏测）。

- **手动检测更新**：`update-check` 只在面板打开时拉一次（服务端另有 1h 缓存），页面开久了拿不到新判定，升级提示成聋——顶栏版本号旁新增「检测更新」描边胶囊按钮（与「一键升级」同形 `.myt-verCheck`，点击后变「检测中…」并禁用防连点，完成恢复），点击带 `fresh=1` 请求现测：服务端 getVersionInfo 走 `force` 先把模块级缓存压空再走正常流程（**force 只保证不命中 1h TTL 内的陈旧 cache，不保证「另发一轮全新外网请求」**——若已有 in-flight 检测在跑则复用等它落定，它本就是缓存失效后发起的新检测，有意语义），手动检测超时由 3s 放宽到 10s（用户在前端等结果），缺省调用维持 3s 不变。结果分流：updateAvailable → setVer 更新版本状态（「有新版 ↗」徽章与「一键升级」按钮自然出现）+ toast「发现新版 {latest}」；无新版 → toast「已是最新版（{current}）」（复用 toast.selfUpdate.upToDate，与一键升级短路分支同一文案，不添重复键）；失败（服务端 error 非空或请求 reject）→ toast「检测失败：{首句}」——三路全败 error 是长串排障文案，取首句、仍超 ~80 字符截断加省略号防糊屏。前端直连 maoyingApi 不走 apiGet：apiGet 会先统一 toast 遍错误再 rethrow，叠加「检测失败」就双份提示（与 runSelfUpdate 直连同一理由）；手动检测请求超时沿用统一 60s（服务端 10s 即收敛）。测试：lib 层 force 两例（预填缓存 → TTL 内命中 → force 换桩重测且 fetch 计数增加；并发双 force 复用同一 in-flight 只发一轮）+ 路由层 fresh=1 分支接线（query 解析 + 契约形状）。纯前端加参数扩展，路由仍 23 条；I18N zh/en 各 294 → 298 条（header.checkUpdate / header.checkingUpdate / toast.selfUpdate.found / toast.selfUpdate.checkFail）。

- **写面 409 冲突两出口**：正文（chapter-save）/章纲（outline-save）/受管文件（file-save）/写作风格（style-save）四处编辑保存遇 409 外部改动冲突时，不再静默重拉把草稿重置掉——草稿绝不丢：冲突提示下方亮「载入磁盘版（放弃草稿）/基于最新版重改」两个出口，前者重拉磁盘真值回填编辑器并重置基线，后者只把基线换成磁盘最新（拿新 hash），草稿原样留在编辑器、改完再存即用新基线；重拉失败冲突态保留、出口仍在可重试。project-save 表单维持原「409 重拉放回磁盘真值」路径（表单无草稿语义）。纯前端，路由不变；I18N zh/en 各 298 → 301 条（edit.conflict409 / edit.conflictDrop / edit.conflictKeep）。同轮服务端契约补齐：围栏 403 与全部错误统一 `{ ok: false, error }` 形状（routes 测试有断言）；self-update 新增失败 kind `verify-failed`（装后对账不符，见 §2 路由表）；快照 warnings 补 yaml 真/降级解析告警（见 §3）。

- **正文编辑直开 + 自动保存 + 段首缩进**（0.1.22）：章节阅读页正文编辑三处升级——①**空章节直开编辑态**：待写章节（body 全空白）打开即直接进正文编辑态，不再经顶部「编辑」按钮中转；预填段首两个全角空格让首段也有缩进，基线与预填同值（不判脏，退出确认与自动保存均不误触）；正在编辑绝不打扰（409 放弃草稿等编辑中重拉被 editingRef 守卫排除），同章本轮只自动进一次，切章/重开面板算新一轮可再进，手动「取消」退出后本轮不再自动重进。②**正文自动保存**：编辑中改动 2s 防抖落盘（调度 effect 无 dep 数组每轮渲染重排定时器，连续打字永远差 2s 才保存；409 冲突/保存在途不排），调用点快照 draft 防在途打字被误标已保存，**写盘内容即新基线**（连续自动保存不假脏），成功不退出编辑态、不清草稿，编辑 hint 缀「已自动保存（HH:MM:SS）」时刻标；纯缩进占位（trim 为空）不落盘；409 人工改动检测语义不变——冲突即停排、草稿保留、两出口照旧。③**回车自动段首缩进**：编辑器内回车换行自动插入两个全角空格（U+3000×2，网文段落缩进惯例），光标落到缩进之后（draft 提交后下一轮渲染恢复选区）；IME 组态中的回车（keyCode 229 / isComposing）是选词确认不劫持，取不到 selectionStart 的退化环境交给浏览器默认行为。编辑器排版与只读正文一致（同 UI 字体、13px/22px 行高，所见即所得）并随内容自动长高（≥320px，overflow hidden + resize none），主题色边框保留可辨识仍在编辑；脏退出确认兜底不动（自动保存窗口之外切章/取消/返回仍先确认）。纯前端，路由不变；I18N zh/en 各 301 → 302 条（reader.autoSaved；reader.bodyEditHint 文案同步改写）。

- **手动保存不退出编辑态 + 防抖 30s + 实时字数**（0.1.23）：正文编辑三点迭代——①**手动/自动保存行为统一**：保存成功（「保存」按钮或防抖定时器）都停留编辑态续写、不清草稿，时刻标照缀 hint——手动点保存与自动保存等价，只是人工触发（用户语：「这个功能实际上和自动保存是一样的，只不过是人工点一下而已」）；退出编辑态只走「取消」（保存后草稿已回基线、脏检查归零，无确认直退），0.1.22 之前「手动保存退出编辑态」的旧语义废止。②**自动保存防抖 2s → 30s**：写作中途的短暂停顿（翻资料、想句子）不再频繁落盘，「每轮渲染重排定时器、连续打字永远差一个窗口」的调度语义不变，纯缩进占位不落盘照旧。③**编辑 hint 常显正文实时 CJK 字数**：复用既有 `common.charCount`（`{n} 字` / `{n} chars`，fmtNum 千分位），客户端内联与 lib/novel-parse.mjs `countCjk` 同口径的正则（基本区 + 扩展 A + 扩展 B，u 标志按码点匹配增补平面生僻字），面板本地数与服务端全库字数口径一致；显示形如「直接编辑正文… · 1,234 字 · 已自动保存（HH:MM:SS）」，字数常显、保存时刻照旧按有无显示。纯前端，路由不变；I18N 键数不变（reader.bodyEditHint 文案更新：2 秒 → 30 秒 / ~2s → ~30s）。

- **写作中章节直开编辑态**（0.1.25）：直开判定从「正文待写」扩到「正在写」——frontmatter `status=writing` 的章节打开阅读页同样直接进正文编辑态，不只空章节（0.1.22 起的空章节直开照旧）。两点口径：①状态读 `GET chapter` 出参的 `d.frontmatter.status`，不用渲染体的 `ch` 判——`loadDetail` 是 useCallback 闭包，`ch` 是渲染体快照的过期值，`frontmatter` 才是本次响应的同源真值；②空正文优先判定（`body.trim() === ""` 在前）：空正文（待写）预填段首两个全角空格让首段有缩进，写作中的非空正文 draft/基线都取磁盘原文、不预填不动原文一字。其余语义不变：三重守卫（正在编辑绝不打扰 / 同章本轮只自动进一次 / `autoEditRef` 去重）照旧，取消退出后本轮不重进，切章/重开面板算新一轮，409 与纯缩进占位不落盘规则不变。纯前端，路由不变；I18N 不变。

## 5. 验收基线

- Node 侧：临时 workspace（/tmp）+ 假 workspaceRegistry 不行——路由从 ctx.workspaceRegistry 取；单测直接 import lib/panel-core.mjs 的函数（parseStateSnapshot / mutateChapterStatus / mutateForeshadowStatus / mutatePhase / rebuildIndex）跑断言；路由层用 node 起一个最小 ctx 假件（webServer.register 收集 handler，workspaceRegistry 返回临时 root）模拟请求验证围栏 403 / 状态流转 / 防穿越。
- 浏览器侧：`node --check` 不适用（browser bundle 用 var/require factory 语法）——冒烟脚本 `npm run smoke`（scripts/smoke-client.mjs，零依赖）已落地：new Function 包裹整份源码做编译检查 → stub window/document 求值截获 `__ModuleLoader__.load` → factory 传 react/UI 原语 stub 求值，断言导出面 `{ inject: ["slots"], apply }` 与 slots 注入 / disposer 折返语义。CI（Node 18/20/22 矩阵）与 `npm test` 同跑；真浏览器验收仍由用户重启后做。
- 不写死任何真实路径；测试全在 /tmp；真实 ~/.dsh 不碰。
