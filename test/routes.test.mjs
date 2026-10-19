/**
 * 路由层测试：不真起 HTTP 服务，用最小假件直接驱动 registerCreatorRoutes
 * 注册出的 handler——webServer.register 收集路由，req/res 用 EventEmitter +
 * 记账对象模拟（最小 IncomingMessage/ServerResponse 形状）。
 *
 * 覆盖：信任围栏（Host / sec-fetch-site / origin / trustedHosts）、state 契约
 * 字段、chapter-status 流转与防穿越、foreshadow-status、phase、rebuild-index、
 * chapter 读取、404、413，以及 registerPrefixRouteWithRetry 的重试语义和
 * apply() 末尾「路由注册失败只 warn」的降级路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 测试全程把 DSH_HOME 钉在一次性临时目录——路由内部默认解析路径绝不落真实 ~/.dsh。
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'maoying-routes-home-'))
process.env.DSH_HOME = TEST_HOME

const { buildSampleNovel, makeRegistry, makeFakeCtx } = await import('./fixtures.mjs')
const { registerCreatorRoutes, registerPrefixRouteWithRetry } = await import('../index.mjs')

// ── 假 req/res ──────────────────────────────────────────────────────────────

/** 最小请求假件：POST 体经微任务送达，让 readBody 的监听器先挂上。 */
function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  const state = { status: 0, headers: null, raw: '' }
  const res = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) state.raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    },
  }
  return { res, state }
}

async function call(handler, opts) {
  const { res, state } = fakeRes()
  await handler(fakeReq(opts), res)
  return state
}

/** 受信回环请求的默认头。 */
const LOOPBACK = { host: '127.0.0.1:58281' }

function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maoying-ws-'))
  buildSampleNovel(root)
  const { ctx, routes } = makeFakeCtx({ registry: makeRegistry([root]) })
  return { root, ctx, routes }
}

async function registeredHandler(env) {
  await registerCreatorRoutes(env.ctx)
  assert.equal(env.routes.length, 1)
  assert.equal(env.routes[0].kind, 'prefix')
  assert.equal(env.routes[0].path, '/api/maoying')
  return env.routes[0].handler
}

// ── 信任围栏 ────────────────────────────────────────────────────────────────

test('围栏：无 Host / 非回环非受信 Host 一律 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const noHost = await call(handler, { url: '/api/maoying/workspaces' })
  assert.equal(noHost.status, 403)
  assert.deepEqual(JSON.parse(noHost.raw), { error: 'forbidden' })
  const evil = await call(handler, { url: '/api/maoying/workspaces', headers: { host: 'evil.example.com:80' } })
  assert.equal(evil.status, 403)
})

test('围栏：sec-fetch-site cross-site 403（即便 Host 回环）', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, {
    url: '/api/maoying/workspaces',
    headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(state.status, 403)
  assert.deepEqual(JSON.parse(state.raw), { error: 'forbidden' })
})

test('围栏：origin 异源 403，同源放行', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const evil = await call(handler, { url: '/api/maoying/workspaces', headers: { ...LOOPBACK, origin: 'http://evil.example.com' } })
  assert.equal(evil.status, 403)
  const same = await call(handler, { url: '/api/maoying/workspaces', headers: { ...LOOPBACK, origin: 'http://127.0.0.1:58281' } })
  assert.equal(same.status, 200)
})

test('围栏：Host 回环放行', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, { url: '/api/maoying/workspaces', headers: LOOPBACK })
  assert.equal(state.status, 200)
})

test('围栏：webRuntime.trustedHosts 实时读取，精确 host:port 匹配', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maoying-ws2-'))
  const { ctx, routes } = makeFakeCtx({
    registry: makeRegistry([root]),
    webRuntime: { trustedHosts: ['maoying.example:8443'] },
  })
  await registerCreatorRoutes(ctx)
  const handler = routes[0].handler
  const trusted = await call(handler, { url: '/api/maoying/workspaces', headers: { host: 'maoying.example:8443' } })
  assert.equal(trusted.status, 200)
  const wrongPort = await call(handler, { url: '/api/maoying/workspaces', headers: { host: 'maoying.example:9999' } })
  assert.equal(wrongPort.status, 403)
})

// ── 读路由 ──────────────────────────────────────────────────────────────────

test('state：契约字段就位（root/novelDir/found/project/totals/warnings）', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, {
    url: `/api/maoying/state?path=${encodeURIComponent(env.root)}`,
    headers: LOOPBACK,
  })
  assert.equal(state.status, 200)
  assert.match(String(state.headers['content-type']), /application\/json/)
  const snap = JSON.parse(state.raw)
  assert.equal(snap.ok, true)
  assert.equal(snap.root, path.resolve(env.root))
  assert.equal(snap.novelDir, path.join(path.resolve(env.root), 'novel'))
  assert.equal(snap.found, true)
  assert.equal(snap.project.title, '雪葬长夜')
  assert.equal(snap.chapters.length, 2)
  assert.ok(snap.chapters[0].cognitive_frame !== undefined)
  assert.deepEqual(snap.totals.byStatus, { pending: 0, writing: 1, review: 0, accepted: 1 })
  assert.ok(snap.warnings.some((w) => w.includes('characters/broken.md')))
  assert.ok(!Number.isNaN(Date.parse(snap.generatedAt)))
})

test('state：path 越界 403、缺 path 422', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const foreign = await call(handler, { url: `/api/maoying/state?path=${encodeURIComponent('/etc')}`, headers: LOOPBACK })
  assert.equal(foreign.status, 403)
  const missing = await call(handler, { url: '/api/maoying/state', headers: LOOPBACK })
  assert.equal(missing.status, 422)
  assert.equal(JSON.parse(missing.raw).ok, false)
})

test('chapter：返回 frontmatter 对象与正文全文', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, {
    url: `/api/maoying/chapter?path=${encodeURIComponent(env.root)}&file=${encodeURIComponent('v01-c001.md')}`,
    headers: LOOPBACK,
  })
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.raw)
  assert.equal(payload.ok, true)
  assert.equal(payload.file, 'v01-c001.md')
  assert.equal(payload.frontmatter.title, '雪夜来客')
  assert.ok(payload.body.startsWith('雪下了三天'))
  const traversal = await call(handler, {
    url: `/api/maoying/chapter?path=${encodeURIComponent(env.root)}&file=${encodeURIComponent('../project.yml')}`,
    headers: LOOPBACK,
  })
  assert.equal(traversal.status, 403)
})

test('workspaces：探测 hasNovel', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, { url: '/api/maoying/workspaces', headers: LOOPBACK })
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.raw)
  assert.equal(payload.ok, true)
  assert.equal(payload.workspaces.length, 1)
  assert.equal(payload.workspaces[0].hasNovel, true)
})

// ── 写路由 ──────────────────────────────────────────────────────────────────

test('chapter-status：流转生效；非法值 422；防穿越 403 不落盘', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const post = (body) => call(handler, { method: 'POST', url: '/api/maoying/chapter-status', headers: LOOPBACK, body })

  const ok = await post({ path: env.root, file: 'v01-c002.md', status: 'review' })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.raw), { ok: true, file: 'v01-c002.md', status: 'review' })
  const onDisk = readFileSync(path.join(env.root, 'novel', 'chapters', 'v01-c002.md'), 'utf8')
  assert.ok(onDisk.includes('status: review'))

  assert.equal((await post({ path: env.root, file: 'v01-c001.md', status: 'done' })).status, 422)
  const traversal = await post({ path: env.root, file: '../project.yml', status: 'writing' })
  assert.equal(traversal.status, 403)
  // project.yml 毫发无损（phase 行还在，没被当 status 行动过）
  assert.ok(readFileSync(path.join(env.root, 'novel', 'project.yml'), 'utf8').includes('phase: writing'))
})

test('foreshadow-status 与 phase：流转生效；未知 id 404；非法值 422', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)

  const fs1 = await call(handler, {
    method: 'POST', url: '/api/maoying/foreshadow-status', headers: LOOPBACK,
    body: { path: env.root, id: 'fs-001', status: 'progressing' },
  })
  assert.equal(fs1.status, 200)
  assert.ok(readFileSync(path.join(env.root, 'novel', 'foreshadows.yml'), 'utf8').includes('status: progressing'))

  assert.equal((
    await call(handler, {
      method: 'POST', url: '/api/maoying/foreshadow-status', headers: LOOPBACK,
      body: { path: env.root, id: 'fs-999', status: 'resolved' },
    })
  ).status, 404)

  const phase = await call(handler, {
    method: 'POST', url: '/api/maoying/phase', headers: LOOPBACK,
    body: { path: env.root, phase: 'review' },
  })
  assert.equal(phase.status, 200)
  assert.ok(readFileSync(path.join(env.root, 'novel', 'project.yml'), 'utf8').includes('phase: review'))

  assert.equal((
    await call(handler, {
      method: 'POST', url: '/api/maoying/phase', headers: LOOPBACK,
      body: { path: env.root, phase: 'forever' },
    })
  ).status, 422)
})

test('rebuild-index：index.yml 重建生效，响应带章节数', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, {
    method: 'POST', url: '/api/maoying/rebuild-index', headers: LOOPBACK,
    body: { path: env.root },
  })
  assert.equal(state.status, 200)
  assert.deepEqual(JSON.parse(state.raw), { ok: true, chapters: 2 })
  const index = readFileSync(path.join(env.root, 'novel', 'index.yml'), 'utf8')
  assert.ok(index.includes('雪夜来客'))
  assert.ok(index.includes('total: {chapters: 2, words: 31, accepted: 1}'))
})

test('client.css：文件缺席回 500 JSON 错误；在位则 text/css no-cache（兼容并行的客户端任务）', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, { url: '/api/maoying/client.css', headers: LOOPBACK })
  if (state.status === 200) {
    assert.match(String(state.headers['content-type']), /text\/css/)
    assert.equal(state.headers['cache-control'], 'no-cache')
  } else {
    // lib/base.css 由客户端任务并行创建；缺席只允许 500 一种形态
    assert.equal(state.status, 500)
    assert.equal(JSON.parse(state.raw).ok, false)
  }
})

test('未知路由 404；超大请求体 413', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const notFound = await call(handler, { url: '/api/maoying/nope', headers: LOOPBACK })
  assert.equal(notFound.status, 404)
  assert.equal(JSON.parse(notFound.raw).ok, false)

  const tooBig = await call(handler, {
    method: 'POST', url: '/api/maoying/phase', headers: LOOPBACK,
    body: Buffer.alloc(5 * 1024 * 1024 + 1, 97),
  })
  assert.equal(tooBig.status, 413)
  assert.equal(JSON.parse(tooBig.raw).ok, false)
})

// ── 注册机制 ────────────────────────────────────────────────────────────────

test('registerPrefixRouteWithRetry：duplicate 短重试后成功；其他错误立即抛', async () => {
  let duplicateHits = 0
  const flaky = {
    register() {
      duplicateHits += 1
      if (duplicateHits < 3) throw new Error('webserver: duplicate prefix route "/api/maoying" already registered')
      return () => {}
    },
  }
  const disposer = await registerPrefixRouteWithRetry(flaky, { kind: 'prefix', path: '/api/maoying', handler() {} }, { delayMs: 1 })
  assert.equal(typeof disposer, 'function')
  assert.equal(duplicateHits, 3)

  const boom = { register() { throw new Error('boom') } }
  await assert.rejects(() => registerPrefixRouteWithRetry(boom, { kind: 'prefix', path: '/api/x', handler() {} }, { attempts: 2, delayMs: 1 }), /boom/)

  const always = { register() { throw new Error('webserver: duplicate prefix route "/api/maoying" already registered') } }
  await assert.rejects(() => registerPrefixRouteWithRetry(always, { kind: 'prefix', path: '/api/x', handler() {} }, { attempts: 2, delayMs: 1 }), /duplicate prefix route/)
})

test('apply()：webServer 缺席时路由注册失败只 warn，不抛不炸', async () => {
  const { warns } = makeFakeCtx({ registry: makeRegistry([]) })
  const { apply } = await import('../index.mjs')
  // 真跑安装段（DSH_HOME 钉在 /tmp 临时目录），随后注册段按 warn 降级
  apply({ logger: { info() {}, warn(...args) { warns.push(args.map(String).join(' ')) } }, webServer: {} })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    warns.some((w) => w.includes('毛颖创作台路由注册失败（面板不可用，其余功能不受影响）')),
    `应有路由注册失败警告，实得 ${JSON.stringify(warns)}`,
  )
})
