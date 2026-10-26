#!/usr/bin/env node
/**
 * client.js 冒烟（npm run smoke，CI 同跑）：不启浏览器、零依赖，三步校验
 * lib/client.js 的可加载性与导出面契约——
 *   ① 语法可编译：整份源码 new Function 包裹，解析失败即红；
 *   ② ModuleLoader 拦截：stub window / document 求值，截获 load({ id, factory })，
 *      id 必须是 dsh-maoying（图行 id 约定，挂错名宿主首载即 import 报错）；
 *   ③ factory 求值：stub react（五个 hook + createElement + Component——
 *      class extends 在定义期就要 Component）与宿主 UI 原语；react-dom/client
 *      缺席由 factory 内部 catch（Node 下拿不到属正常）。导出面必须 =
 *      { inject: 含 "slots" 的数组, apply: 函数 }，且 apply 两次求值：
 *      带 slots stub 时应把入口挂到 sidebar.footer.action 键控槽（id
 *      maoying-creator），不带 slots 时护栏折返也不炸——两次都返回 disposer
 *      函数且可安全调用。
 * 任何一步失败 exit 1（console.error 中文说明）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (message) => {
  console.error(`smoke: ${message}`)
  process.exit(1)
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')

// ① 语法可编译
let compiled
try {
  compiled = new Function('window', 'document', source)
} catch (err) {
  fail(`lib/client.js 语法不可编译：${err.message}`)
}

// ② 求值并截获 ModuleLoader.load（querySelector 给真值走 mountCss 幂等跳过支，
//    Node 下不触碰任何真实 DOM）
let definition = null
const windowStub = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}
const documentStub = { currentScript: null, querySelector: () => ({}) }
try {
  compiled(windowStub, documentStub)
} catch (err) {
  fail(`lib/client.js 顶层求值失败：${err.message}`)
}
if (!definition || typeof definition.factory !== 'function') {
  fail(`未截获 __ModuleLoader__.load({ factory })，实得：${JSON.stringify(definition)?.slice(0, 120)}`)
}
if (definition.id !== 'dsh-maoying') {
  fail(`插件 id 应为 dsh-maoying（图行 id 约定），实得「${definition.id}」`)
}

// ③ factory 求值：导出面 + apply 双路
const reactStub = {
  createElement: (...args) => ({ $$el: args }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  Component: class Component {},
}
const requireStub = (name) => {
  if (name === 'react') return reactStub
  // 宿主 UI 原语：factory 只做 Object.assign 拷贝，空对象即可（缺名图标渲染期
  // 才会用到，本冒烟不渲染）。
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  // react-dom/client 由 factory 内部 catch（返回 null），这里抛错即模拟缺席；
  // 其余未知模块视为依赖面外溢，直接红。
  throw new Error(`smoke require stub: 意外模块「${name}」`)
}

let exportsSurface = null
try {
  exportsSurface = definition.factory(requireStub)
} catch (err) {
  fail(`factory 求值失败：${err.message}`)
}
if (!exportsSurface || typeof exportsSurface !== 'object') fail('factory 未返回导出对象')
if (!Array.isArray(exportsSurface.inject) || !exportsSurface.inject.includes('slots')) {
  fail(`exports.inject 应为含 "slots" 的依赖数组，实得：${JSON.stringify(exportsSurface.inject)}`)
}
if (typeof exportsSurface.apply !== 'function') fail('exports.apply 应为函数')

// apply ①：带 slots stub——入口应挂到 sidebar.footer.action 键控槽
const injectedSlots = []
const registeredMetas = []
let registerReturns = 0
const slotsStub = {
  inject(slot, mount) {
    injectedSlots.push(slot)
    const component = mount() // 触发 register：只求值组件引用，不渲染
    if (component === undefined) fail('slots.inject 的 mount 工厂未返回 register 结果')
    return () => {}
  },
  register(meta) {
    registeredMetas.push(meta)
    registerReturns += 1
    return { disposed: false }
  },
}
const loggerWarns = []
const disposerA = exportsSurface.apply({
  logger: { warn(...args) { loggerWarns.push(args.map(String).join(' ')) } },
  slots: slotsStub,
})
if (typeof disposerA !== 'function') fail('apply(ctx) 应返回 disposer 函数')
if (injectedSlots.join(',') !== 'sidebar.footer.action') {
  fail(`入口应注入 sidebar.footer.action 槽，实得：${injectedSlots.join(',') || '（无）'}`)
}
if (registerReturns !== 1 || registeredMetas[0]?.id !== 'maoying-creator') {
  fail(`应注册 id 为 maoying-creator 的入口，实得：${JSON.stringify(registeredMetas)}`)
}
disposerA() // disposer 必须可安全调用（幂等清理不抛）

// apply ②：无 slots（护栏未声明该服务）——折返不炸，照样给出 disposer
const disposerB = exportsSurface.apply({ logger: { warn() {} } })
if (typeof disposerB !== 'function') fail('apply 无 slots 时也应返回 disposer（护栏折返语义）')
disposerB()

// apply ③：线上踩过的坑——严格 ctx.get 装死（cordis strict=true 对非活跃
// fiber 的 provide 静默 undefined），属性直读可用（files 插件的实证消费路径）。
// 双路探测必须仍认出服务：两个 tab 类型照常注册，且不落降级 warn。
{
  const slots3 = [], metas3 = []
  const slotsStub3 = {
    inject(slot, mount) {
      slots3.push(slot)
      const component = mount()
      if (component === undefined) fail('场景③ inject 工厂未返回 register 结果')
      return () => {}
    },
    register(meta) { metas3.push(meta); return { disposed: false } },
  }
  const sbTabs = { register(meta) { metas3.push(meta); return () => {} } }
  const sbRight = { openTab() {}, close() {}, active() { return null }, isExpanded() { return false }, toggleExpanded() {} }
  const warns3 = []
  const disposerC = exportsSurface.apply({
    logger: { warn(...a) { warns3.push(a.map(String).join(' ')) } },
    slots: slotsStub3,
    // 严格语义：一律 undefined（提供者 fiber 非活跃态）
    get() { return undefined },
    // 属性直读路径：服务在 ctx 上
    sidebarRightTabs: sbTabs,
    sidebarRight: sbRight,
  })
  if (typeof disposerC !== 'function') fail('场景③ apply 应返回 disposer')
  const tabSeats = slots3.filter((s) => s === 'sidebar.right.pane.tab').length
  if (tabSeats !== 2) fail(`场景③ 应注入 2 个 pane.tab seat（创作台+文章页），实得 ${tabSeats}`)
  const typeIds = metas3.filter((m) => m && (m.id === 'dsh-maoying' || m.id === 'dsh-maoying-reader'))
  if (typeIds.length !== 2) fail(`场景③ 应注册 2 个 tab 类型，实得：${JSON.stringify(metas3)}`)
  if (warns3.some((w) => w.includes('sidebar-right services not found'))) {
    fail(`场景③ 双路探测成功就不该落降级 warn：${warns3.join(' | ')}`)
  }
  disposerC()
}

console.log('smoke 通过：client.js 编译 ✓ ModuleLoader 截获 ✓ 导出面 { inject, apply } ✓ slots 注入与 disposer ✓')
