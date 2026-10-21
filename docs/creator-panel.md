# 毛颖创作台（Web 面板）设计 · v1

三期交付：DSH Web 左侧栏「毛颖创作台」入口 + 会话中栏全页面板 + `/api/maoying/*` 路由。机制与实现全部原创。

## 0. 定位与边界

面板管**可视化与状态**，不管正文创作：小说内容由主编（agent）与作者在编辑器里写，面板负责「一眼看清全局 + 状态快捷流转」。v1 读全量、写少量（状态流转 + 索引重建）；正文编辑不做（那是编辑器和 agent 的活，面板里点「让主编改」提示语即可）。

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
| `host-debug` | GET | — | `{ ok, hostVersion, trace, shape, registry, runtime }`——现场诊断（见下节） |
| `workspaces` | GET | — | `{ ok, workspaces: [{ path, name, hasNovel }] }`——workspaceRegistry.list() 逐根探测 `<root>/novel/project.yml` |
| `state` | GET | `path=<root>` | 全量快照（见 §3 契约） |
| `chapter` | GET | `path`, `file`（chapters/ 下文件名） | `{ ok, file, frontmatter, body, outline }`——正文全文 + 对应章纲（`{ file, words, body }`，outlines/ 无对应文件时 null），章节抽屉用 |
| `chapter-status` | POST | `{ path, file, status }` | `{ ok }`——frontmatter status 行原地替换；status 必须 ∈ pending/writing/review/accepted |
| `foreshadow-status` | POST | `{ path, id, status }` | `{ ok }`——foreshadows.yml 对应条目 status 行替换；∈ planted/progressing/resolved/abandoned |
| `phase` | POST | `{ path, phase }` | `{ ok }`——project.yml phase 行替换；七态枚举 |
| `project-save` | POST | `{ path, values }`（8 平键，title/author/genre/length/language/phase/mode/description） | `{ ok }`——mutateProject 逐键改写保行尾注释、缺键按模板补齐；phase/mode 越枚举与空书名 422 |
| `rebuild-index` | POST | `{ path }` | `{ ok, chapters }`——照 CLI index 同一逻辑重建 index.yml |

共 11 条。写操作全部「行级原地替换」：只在 frontmatter/目标 yml 的对应行上做字符串手术，写前读、写后校验（替换计数 ≠1 即 409 拒写并报错），不做整文件重排——把对 git diff 的扰动压到最小，也与 agent 的写法兼容。

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
  "project": { "title","author","genre","length","language","phase","mode","description" },  // mode: ai-draft|co-write|author-draft（五期）
  "chapters": [{ "file","volume","num","title","status","words","summary",
                 "cognitive_frame","emotional_anchor","world_texture",
                 "suspense","interpersonal_tension" }],     // 按 volume,num 升序；words 为 CJK 计数
  "characters": [{ "file","name","age","gender","role","appearance","personality",
                   "background","motivation","arc","markers" }], // markers 数组，缺省 []
  "relations": [{ "a","b","type","description","intensity","started","ended" }],
  "foreshadows": [{ "id","title","status","priority","planted_chapter",
                    "expected_resolve","resolved_chapter","notes","source" }], // source: plan|backfill，缺省 plan
  "timeline": [{ "year","title","description","importance","chapter" }],
  "memories": [{ "category","content","source_chapter" }],
  "clues": [{ "kind","content","related_chapter","resolved" }],
  "world": [{ "file","category","tags","name","description" }],
  "science": [{ "file","label","name","description","references" }],
  "research": [{ "file","topic" }],
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
- 顶部工作区选择器（workspaces 路由取数，hasNovel 的排前；无 novel 工作区显示引导卡：一句 `maoying init` 提示 + 复制按钮）。

九个 tab（顺序即默认排布，第 9 个为后续迭代新增）：

1. **概览**：project 卡（书名大字 + 类型/篇幅/语言 pills + 阶段徽章 + 简介）；统计卡（总字数/章节数/状态分布条）；最近更新（chapters 按 mtime 前 5）；warnings 黄条。
2. **章节**：表格（卷-章/标题/状态徽章/字数/梗概），状态筛选 pills；表格上方「按单写作」区块——有章纲且 status=pending 的章按序列出（章纲节选 + 状态徽章，共创模式的主工作清单）；行点击开整页阅读视图（0.1.12 起替代原右侧抽屉——fixed 侧弹层会被 DSH 侧边栏遮挡）：返回按钮 + GET chapter 正文（只读，等宽滚动）+ 章纲对照栏（左右分栏或折叠段）+ 复制文件路径按钮 + 五维字段卡 + 状态流转按钮（当前态 → 下一态一键，pending→writing→review→accepted）。
3. **角色**：卡墙（姓名/role 徽章四色/年龄性别/性格一句/动机一行），点击看全卡（含 arc/markers/background）。
4. **伏笔**：四列看板（埋设/推进/已回收/弃用），卡片含 priority 色点（high 红/normal 灰/low 淡）、`source: backfill` 的「回填」小徽章（账本回填来的条目，区别于写前规划）、埋设章→预期回收章、notes 全文直显（0.1.10 去掉两行截断）；卡片按钮：推进到下一状态（planted→progressing→resolved；abandoned 只能从看板拖不动、按钮给「弃用」）。列头计数。
5. **关系图**：canvas 力导向图——节点=角色（radius 随出场无关、固定 18px，名字 label 下方），边=relations（intensity 1-5 → 线宽 1-4px，type 标在边中点 hover 显示 description）；拖拽节点、空白处滚轮缩放、双击复位；intensity 缺省 3。角色多于 30 个时只画与 relations 相连的节点，其余进「未入图」列表。
6. **时间线**：垂直轴，importance 1-5 → 点大小/颜色深浅，year 左列右卡片。
7. **设定**：world 按 category 分组列表 + science 三色标签（known 绿/extrapolation 黄/hypothesis 紫，标签下 references 链接列表）。
8. **索引板**：clues 按 kind 分组（线索/红鲱鱼/推理/疑问，resolved 划线置灰）+ memories 按 category 分组（promise 类高亮）。

状态徽章色（全局统一）：pending 灰 / writing 蓝 / review 橙 / accepted 绿；phase 七态沿用七色 pill。文案全中文、禁 emoji 图标（用 ui-primitives 图标或纯 CSS）。

## 4.1 后续迭代记录（0.1.10 – 0.1.12）

- **MaskPortal**：抽屉/弹层统一 portal 到 `document.body`——面板容器挂在宿主会话中栏，中栏 transform/overflow 会把 `position: fixed` 劫持成相对自身并连同裁剪（桌面端「点了没反应」实测病灶）；无 createPortal 的老宿主退回原地渲染。
- **顶栏版本区**：当前版本号常驻；`update-check` 路由（模仿 dsh-paoding：npm registry → npmmirror → GitHub 三级源，1h 缓存 + 7 天 stale-if-error，全败静默）发现新版时亮「有新版 ↗」徽章。
- **系统设置**：齿轮弹窗，字号五档（100/120/150/180/200%）——面板根与 portal 节点读同一 `--myt-zoom` 变量整体 zoom，localStorage 记忆。
- **Markdown 渲染**：零依赖渲染器（先整体转义再变换），章纲对照与世界观/科学设定描述不再裸显 md 源码；正文手稿仍走 pre。
- **章节整页阅读**：替代右侧抽屉（侧边栏遮挡问题），返回按钮 + 章纲对照 + 五维 + 状态流转原位保留；阅读态隐藏 tab 条。
- **小说设置 tab**（第 9 个）：project.yml 平键表单化编辑，`POST project-save` → `mutateProject` 逐键改写保行尾注释、缺键按模板补齐、phase/mode 越枚举与空书名 422。

## 5. 验收基线

- Node 侧：临时 workspace（/tmp）+ 假 workspaceRegistry 不行——路由从 ctx.workspaceRegistry 取；单测直接 import lib/panel-core.mjs 的函数（parseStateSnapshot / mutateChapterStatus / mutateForeshadowStatus / mutatePhase / rebuildIndex）跑断言；路由层用 node 起一个最小 ctx 假件（webServer.register 收集 handler，workspaceRegistry 返回临时 root）模拟请求验证围栏 403 / 状态流转 / 防穿越。
- 浏览器侧：`node --check` 不适用（browser bundle 用 var/require factory 语法）——冒烟脚本 `npm run smoke`（scripts/smoke-client.mjs，零依赖）已落地：new Function 包裹整份源码做编译检查 → stub window/document 求值截获 `__ModuleLoader__.load` → factory 传 react/UI 原语 stub 求值，断言导出面 `{ inject: ["slots"], apply }` 与 slots 注入 / disposer 折返语义。CI（Node 18/20/22 矩阵）与 `npm test` 同跑；真浏览器验收仍由用户重启后做。
- 不写死任何真实路径；测试全在 /tmp；真实 ~/.dsh 不碰。
