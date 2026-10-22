/**
 * self-update 单测：全注入、零真实副作用——版本预检的 fetch 桩定、pnpm 候选链
 * 的 spawn 契约桩定（spawnImpl 即执行器，直接收敛 { code, output, error?,
 * errorCode? }，不再构造假 child），文件系统探测全走注入假件（pkgDirImpl /
 * realpathImpl / existsImpl / readdirImpl）。defaultSpawn 的三条收敛路径
 * （正常退出 / ENOENT / 超时 SIGTERM）用真实短命 node 子进程直测。
 *
 * 覆盖：安装形态两道闸（dev-link / unsupported-layout）、版本预检（registry ok
 * → mirror 兜底 → 双败 no-target）、up-to-date 短路、候选链顺序与 ENOENT 换路
 * （pnpm-missing 出路文案）、cwd=profileDir、精确版本安装（无 @latest）、
 * profile-missing、超时 / 非零退出、成功流 from/to/restartRequired、win32
 * shell 分支、in-flight 去重，以及 index.mjs 路由接线（仓库检出形态下 200 +
 * ok:false 收敛，不真装、不发外网请求）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { selfUpdate, resetSelfUpdateInflight, defaultSpawn } from '../lib/self-update.mjs'
import { currentVersion } from '../lib/version.mjs'

// 假安装位：env 钉死的 profile 布局路径（不落盘，探测全走注入假件）。
const HOME = '/tmp/maoying-selfupdate-fakehome'
const PROFILE_DIR = path.join(HOME, 'profiles', 'desktop')
const LAYOUT_DIR = path.join(PROFILE_DIR, 'node_modules', 'dsh-maoying')

/** 真实本地版本（currentVersion 读仓库检出 package.json，预检比较的基准）。 */
const CURRENT = (await currentVersion()).version

/** 基准 env：desktop 档。 */
function baseEnv() {
  return { DSH_HOME: HOME, DSH_PROFILE: 'desktop', PATH: '/usr/bin:/bin', HOME: '/Users/fake' }
}

const silentLogger = { info() {}, warn() {}, error() {} }

/**
 * npm manifest 桩：registry.npmjs.org 命中 registry 设定，npmmirror 命中 mirror
 * 设定；{ ok:false } 时回 HTTP 500。calls 记录命中的端点次序。
 */
function npmStub({ registry = { ok: true, version: '1.2.3' }, mirror = { ok: false, error: 'x' } } = {}) {
  const calls = []
  const impl = async (url) => {
    const u = String(url)
    calls.push(u.includes('registry.npmjs.org') ? 'registry' : 'mirror')
    const which = u.includes('registry.npmjs.org') ? registry : mirror
    if (!which.ok) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ version: which.version }) }
  }
  impl.calls = calls
  return impl
}

/**
 * spawn 契约桩（paoding 形状执行器）：逐次调用记 (command, args, opts,
 * timeoutMs, timeoutLabel) 并按脚本序收敛结果；脚本耗尽后复用最后一条
 * （全 ENOENT 链就靠这一条走完）。脚本项可为函数（动态延迟等）。
 */
function spawnScripter(results) {
  const calls = []
  const impl = (command, args, opts, timeoutMs, timeoutLabel) => {
    calls.push({ command, args, opts, timeoutMs, timeoutLabel })
    const r = results[Math.min(calls.length - 1, results.length - 1)]
    return Promise.resolve(typeof r === 'function' ? r() : r)
  }
  impl.calls = calls
  return impl
}

const ENOENT_RESULT = { code: null, output: '', errorCode: 'ENOENT' }
const spawnOk = (output = 'added 1 package') => spawnScripter([{ code: 0, output }])

/** existsImpl 常用形：只认 profile 的 package.json（就绪闸）+ 指定白名单。 */
function existsFor(extra = []) {
  const set = new Set([path.join(PROFILE_DIR, 'package.json'), ...extra])
  return (p) => set.has(p)
}

/** readdirImpl 常用形：/opt/homebrew/opt 不存在（抛 ENOENT）。 */
function noHomebrewOpt() {
  const err = new Error('ENOENT')
  err.code = 'ENOENT'
  return () => { throw err }
}

/** 常用依赖组合：真路径即布局路径（正常目录安装形态），第三路候选成功。 */
function layoutDeps(overrides = {}) {
  return {
    env: baseEnv(),
    logger: silentLogger,
    pkgDirImpl: () => LAYOUT_DIR,
    realpathImpl: (p) => p, // 透传 = 真路径与常规路径一致（非 symlink）
    existsImpl: existsFor(['/opt/homebrew/bin/corepack']),
    readdirImpl: noHomebrewOpt(),
    fetchImpl: npmStub(),
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    // pnpm / corepack 两路 ENOENT，第三路（homebrew corepack）成功。
    spawnImpl: spawnScripter([ENOENT_RESULT, ENOENT_RESULT, { code: 0, output: 'added 1 package' }]),
    ...overrides,
  }
}

// ── 安装形态闸 ──────────────────────────────────────────────────────────────

test('dev-link 拒绝：真路径 ≠ 常规路径（symlink 到 dev repo）绝不 spawn、不发外网请求', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([])
  const fetch = npmStub()
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    fetchImpl: fetch,
    pkgDirImpl: () => '/repo/dsh-maoying',
    realpathImpl: () => '/real/dev-repo/dsh-maoying',
  }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'dev-link')
  assert.match(r.message, /git pull/, 'dev-link message 给出手动出路（git pull）')
  assert.equal(spawn.calls.length, 0, 'dev-link 一票否决，绝不执行安装')
  assert.equal(fetch.calls.length, 0, '形态闸在版本预检之前，不发外网请求')
})

test('unsupported-layout：真路径没有 profiles/node_modules 祖先结构', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([])
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
  const spawn = spawnScripter([])
  const otherProfile = path.join(HOME, 'profiles', 'dev', 'node_modules', 'dsh-maoying')
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    pkgDirImpl: () => otherProfile,
  }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'unsupported-layout')
  assert.equal(spawn.calls.length, 0)
})

// ── 版本预检 ────────────────────────────────────────────────────────────────

test('版本预检：registry ok 直接采用，装精确版本 dsh-maoying@<target> 且无 @latest', async () => {
  resetSelfUpdateInflight()
  const fetch = npmStub({ registry: { ok: true, version: '1.2.3' } })
  const spawn = spawnScripter([{ code: 0, output: 'ok' }])
  const r = await selfUpdate(layoutDeps({ fetchImpl: fetch, spawnImpl: spawn, existsImpl: existsFor() }))
  assert.equal(r.ok, true)
  assert.equal(fetch.calls.length, 1, 'registry 成功不请求镜像')
  assert.equal(spawn.calls.length, 1)
  assert.ok(spawn.calls[0].args.includes('dsh-maoying@1.2.3'), '装精确版本')
  assert.equal(spawn.calls.some((c) => c.args.some((a) => String(a).includes('@latest'))), false, '绝不用 @latest')
})

test('版本预检：registry 失败回落 npmmirror 镜像', async () => {
  resetSelfUpdateInflight()
  const fetch = npmStub({ registry: { ok: false }, mirror: { ok: true, version: '2.0.0' } })
  const spawn = spawnScripter([{ code: 0, output: 'ok' }])
  const r = await selfUpdate(layoutDeps({ fetchImpl: fetch, spawnImpl: spawn, existsImpl: existsFor() }))
  assert.equal(r.ok, true)
  assert.deepEqual(fetch.calls, ['registry', 'mirror'], '先 registry 后 mirror')
  assert.ok(spawn.calls[0].args.includes('dsh-maoying@2.0.0'), '镜像拿到的目标版本照装')
})

test('版本预检：两路全败 kind:no-target，不 spawn 不做半截升级', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([])
  const fetch = npmStub({ registry: { ok: false }, mirror: { ok: false } })
  const r = await selfUpdate(layoutDeps({ fetchImpl: fetch, spawnImpl: spawn }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'no-target')
  assert.match(r.message, /官方源/)
  assert.match(r.message, /镜像/, 'message 带两路错误')
  assert.equal(spawn.calls.length, 0)
})

test('up-to-date 短路：线上目标不高于本地时 ok:true，不 spawn', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([])
  // v0.0.1 恒低于任何真实本地版本。
  const fetch = npmStub({ registry: { ok: true, version: '0.0.1' } })
  const r = await selfUpdate(layoutDeps({ fetchImpl: fetch, spawnImpl: spawn }))
  assert.deepEqual(
    { ok: r.ok, kind: r.kind, from: r.from },
    { ok: true, kind: 'up-to-date', from: CURRENT },
    'up-to-date 短路返回 { ok, kind, from: current }',
  )
  assert.equal(spawn.calls.length, 0)
})

// ── 候选链与 spawn 契约 ─────────────────────────────────────────────────────

test('候选链顺序：pnpm → corepack（前两路 ENOENT）→ /opt/homebrew/bin/corepack 成功', async () => {
  resetSelfUpdateInflight()
  const deps = layoutDeps() // 默认脚本：pnpm ENOENT → corepack ENOENT → homebrew corepack 成功
  const spawn = deps.spawnImpl
  const r = await selfUpdate(deps)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'installed')
  assert.equal(spawn.calls.length, 3, 'existsSync 预筛：不存在的绝对路径候选不浪费 spawn')
  const [a, b, c] = spawn.calls
  assert.equal(a.command, 'pnpm')
  assert.deepEqual(a.args, ['add', 'dsh-maoying@1.2.3'])
  assert.equal(b.command, 'corepack')
  assert.deepEqual(b.args, ['pnpm', 'add', 'dsh-maoying@1.2.3'], 'corepack 候选带 pnpm 参数前缀')
  assert.equal(c.command, '/opt/homebrew/bin/corepack', '绝对路径候选命中即停')
  assert.deepEqual(c.args, ['add', 'dsh-maoying@1.2.3'], '绝对路径候选不带 pnpm 前缀')
  for (const call of spawn.calls) {
    assert.equal(call.opts.cwd, PROFILE_DIR, 'cwd 就是 profile 目录，不带 --dir')
    assert.equal(call.opts.shell, false, 'darwin 恒 shell:false')
    assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(call.timeoutMs, 180000, '超时随注入透传给 spawn 契约')
    assert.equal(call.timeoutLabel, 'pnpm add')
    assert.equal(call.args.some((x) => String(x).includes('@latest')), false)
  }
})

test('候选链：/opt/homebrew/opt 下 node 版本目录经 readdirImpl 展开、按序命中', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([ENOENT_RESULT, ENOENT_RESULT, { code: 0, output: 'ok' }])
  const r = await selfUpdate(layoutDeps({
    spawnImpl: spawn,
    existsImpl: existsFor(['/opt/homebrew/opt/node@24/bin/corepack']),
    readdirImpl: () => ['yaml', 'node@20', 'node@24'], // 非 node 目录被过滤
  }))
  assert.equal(r.ok, true)
  const c = spawn.calls[2]
  assert.equal(c.command, '/opt/homebrew/opt/node@24/bin/corepack', 'readdir 展开的 keg-only 候选命中')
  assert.deepEqual(c.args, ['add', 'dsh-maoying@1.2.3'])
})

test('全候选 ENOENT：kind:pnpm-missing，message 带 corepack enable 出路与手动命令', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([ENOENT_RESULT]) // 复用最后一条 → 全链 ENOENT
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn, existsImpl: existsFor() }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'pnpm-missing')
  assert.match(r.message, /corepack enable/)
  assert.match(r.message, new RegExp(`cd ${PROFILE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && corepack pnpm add dsh-maoying@1\\.2\\.3`))
  assert.equal(spawn.calls.length, 2, '只剩两个裸候选（pnpm / corepack）')
})

test('profile 缺 package.json：kind:profile-missing，不 spawn', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([])
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn, existsImpl: () => false }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'profile-missing')
  assert.match(r.message, /package\.json/)
  assert.equal(spawn.calls.length, 0)
})

test('pnpm 非零退出：kind:nonzero + 输出尾部进 message', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([{ code: 1, output: 'ERR_PNPM_BAD_REGISTRY happened' }])
  const r = await selfUpdate(layoutDeps({ spawnImpl: spawn, existsImpl: existsFor(['/opt/homebrew/bin/corepack']) }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'nonzero')
  assert.match(r.message, /exit 1/)
  assert.match(r.message, /ERR_PNPM_BAD_REGISTRY/, '失败信息带子进程输出尾部便于排障')
})

// ── 成功流 / win32 / 去重 ───────────────────────────────────────────────────

test('成功流：from/to/restartRequired 就位，to 为精确目标版本', async () => {
  resetSelfUpdateInflight()
  const r = await selfUpdate(layoutDeps({}))
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'installed')
  assert.equal(r.from, CURRENT, 'from 取本地当前版本')
  assert.equal(r.to, '1.2.3', 'to 为预检到的精确目标版本')
  assert.equal(r.restartRequired, true, '装完仍是旧进程，必须重启才生效')
})

test('win32：候选补 .cmd 后缀、spawn shell:true、corepack 带 pnpm 前缀', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([ENOENT_RESULT])
  const r = await selfUpdate(layoutDeps({ platform: 'win32', spawnImpl: spawn, existsImpl: existsFor() }))
  assert.equal(r.kind, 'pnpm-missing')
  assert.equal(spawn.calls[0].command, 'pnpm.cmd')
  assert.equal(spawn.calls[1].command, 'corepack.cmd')
  assert.equal(spawn.calls[1].args[0], 'pnpm')
  assert.equal(spawn.calls[0].opts.shell, true, '.cmd shim 必须经 shell 拉起（CVE-2024-27980）')
  assert.ok(spawn.calls.every((c) => c.command.endsWith('.cmd')))
})

test('并发去重：同一时刻两次调用只 spawn 一次、共享同一结果', async () => {
  resetSelfUpdateInflight()
  const spawn = spawnScripter([() => new Promise((resolve) => setTimeout(() => resolve({ code: 0, output: 'ok' }), 20))])
  const [a, b] = await Promise.all([
    selfUpdate(layoutDeps({ spawnImpl: spawn, existsImpl: existsFor(['/opt/homebrew/bin/corepack']) })),
    selfUpdate({ env: baseEnv() }), // 第二次调用不带注入也复用第一次的 in-flight
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a, b, '并发调用共享同一 in-flight promise')
  assert.equal(spawn.calls.length, 1, 'pnpm add 绝不并发跑两份')
})

// ── defaultSpawn（真实短命子进程，直测缺省执行器契约）────────────────────────

test('defaultSpawn：正常退出收敛 { code, output }，stdout+stderr 合并', async () => {
  const r = await defaultSpawn(
    process.execPath,
    ['-e', 'process.stdout.write("out-tail"); process.stderr.write("err-tail")'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
    10000,
    '测试',
  )
  assert.equal(r.code, 0)
  assert.match(r.output, /out-tail/)
  assert.match(r.output, /err-tail/, 'stderr 并入同一 output')
  assert.equal(r.error, undefined)
  assert.equal(r.errorCode, undefined)
})

test('defaultSpawn：spawn 失败（ENOENT）带 errorCode，不 reject', async () => {
  const r = await defaultSpawn('maoying-definitely-not-a-binary-xyz', [], {}, 10000, '测试')
  assert.equal(r.errorCode, 'ENOENT')
  assert.equal(r.code, null)
  assert.ok(r.error.length > 0)
})

test('defaultSpawn：超时 SIGTERM kill，收敛 errorCode ETIMEDOUT', async () => {
  const r = await defaultSpawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
    150,
    '测试',
  )
  assert.equal(r.errorCode, 'ETIMEDOUT', '超时进程被 kill 且结构化收敛')
  assert.match(r.error, /超时/)
})

// ── 路由接线（仓库检出形态下自然收敛 unsupported-layout，不真装、不出网）────

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
  assert.equal(body.kind, 'unsupported-layout', '形态闸在版本预检之前，仓库检出直接收敛')
})
