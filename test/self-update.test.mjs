/**
 * self-update 单测：全注入、零真实副作用——pnpm 绝不真跑，文件系统探测全部
 * 假件（pkgDirImpl / realpathImpl / existsImpl / readImpl / spawnImpl）。
 *
 * 覆盖 lib/self-update.mjs 全部失败分支（dev-link / unsupported-layout 两种 /
 * pnpm-missing / 超时 / pnpm 非零退出）、成功流（spawn 参数与无 shell、
 * from/to/restartRequired）、并发 in-flight 去重（只 spawn 一次），以及
 * index.mjs 路由接线（POST self-update 在仓库检出形态下 200 + ok:false 收敛，
 * 不真装）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { selfUpdate, resetSelfUpdateInflight } from '../lib/self-update.mjs'

// 假安装位：env 钉死的 profile 布局路径（不落盘，探测全走注入假件）。
const HOME = '/tmp/maoying-selfupdate-fakehome'
const PROFILE_DIR = path.join(HOME, 'profiles', 'desktop')
const LAYOUT_DIR = path.join(PROFILE_DIR, 'node_modules', 'dsh-maoying')
const PKG_JSON = path.join(LAYOUT_DIR, 'package.json')

/** 基准 env：desktop 档 + PATH 只有一个 pnpm 候选位。 */
function baseEnv() {
  return { DSH_HOME: HOME, DSH_PROFILE: 'desktop', PATH: '/usr/bin:/bin', HOME: '/Users/fake' }
}

const silentLogger = { info() {}, warn() {}, error() {} }

/**
 * 假子进程：满足实现用到的最小面（stdout/stderr on data、on('exit'/'error')、
 * kill）。exit 在微任务（或 delayMs 后）发出，给并发窗口留时间。
 */
function fakeChild({ code = 0, delayMs = 0, neverExit = false } = {}) {
  const exitCbs = []
  const child = {
    killed: false,
    // data 同步发（真实流也是先 data 后 exit；exit 在微任务/定时器里，晚于监听注册）
    stdout: { on(ev, cb) { if (ev === 'data') cb(Buffer.from('stdout-tail')) } },
    stderr: { on(ev, cb) { if (ev === 'data') cb(Buffer.from('stderr-tail')) } },
    on(ev, cb) { if (ev === 'exit') exitCbs.push(cb) },
    kill() { child.killed = true },
  }
  const fire = () => { for (const cb of exitCbs) cb(code, null) }
  if (!neverExit) {
    if (delayMs > 0) setTimeout(fire, delayMs)
    else queueMicrotask(fire)
  }
  return child
}

/** spawn 假件记账：calls 收集 (file, args, opts)。 */
function spawnRecorder({ childOpts = {} } = {}) {
  const calls = []
  const impl = (file, args, opts) => {
    calls.push({ file, args, opts })
    return fakeChild(childOpts)
  }
  impl.calls = calls
  return impl
}

/** package.json 假读：按调用次序返回版本序列（第 1 次=from，第 2 次=to）。 */
function versionReader(versions) {
  let i = 0
  const fn = async (p) => {
    assert.equal(p, PKG_JSON, '只许读安装目录的 package.json')
    const v = versions[Math.min(i, versions.length - 1)]
    i += 1
    return JSON.stringify({ name: 'dsh-maoying', version: v })
  }
  return fn
}

/** 常用依赖组合：真路径即布局路径（正常目录安装形态）。 */
function layoutDeps(overrides = {}) {
  return {
    env: baseEnv(),
    logger: silentLogger,
    pkgDirImpl: () => LAYOUT_DIR,
    realpathImpl: (p) => p, // 透传 = 真路径与常规路径一致（非 symlink）
    existsImpl: (p) => p === '/usr/bin/pnpm',
    accessImpl: () => {},
    readImpl: versionReader(['0.1.12', '9.9.9']),
    ...overrides,
  }
}

// ── 失败分支 ────────────────────────────────────────────────────────────────

test('dev-link 拒绝：真路径 ≠ 常规路径（symlink 到 dev repo）绝不 spawn', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder()
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    pkgDirImpl: () => '/repo/dsh-maoying',
    realpathImpl: () => '/real/dev-repo/dsh-maoying',
  }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'dev-link')
  assert.match(r.message, /git pull/)
  assert.equal(spawn.calls.length, 0, 'dev-link 一票否决，绝不执行安装')
})

test('unsupported-layout：真路径没有 profiles/node_modules 祖先结构', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder()
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    pkgDirImpl: () => '/tmp/elsewhere/dsh-maoying',
  }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'unsupported-layout')
  assert.equal(spawn.calls.length, 0)
})

test('unsupported-layout：env 指明 desktop 但真路径装在别的 profile 下', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder()
  const otherProfile = path.join(HOME, 'profiles', 'dev', 'node_modules', 'dsh-maoying')
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    pkgDirImpl: () => otherProfile,
  }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'unsupported-layout')
  assert.equal(spawn.calls.length, 0)
})

test('pnpm-missing：PATH 与常见安装位都探测不到', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder()
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn, existsImpl: () => false }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'pnpm-missing')
  assert.match(r.message, /pnpm/)
  assert.equal(spawn.calls.length, 0)
})

test('pnpm 非零退出：ok:false + 输出尾部进 message', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder({ childOpts: { code: 1 } })
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'pnpm-failed')
  assert.match(r.message, /exit 1/)
  assert.match(r.message, /stderr-tail/, '失败信息带子进程输出尾部便于排障')
})

test('超时：到点 kill 子进程并收敛 kind:timeout，不挂死调用方', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder({ childOpts: { neverExit: true } })
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn, timeoutMs: 25 }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'timeout')
  assert.match(r.message, /超时/)
  assert.equal(spawn.calls[0].file, '/usr/bin/pnpm')
  assert.equal(spawn.calls.length, 1)
})

// ── 成功流 ──────────────────────────────────────────────────────────────────

test('成功流：spawn 参数精确、无 shell、from/to/restartRequired 就位', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder()
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn }))
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'installed')
  assert.equal(r.from, '0.1.12')
  assert.equal(r.to, '9.9.9')
  assert.equal(r.restartRequired, true, '装完仍是旧进程，必须重启才生效')

  assert.equal(spawn.calls.length, 1)
  const { file, args, opts } = spawn.calls[0]
  assert.equal(file, '/usr/bin/pnpm', 'PATH 首个可执行候选胜出')
  assert.deepEqual(args, ['--dir', PROFILE_DIR, 'add', 'dsh-maoying@latest'])
  assert.equal(opts.shell, undefined, '绝不用 shell:true（无注入面）')
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
})

test('并发去重：同一时刻两次调用只 spawn 一次、共享同一结果', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder({ childOpts: { delayMs: 20 } })
  const [a, b] = await Promise.all([
    selfUpdate(layoutDeps({ spawnImpl: spawn, readImpl: versionReader(['0.1.12', '9.9.9']) })),
    selfUpdate({ env: baseEnv() }), // 第二次调用不带注入也复用第一次的 in-flight
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a, b, '并发调用共享同一 in-flight promise')
  assert.equal(spawn.calls.length, 1, 'pnpm add 绝不并发跑两份')
})

test('pnpm 解析：PATH 没有时按候选顺序落到常见安装位', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnRecorder()
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    env: { ...baseEnv(), PATH: '/nowhere' },
    existsImpl: (p) => p === '/opt/homebrew/bin/pnpm',
  }))
  assert.equal(r.ok, true)
  assert.equal(spawn.calls[0].file, '/opt/homebrew/bin/pnpm', 'homebrew 兜底位顶上')
})

// ── 路由接线（仓库检出形态下自然收敛 unsupported-layout，不真装）────────────

test('路由接线：POST self-update 过围栏、200 收敛且不真装', async () => {
  // 沿用 routes.test.mjs 的假 ctx 骨架：webServer.register 收集 handler。
  const { makeFakeCtx, makeRegistry } = await import('./fixtures.mjs')
  const { registerCreatorRoutes } = await import('../index.mjs')
  const { ctx, routes } = makeFakeCtx({ registry: makeRegistry([]) })
  await registerCreatorRoutes(ctx)
  assert.equal(routes.length, 1)

  const req = { method: 'POST', url: '/api/maoying/self-update', headers: { host: '127.0.0.1:58281' } }
  const state = { status: 0, headers: null, raw: '' }
  const res = {
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(chunk) { state.raw = typeof chunk === 'string' ? chunk : String(chunk) },
  }
  await routes[0].handler(req, res)
  assert.equal(state.status, 200, '可预期失败统一 HTTP 200 + ok:false')
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, false, '仓库检出形态（非 profile 目录安装）必须拒绝，绝不真跑 pnpm')
  assert.equal(typeof body.kind, 'string')
  assert.ok(body.kind !== '')
})
