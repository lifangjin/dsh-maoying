# AGENTS.md — 代理协作约定

## 发版纪律（用户拍板，最高优先级）

**发版必须由用户明确提出（「发版」/「发出去」等明确口令）才可执行；严禁代理自行发版。**

- 允许自主执行：改代码、跑测试、git commit、git push（这些不算发版）。
- 仅在用户明确发版口令后执行三连：`git tag vX.Y.Z` + GitHub Release（Latest）+ `npm publish`。
- 用户未发话时，一切修复停在「已提交待发」状态，不许抢跑。
- 本条优先于历史上「发版默认三连做齐」的惯例——三连做齐仍是发版时的默认动作，但触发权永远在用户手里。

## 测试基线与门禁

- 基线命令：仓库根跑 `npm test`（即 `node --test test/*.test.mjs`，不带引号——由 shell 展开 glob；Node 18/20 的 `--test` 不认 glob 字面量，v21 起才支持）。改源码或改测试后必须全量 0 fail；pass/skip 数字以当次 `npm test` 输出为准，不写死在本文件里（skip 只允许 yaml 包条件跳过一类，出现其他 skip 必须查明原因）。
- 冒烟：`npm run smoke`（scripts/smoke-client.mjs，校验 lib/client.js 的 factory 可解析、可求值、导出面完整）。仓库无 CI（.github/workflows 已移除），`npm test` 与 `npm run smoke` 均为本地执行。
- `/tmp/yamlcheck` staging 约定：本仓库零 npm 依赖，测试需要真 yaml 包时从 `/tmp/yamlcheck/node_modules/yaml` 借（与安装器运行时同款 yaml v2）。搭法一条命令：`npm install --no-save --prefix /tmp/yamlcheck yaml@2`。依赖它的用例：test/installer-shape.test.mjs（假 home 借包）、test/composition.test.mjs（双源 YAML 解析）、test/panel-core.test.mjs（生产默认真解析路径）。staging 缺席时这些用例一律优雅 skip（对照 test/composition.test.mjs 的 `t.skip` 写法），不算失败。

## 发布检查单（追加一条）

- 文档随功能同步：spec/README/creator-panel 的契约与清单类声明（路由条数、快照键集、project 键集、CLI 命令数等）须与代码实况一致后才能发版——改了路由/字段/命令却没改文档，按未完成处理。
