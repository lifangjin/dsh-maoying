/**
 * 路由层测试：不真起 HTTP 服务，用最小假件直接驱动 registerCreatorRoutes
 * 注册出的 handler——webServer.register 收集路由，req/res 用 EventEmitter +
 * 记账对象模拟（最小 IncomingMessage/ServerResponse 形状）。
 *
 * 覆盖：信任围栏（Host / sec-fetch-site / origin 完整 scheme+host+port 同源
 * 校验 / trustedHosts）、state 契约字段、chapter-status 流转与防穿越、
 * foreshadow-status、phase、rebuild-index、chapter 读取、outline 章纲全文
 * 读取、chapter-create 从章纲建章、404、413（响应体可达：先回包后断开）、
 * 迭代路由接线（project-save 改键与越枚举 422、
 * update-check 响应形状、host-debug 五级探针与脱敏、非法 JSON body 400），
 * 以及 registerPrefixRouteWithRetry 的重试语义（同步抛与 rejected promise
 * 两条路）和 apply() 末尾「路由注册失败只 warn」的降级路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试全程把 DSH_HOME 钉在一次性临时目录——路由内部默认解析路径绝不落真实 ~/.dsh。
const PREV_DSH_HOME = process.env.DSH_HOME
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'maoying-routes-home-'))
process.env.DSH_HOME = TEST_HOME

// 进程退出前统一收尾：恢复 DSH_HOME、删本文件的临时 home 与各测试工作区
// （对照 installer-shape.test.mjs 的 test.after 写法）。
const cleanup = []
test.after(() => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREV_DSH_HOME
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})
cleanup.push(TEST_HOME)

const { buildSampleNovel, makeRegistry, makeFakeCtx } = await import('./fixtures.mjs')
const { registerCreatorRoutes, registerPrefixRouteWithRetry } = await import('../index.mjs')

// 插件根（host-debug 脱敏断言用）：本测试跑在仓库 test/ 下，上一级即插件根。
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  cleanup.push(root)
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

test('围栏：origin 同源放行；异源 403（异主机、异端口、异 scheme 都算）', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  // 异主机
  const evil = await call(handler, { url: '/api/maoying/workspaces', headers: { ...LOOPBACK, origin: 'http://evil.example.com' } })
  assert.equal(evil.status, 403)
  // 同 hostname 不同端口：sec-fetch-site 对它是 same-site（围栏拦不住），只能
  // 靠 origin 与 Host 的 host:port 全串比较挡下（回归：只比 hostname 的漏放）
  const wrongPort = await call(handler, { url: '/api/maoying/workspaces', headers: { ...LOOPBACK, origin: 'http://127.0.0.1:9999' } })
  assert.equal(wrongPort.status, 403)
  // scheme 不一致同样不是同源
  const wrongScheme = await call(handler, { url: '/api/maoying/workspaces', headers: { ...LOOPBACK, origin: 'https://127.0.0.1:58281' } })
  assert.equal(wrongScheme.status, 403)
  // 完整同源（scheme+host+port 全同）放行
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
  cleanup.push(root)
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
  // outlines（五期）：夹具两份章纲按卷-章号升序，孤儿章纲（v01-c003）照列
  assert.deepEqual(snap.outlines.map((o) => o.file), ['v01-c001.md', 'v01-c003.md'])
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
  // outline（五期，§2 契约 { ok, file, frontmatter, body, outline }）：
  // 有章纲 → { file, words, body }；无章纲 → null
  assert.ok(payload.outline, 'chapter 响应应带 outline 字段')
  assert.equal(payload.outline.file, 'v01-c001.md')
  assert.ok(payload.outline.words > 0)
  assert.ok(payload.outline.body.includes('章纲'))
  const bare = await call(handler, {
    url: `/api/maoying/chapter?path=${encodeURIComponent(env.root)}&file=${encodeURIComponent('v01-c002.md')}`,
    headers: LOOPBACK,
  })
  assert.equal(bare.status, 200)
  assert.equal(JSON.parse(bare.raw).outline, null)
  const traversal = await call(handler, {
    url: `/api/maoying/chapter?path=${encodeURIComponent(env.root)}&file=${encodeURIComponent('../project.yml')}`,
    headers: LOOPBACK,
  })
  assert.equal(traversal.status, 403)
})

test('outline：章纲全文 200；孤儿章纲照读；缺文件 404；非章纲文件名 422；防穿越 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const get = (file) => call(handler, {
    url: `/api/maoying/outline?path=${encodeURIComponent(env.root)}&file=${encodeURIComponent(file)}`,
    headers: LOOPBACK,
  })
  const state = await get('v01-c003.md') // 孤儿章纲：chapters/ 无对应文件（弹层主取数路径）
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.raw)
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'file', 'ok', 'words'])
  assert.equal(payload.ok, true)
  assert.equal(payload.file, 'v01-c003.md')
  assert.ok(payload.words > 0)
  assert.ok(payload.body.includes('冻河'))
  assert.equal((await get('v01-c099.md')).status, 404)
  assert.equal((await get('scratch.md')).status, 422)
  assert.equal((await get('v01-c003.txt')).status, 422)
  assert.equal((await get('../project.yml')).status, 403)
})

test('chapter-create：从章纲建章 200 落盘 pending 空章；重复建章 409；防穿越 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const post = (file) => call(handler, {
    method: 'POST', url: '/api/maoying/chapter-create', headers: LOOPBACK,
    body: { path: env.root, file },
  })
  const state = await post('v01-c003.md')
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.raw)
  assert.equal(payload.ok, true)
  assert.equal(payload.file, 'v01-c003.md')
  // 夹具章纲标题「第三章 冻河追踪 章纲（正文未写）」结尾不是「章纲」二字 → 不剥离
  assert.equal(payload.title, '第三章 冻河追踪 章纲（正文未写）')
  const onDisk = readFileSync(path.join(env.root, 'novel', 'chapters', 'v01-c003.md'), 'utf8')
  assert.ok(onDisk.startsWith('---\n'), '落盘应为 frontmatter 围栏开头')
  assert.ok(onDisk.includes('status: pending'))
  assert.ok(onDisk.includes('title: 第三章 冻河追踪 章纲（正文未写）'))
  // state 快照联动：新章 pending 进 chapters 清单
  const snap = await call(handler, {
    url: `/api/maoying/state?path=${encodeURIComponent(env.root)}`,
    headers: LOOPBACK,
  })
  const created = JSON.parse(snap.raw).chapters.find((c) => c.file === 'v01-c003.md')
  assert.ok(created, '新章应进 state.chapters')
  assert.equal(created.status, 'pending')
  // 重复建章 409（先到先建不覆盖）；夹具既有章同理
  const dup = await post('v01-c003.md')
  assert.equal(dup.status, 409)
  assert.equal(JSON.parse(dup.raw).ok, false)
  assert.equal((await post('v01-c001.md')).status, 409)
  // 防穿越 403 / 缺文件 404
  assert.equal((await post('../project.yml')).status, 403)
  assert.equal((await post('v01-c099.md')).status, 404)
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

  // 413 响应体可达：readBody 先回 JSON 再断开连接（修复前先 destroy，客户端
  // 只能收到 ECONNRESET 空响应）——假件下必须收到完整 { ok: false, error }。
  const tooBig = await call(handler, {
    method: 'POST', url: '/api/maoying/phase', headers: LOOPBACK,
    body: Buffer.alloc(5 * 1024 * 1024 + 1, 97),
  })
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.headers['content-type'], 'application/json; charset=utf-8')
  assert.ok(tooBig.raw.length > 0, '413 必须带 JSON 响应体而非空')
  const tooBigPayload = JSON.parse(tooBig.raw)
  assert.equal(tooBigPayload.ok, false)
  assert.match(tooBigPayload.error, /too large/)
})

// ── 迭代路由接线：project-save / update-check / host-debug / 坏 JSON ─────────

test('project-save：正常改键 200 且保行尾注释；mode/phase 越枚举 422 点名字段', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const ok = await call(handler, {
    method: 'POST', url: '/api/maoying/project-save', headers: LOOPBACK,
    body: {
      path: env.root,
      values: {
        title: '雪葬长夜（改）', author: '试笔人', genre: '东方玄幻', length: '约100万字',
        language: 'zh', phase: 'outline', mode: 'co-write', description: '北境雪灾后的长生局。',
      },
    },
  })
  assert.equal(ok.status, 200)
  const saved = JSON.parse(ok.raw)
  assert.equal(saved.ok, true)
  // 人工改动保护：响应带写后 project.yml 指纹（客户端下一轮保存的 base_hash）
  assert.match(saved.project_hash, /^[0-9a-f]{64}$/)
  const project = readFileSync(path.join(env.root, 'novel', 'project.yml'), 'utf8')
  assert.ok(project.includes('title: 雪葬长夜（改）'))
  assert.ok(project.includes('mode: co-write'), '改键应落盘')
  assert.ok(project.includes('# 五期模式开关'), '行尾注释应原样保留')

  // 越枚举：mutateProject 先验 phase 后验 mode，两个方向各一例，错误点名字段
  for (const [field, values] of [
    ['mode', { phase: 'writing', mode: 'solo' }],
    ['phase', { phase: 'forever', mode: 'ai-draft' }],
  ]) {
    const bad = await call(handler, {
      method: 'POST', url: '/api/maoying/project-save', headers: LOOPBACK,
      body: { path: env.root, values: { title: 'x', ...values } },
    })
    assert.equal(bad.status, 422, `${field} 越枚举应 422`)
    assert.ok(JSON.parse(bad.raw).error.includes(field), `错误信息应点名 ${field}`)
  }
})

test('project-save：过期 base_hash 409 拒写（外部修改冲突），最新 base_hash 200', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const projectPath = path.join(env.root, 'novel', 'project.yml')
  const post = (base_hash) => call(handler, {
    method: 'POST', url: '/api/maoying/project-save', headers: LOOPBACK,
    body: { path: env.root, base_hash, values: { title: '基线试金石', phase: 'writing', mode: 'ai-draft' } },
  })

  // 过期指纹（磁盘上的 project.yml 与它不一致）→ 409 走统一错误通道，不落盘
  const stale = await post('0'.repeat(64))
  assert.equal(stale.status, 409)
  const staleBody = JSON.parse(stale.raw)
  assert.equal(staleBody.ok, false)
  assert.ok(staleBody.error.includes('外部修改'), `错误应点名外部修改：${staleBody.error}`)
  assert.ok(readFileSync(projectPath, 'utf8').includes('title: 雪葬长夜'), '409 拒写不得落盘')

  // 最新指纹 → 200，响应带写后新指纹
  const fresh = createHash('sha256').update(readFileSync(projectPath, 'utf8'), 'utf8').digest('hex')
  const ok = await post(fresh)
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.raw)
  assert.equal(body.ok, true)
  assert.match(body.project_hash, /^[0-9a-f]{64}$/)
  assert.ok(readFileSync(projectPath, 'utf8').includes('title: 基线试金石'))
})

test('check：status 越枚举章节透出 error 级问题；非白名单 path 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  // 面板快照会把越枚举 status 归一成 pending（人工改坏看不出来）——checkProject
  // 读 frontmatter 原文，这里造一个只有 check 才抓得到的坏章
  const chapterPath = path.join(env.root, 'novel', 'chapters', 'v01-c002.md')
  writeFileSync(chapterPath, readFileSync(chapterPath, 'utf8').replace('status: writing', 'status: done'), 'utf8')

  const state = await call(handler, {
    url: `/api/maoying/check?path=${encodeURIComponent(env.root)}`,
    headers: LOOPBACK,
  })
  assert.equal(state.status, 200)
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.problems))
  const hit = body.problems.find((p) => p.file === 'chapters/v01-c002.md' && p.level === 'error')
  assert.ok(hit, `problems 应含 v01-c002 的 error 条目：${JSON.stringify(body.problems)}`)
  assert.ok(hit.message.includes('status 越枚举'), `error 应点名 status 越枚举：${hit.message}`)

  // path 安全校验与 state 路由同款：白名单外一律 403
  const foreign = await call(handler, { url: `/api/maoying/check?path=${encodeURIComponent('/etc')}`, headers: LOOPBACK })
  assert.equal(foreign.status, 403)
})

test('update-check：200 且响应形状完整（三级源全败也回降级形状）', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, { url: '/api/maoying/update-check', headers: LOOPBACK })
  assert.equal(state.status, 200)
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, true)
  // 形状契约：在线检测可能全败（CI 无网/镜像限流），但字段一个不能少，
  // 降级形态 = latest 为 null / error 非 null / source 标注失败源
  for (const key of ['current', 'latest', 'updateAvailable', 'releaseUrl', 'checkedAt', 'error', 'source']) {
    assert.ok(key in body, `update-check 响应缺 ${key} 字段`)
  }
  assert.equal(typeof body.current, 'string')
  assert.equal(typeof body.updateAvailable, 'boolean')
  if (body.error !== null) {
    assert.equal(body.latest, null, '有 error 时 latest 应为 null（降级形状）')
  }
})

test('host-debug：200 含五级探针 trace，本机绝对路径脱敏', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, { url: '/api/maoying/host-debug', headers: LOOPBACK })
  assert.equal(state.status, 200)
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, true)
  // 轨迹形状：argv[1] / argv-scan / asar / desktop-runtime / electron-api /
  // home-global 每级都留痕，home-global 兜底恒在最后
  assert.ok(Array.isArray(body.trace) && body.trace.length >= 6, `trace 应覆盖全部探针：${JSON.stringify(body.trace)}`)
  for (const entry of body.trace) assert.equal(typeof entry.probe, 'string')
  assert.equal(body.trace.at(-1).probe, 'home-global')
  assert.ok(body.hostVersion === null || typeof body.hostVersion === 'string')
  assert.equal(body.shape, 'v1', '测试环境读不到宿主版本，形状判定应保守 v1')
  assert.ok(body.registry !== undefined && typeof body.runtime === 'object')
  // 脱敏纪律：测试 cwd 就是插件根，必进 runtime.cwd / argv——不得以绝对路径出门
  assert.ok(!state.raw.includes(PLUGIN_ROOT), 'host-debug 响应不得包含插件根绝对路径')
  assert.ok(body.runtime.cwd !== process.cwd(), 'cwd 应已脱敏为 ~ 前缀相对形态')
})

test('非法 JSON body：400 且 error 点名 invalid JSON', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, {
    method: 'POST', url: '/api/maoying/project-save', headers: LOOPBACK,
    body: Buffer.from('{not-json'),
  })
  assert.equal(state.status, 400)
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, false)
  assert.match(body.error, /invalid JSON/)
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

test('registerPrefixRouteWithRetry：register 返回 rejected promise 也接得住，重试后成功', async () => {
  // 宿主 register 可能走异步校验路径，duplicate 以 rejected promise 形态出现。
  // 修复前不 await：rejection 变 unhandled rejection 逃逸，短重试形同虚设。
  let calls = 0
  const asyncFlaky = {
    register() {
      calls += 1
      if (calls < 3) return Promise.reject(new Error('webserver: duplicate prefix route "/api/maoying" already registered'))
      return () => {}
    },
  }
  const disposer = await registerPrefixRouteWithRetry(asyncFlaky, { kind: 'prefix', path: '/api/maoying', handler() {} }, { delayMs: 1 })
  assert.equal(typeof disposer, 'function')
  assert.equal(calls, 3, '前两次 rejected promise 应各触发一次重试')

  // 次次 rejected 的 duplicate：重试耗尽后仍要抛出最后一个错误（而非静默丢失）
  const alwaysAsync = {
    register: () => Promise.reject(new Error('webserver: duplicate prefix route "/api/maoying" already registered')),
  }
  await assert.rejects(
    () => registerPrefixRouteWithRetry(alwaysAsync, { kind: 'prefix', path: '/api/x', handler() {} }, { attempts: 2, delayMs: 1 }),
    /duplicate prefix route/,
  )
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
