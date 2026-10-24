/**
 * 路由层测试：不真起 HTTP 服务，用最小假件直接驱动 registerCreatorRoutes
 * 注册出的 handler——webServer.register 收集路由，req/res 用 EventEmitter +
 * 记账对象模拟（最小 IncomingMessage/ServerResponse 形状）。
 *
 * 覆盖：信任围栏（Host / sec-fetch-site / origin 完整 scheme+host+port 同源
 * 校验 / trustedHosts）、state 契约字段、chapter-status 流转与防穿越、
 * foreshadow-status、phase、rebuild-index、chapter 读取、outline 章纲全文
 * 读取、chapter-create 从章纲建章、404、413（响应体可达：先回包后断开）、
 * file-source 读受管原文带指纹（404 / 白名单外 403）、file-save /
 * file-create / file-delete 受管写三态（账本 yml / 实体卡 md 白名单、
 * chapters 仅删、index.yml 有意排除、过期基线 409 / 结构 422 / 404）、
 * 迭代路由接线（project-save 改键与越枚举 422、
 * style 读全文/缺失与 style-save 创建/覆写/409/422、
 * chapter-save 正文保存与 outline-save 章纲保存（hash 基线一致 200 /
 * 过期 409 不落盘 / 路径与文件名校验拒）、
 * update-check 响应形状（含 fresh=1 手动检测分支）、host-debug 五级探针与脱敏、非法 JSON body 400），
 * 以及 registerPrefixRouteWithRetry 的重试语义（同步抛与 rejected promise
 * 两条路）和 apply() 末尾「路由注册失败只 warn」的降级路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // 错误形状契约统一 { ok: false, error }——围栏 403 也不例外
  assert.deepEqual(JSON.parse(noHost.raw), { ok: false, error: 'forbidden' })
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
  assert.deepEqual(JSON.parse(state.raw), { ok: false, error: 'forbidden' })
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

test('style：无 style.md 回 found:false + 模板全文；写入后 found:true + 全文 + sha256 指纹；围栏 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const stylePath = path.join(env.root, 'novel', 'style.md')
  const get = () => call(handler, { url: `/api/maoying/style?path=${encodeURIComponent(env.root)}`, headers: LOOPBACK })

  // 文件未创建：200 + found:false（常态非错误），template 为插件内置 style.md 全文
  const empty = await get()
  assert.equal(empty.status, 200)
  const emptyBody = JSON.parse(empty.raw)
  assert.equal(emptyBody.ok, true)
  assert.equal(emptyBody.found, false)
  assert.equal(emptyBody.text, null)
  assert.equal(emptyBody.hash, null)
  assert.equal(typeof emptyBody.template, 'string')
  assert.ok(emptyBody.template.includes('写作风格基准'), `template 应为插件模板全文，实得前 50 字：${emptyBody.template.slice(0, 50)}`)

  // 落一份 style.md 后：found:true + 全文 + sha256 指纹
  writeFileSync(stylePath, '# 写作风格基准\n\n短句优先。\n', 'utf8')
  const full = await get()
  assert.equal(full.status, 200)
  const fullBody = JSON.parse(full.raw)
  assert.equal(fullBody.ok, true)
  assert.equal(fullBody.found, true)
  assert.equal(fullBody.text, '# 写作风格基准\n\n短句优先。\n')
  assert.equal(fullBody.hash, createHash('sha256').update(fullBody.text, 'utf8').digest('hex'))
  assert.equal(typeof fullBody.template, 'string')

  // path 围栏与既有读路由同款：非白名单 403
  const foreign = await call(handler, { url: `/api/maoying/style?path=${encodeURIComponent('/etc')}`, headers: LOOPBACK })
  assert.equal(foreign.status, 403)
})

test('style-save：创建/覆写落盘逐字节一致；base_hash 正确 200 且 hash 更新；过期 409 不落盘；text 非 string 422', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const stylePath = path.join(env.root, 'novel', 'style.md')
  const post = (body) => call(handler, { method: 'POST', url: '/api/maoying/style-save', headers: LOOPBACK, body })

  // 创建：文件不存在 + 不带 base_hash（缺省跳过检查，同 project-save 口径）→ 落盘 + 返回写后指纹
  const created = await post({ path: env.root, text: '# 风格 A\n\n短句优先。\n' })
  assert.equal(created.status, 200)
  const createdBody = JSON.parse(created.raw)
  assert.equal(createdBody.ok, true)
  assert.equal(readFileSync(stylePath, 'utf8'), '# 风格 A\n\n短句优先。\n', '落盘内容应逐字节一致')
  assert.equal(createdBody.hash, createHash('sha256').update('# 风格 A\n\n短句优先。\n', 'utf8').digest('hex'))

  // base_hash 正确 → 覆写成功，hash 更新为写后新指纹
  const textB = '# 风格 B\n\n对话推动剧情。\n'
  const ok = await post({ path: env.root, text: textB, base_hash: createdBody.hash })
  assert.equal(ok.status, 200)
  const okBody = JSON.parse(ok.raw)
  assert.equal(okBody.ok, true)
  assert.equal(okBody.hash, createHash('sha256').update(textB, 'utf8').digest('hex'))
  assert.notEqual(okBody.hash, createdBody.hash)
  assert.equal(readFileSync(stylePath, 'utf8'), textB)

  // base_hash 过期（先外部改文件）→ 409 拒写不落盘
  writeFileSync(stylePath, '# 作者手改\n', 'utf8')
  const stale = await post({ path: env.root, text: '# 覆盖手改\n', base_hash: okBody.hash })
  assert.equal(stale.status, 409)
  const staleBody = JSON.parse(stale.raw)
  assert.equal(staleBody.ok, false)
  assert.ok(staleBody.error.includes('外部修改'), `错误应点名外部修改：${staleBody.error}`)
  assert.equal(readFileSync(stylePath, 'utf8'), '# 作者手改\n', '409 拒写不得落盘')

  // 文件不存在 + 带 base_hash → 也 409（声称基于既有版本改，磁盘却无文件）
  rmSync(stylePath)
  const ghost = await post({ path: env.root, text: '# 幽灵基线\n', base_hash: okBody.hash })
  assert.equal(ghost.status, 409)
  assert.equal(JSON.parse(ghost.raw).ok, false)

  // text 非 string → 422
  const bad = await post({ path: env.root, text: 42 })
  assert.equal(bad.status, 422)

  // path 围栏
  const foreign = await post({ path: '/etc', text: '# x\n' })
  assert.equal(foreign.status, 403)
})

test('chapter-save：围栏保留正文替换 200 带新指纹；过期 base_hash 409 不落盘；路径/围栏校验拒', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const chapterPath = path.join(env.root, 'novel', 'chapters', 'v01-c001.md')
  const post = (body) => call(handler, { method: 'POST', url: '/api/maoying/chapter-save', headers: LOOPBACK, body })
  // 基线从 GET chapter 拿（与面板客户端同一路径）
  const got = await call(handler, { url: `/api/maoying/chapter?path=${encodeURIComponent(env.root)}&file=v01-c001.md`, headers: LOOPBACK })
  assert.equal(got.status, 200)
  const detail = JSON.parse(got.raw)
  assert.match(detail.hash, /^[0-9a-f]{64}$/, 'chapter 出参应带原文 sha256（hex 小写）')
  const before = readFileSync(chapterPath, 'utf8')
  const fenceEnd = before.indexOf('\n---\n') + '\n---\n'.length

  // 200：围栏前逐字节保留、正文替换、响应带写后新指纹
  const okRes = await post({ path: env.root, file: 'v01-c001.md', body: '面板新正文。', base_hash: detail.hash })
  assert.equal(okRes.status, 200)
  const okBody = JSON.parse(okRes.raw)
  assert.equal(okBody.ok, true)
  const after = readFileSync(chapterPath, 'utf8')
  assert.equal(after.slice(0, fenceEnd), before.slice(0, fenceEnd), 'frontmatter 围栏（含闭合行）应逐字节保留')
  assert.ok(after.endsWith('面板新正文。\n'), '正文应整段替换且末尾补换行')
  assert.match(okBody.hash, /^[0-9a-f]{64}$/)
  assert.equal(okBody.hash, createHash('sha256').update(after, 'utf8').digest('hex'))

  // 过期 base_hash → 409 拒写不落盘
  const stale = await post({ path: env.root, file: 'v01-c001.md', body: '覆盖未遂。', base_hash: detail.hash })
  assert.equal(stale.status, 409)
  const staleBody = JSON.parse(stale.raw)
  assert.equal(staleBody.ok, false)
  assert.ok(staleBody.error.includes('外部修改'), `错误应点名外部修改：${staleBody.error}`)
  assert.equal(readFileSync(chapterPath, 'utf8'), after, '409 拒写不得落盘')

  // file 带路径分隔符 → 403（safeFileName 一刀切）
  const evil = await post({ path: env.root, file: '../project.yml', body: 'x' })
  assert.equal(evil.status, 403)

  // 非白名单 path → 403
  const foreign = await post({ path: '/etc', file: 'v01-c001.md', body: 'x' })
  assert.equal(foreign.status, 403)
})

test('chapter-save：title 透传——围栏内 title 行与正文同刀原子替换；缺省不动 title；空 title 422', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const chapterPath = path.join(env.root, 'novel', 'chapters', 'v01-c001.md')
  const post = (body) => call(handler, { method: 'POST', url: '/api/maoying/chapter-save', headers: LOOPBACK, body })
  const getChapter = async () => {
    const res = await call(handler, { url: `/api/maoying/chapter?path=${encodeURIComponent(env.root)}&file=v01-c001.md`, headers: LOOPBACK })
    assert.equal(res.status, 200)
    return JSON.parse(res.raw)
  }

  // 带 title：与正文一次原子落盘，frontmatter title 行换新
  const detail = await getChapter()
  const okRes = await post({ path: env.root, file: 'v01-c001.md', body: '带标题保存。', base_hash: detail.hash, title: '第一卷：启程' })
  assert.equal(okRes.status, 200)
  const okBody = JSON.parse(okRes.raw)
  assert.equal(okBody.ok, true)
  const after = readFileSync(chapterPath, 'utf8')
  assert.ok(after.includes('title: 第一卷：启程'), 'title 行应换新值')
  assert.ok(after.includes('带标题保存。\n'), '正文应同刀替换')
  const reread = await getChapter()
  assert.equal(reread.frontmatter.title, '第一卷：启程', 'GET chapter 回读新标题')

  // 不带 title 的保存：title 行原样（客户端未改标题不发 title 的兼容口径）
  const ok2 = await post({ path: env.root, file: 'v01-c001.md', body: '再保存。', base_hash: reread.hash })
  assert.equal(ok2.status, 200)
  assert.ok(readFileSync(chapterPath, 'utf8').includes('title: 第一卷：启程'), '缺省 title 不动 title 行')

  // trim 空串 title → 422 拒写不落盘
  const before422 = readFileSync(chapterPath, 'utf8')
  const bad = await post({ path: env.root, file: 'v01-c001.md', body: 'x', title: '   ' })
  assert.equal(bad.status, 422)
  assert.equal(readFileSync(chapterPath, 'utf8'), before422, '422 拒写不得落盘')
})

test('outline-save：整文件替换 200 带新指纹；过期 base_hash 409 不落盘；坏 file 拒；非白名单 path 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const outlinePath = path.join(env.root, 'novel', 'outlines', 'v01-c001.md')
  const post = (body) => call(handler, { method: 'POST', url: '/api/maoying/outline-save', headers: LOOPBACK, body })
  const baseline = createHash('sha256').update(readFileSync(outlinePath, 'utf8'), 'utf8').digest('hex')

  // file 传章节文件名（服务端换算同 stem 章纲，与客户端传章节 file 的用法一致）
  const okRes = await post({ path: env.root, file: 'v01-c001.md', body: '重写章纲。', base_hash: baseline })
  assert.equal(okRes.status, 200)
  const okBody = JSON.parse(okRes.raw)
  assert.equal(okBody.ok, true)
  const after = readFileSync(outlinePath, 'utf8')
  assert.equal(after, '重写章纲。\n', '章纲纯 markdown，整文件替换')
  assert.match(okBody.hash, /^[0-9a-f]{64}$/)
  assert.equal(okBody.hash, createHash('sha256').update(after, 'utf8').digest('hex'))

  // stem 形式（v01-c001）与文件名形式等价
  const stemRes = await post({ path: env.root, file: 'v01-c001', body: 'stem 形式。', base_hash: okBody.hash })
  assert.equal(stemRes.status, 200)
  assert.ok(readFileSync(outlinePath, 'utf8').includes('stem 形式'))

  // 过期 base_hash → 409 拒写不落盘
  writeFileSync(outlinePath, '外部改动\n', 'utf8')
  const stale = await post({ path: env.root, file: 'v01-c001.md', body: '覆盖未遂。', base_hash: okBody.hash })
  assert.equal(stale.status, 409)
  assert.ok(JSON.parse(stale.raw).error.includes('外部修改'))
  assert.equal(readFileSync(outlinePath, 'utf8'), '外部改动\n', '409 拒写不得落盘')

  // file 带路径分隔符 → 403；非章纲 stem → 422
  const evil = await post({ path: env.root, file: '../../etc/passwd', body: 'x' })
  assert.equal(evil.status, 403)
  const badStem = await post({ path: env.root, file: 'scratch.md', body: 'x' })
  assert.equal(badStem.status, 422)

  // 非白名单 path → 403
  const foreign = await post({ path: '/etc', file: 'v01-c001.md', body: 'x' })
  assert.equal(foreign.status, 403)
})

test('file-source：读账本/实体卡原文+指纹（hash=原文 sha256）；缺文件 404；白名单外 403', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const get = (rel, p2) => call(handler, {
    url: `/api/maoying/file-source?path=${encodeURIComponent(p2 || env.root)}&rel=${encodeURIComponent(rel)}`,
    headers: LOOPBACK,
  })

  // 账本 yml：原文逐字节 + 指纹（读与指纹同刻同源，作 file-save 基线）
  const ok = await get('relations.yml')
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.raw)
  const rawLedger = readFileSync(path.join(env.root, 'novel', 'relations.yml'), 'utf8')
  assert.equal(body.ok, true)
  assert.equal(body.rel, 'relations.yml')
  assert.equal(body.text, rawLedger)
  assert.equal(body.hash, createHash('sha256').update(rawLedger, 'utf8').digest('hex'))

  // 实体卡 md：原文带围栏；缺文件 404；白名单外（index.yml 有意排除）403
  const md = await get('characters/lin-waner.md')
  assert.equal(md.status, 200)
  assert.ok(JSON.parse(md.raw).text.includes('---'), '实体卡原文应带 frontmatter 围栏')
  assert.equal((await get('characters/ghost.md')).status, 404)
  assert.equal((await get('index.yml')).status, 403)

  // 非白名单 path → 403
  assert.equal((await get('relations.yml', '/etc')).status, 403)
})

test('file-save / file-create / file-delete：受管写三态（200/409/422/403/404，save 用干净账本内容）', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const post = (route, body) => call(handler, { method: 'POST', url: `/api/maoying/${route}`, headers: LOOPBACK, body })
  const ledgerPath = path.join(env.root, 'novel', 'timeline.yml')

  // save：干净条目内容 + 正确基线 → 200 带写后指纹与 rel，落盘逐字节一致
  const baseline = createHash('sha256').update(readFileSync(ledgerPath, 'utf8'), 'utf8').digest('hex')
  const text = '- year: 玄历四年春\n  title: 冰河解冻\n  importance: 3\n'
  const saved = await post('file-save', { path: env.root, rel: 'timeline.yml', text, base_hash: baseline })
  assert.equal(saved.status, 200)
  const savedBody = JSON.parse(saved.raw)
  assert.equal(savedBody.ok, true)
  assert.equal(savedBody.rel, 'timeline.yml')
  assert.equal(readFileSync(ledgerPath, 'utf8'), text)
  assert.equal(savedBody.hash, createHash('sha256').update(text, 'utf8').digest('hex'))

  // save：过期基线 → 409 拒写不落盘（文案与 project-save 同口径）
  writeFileSync(ledgerPath, '- year: 外改\n', 'utf8')
  const stale = await post('file-save', { path: env.root, rel: 'timeline.yml', text: '- year: 覆盖未遂\n', base_hash: savedBody.hash })
  assert.equal(stale.status, 409)
  assert.ok(JSON.parse(stale.raw).error.includes('外部修改'))
  assert.equal(readFileSync(ledgerPath, 'utf8'), '- year: 外改\n', '409 拒写不得落盘')

  // save：结构 422（顶层非数组）；chapters 通用存 403（只删）；index.yml 有意排除 403
  assert.equal((await post('file-save', { path: env.root, rel: 'timeline.yml', text: 'title: x' })).status, 422)
  assert.equal((await post('file-save', { path: env.root, rel: 'chapters/v01-c001.md', text: '# x\n' })).status, 403)
  assert.equal((await post('file-save', { path: env.root, rel: 'index.yml', text: 'x: 1\n' })).status, 403)

  // create：新实体卡 200 落盘；已存在 409 不覆盖
  const tpl = '---\nname: 新角\nrole: supporting\n---\n\n'
  const created = await post('file-create', { path: env.root, rel: 'characters/new-girl.md', text: tpl })
  assert.equal(created.status, 200)
  assert.equal(JSON.parse(created.raw).rel, 'characters/new-girl.md')
  assert.ok(existsSync(path.join(env.root, 'novel', 'characters', 'new-girl.md')))
  assert.equal((await post('file-create', { path: env.root, rel: 'characters/new-girl.md', text: tpl })).status, 409)

  // delete：删章 200；重复删 404；path 围栏 403
  const del = await post('file-delete', { path: env.root, rel: 'chapters/v01-c001.md' })
  assert.equal(del.status, 200)
  assert.equal(JSON.parse(del.raw).ok, true)
  assert.equal(existsSync(path.join(env.root, 'novel', 'chapters', 'v01-c001.md')), false)
  assert.equal((await post('file-delete', { path: env.root, rel: 'chapters/v01-c001.md' })).status, 404)
  assert.equal((await post('file-delete', { path: '/etc', rel: 'chapters/v01-c001.md' })).status, 403)
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

test('update-check：fresh=1 手动检测分支照常回包（force + 超时 3s→10s）', async () => {
  // force / timeoutMs 的内部行为在 lib 层测全（version-check.test.mjs），
  // 这里只验路由接线：query 解析（searchParams 同 workspaces/check 写法）
  // 与 fresh=1 分支的响应契约——手动检测通道绝不能炸面板。
  const env = makeEnv()
  const handler = await registeredHandler(env)
  const state = await call(handler, { url: '/api/maoying/update-check?fresh=1', headers: LOOPBACK })
  assert.equal(state.status, 200)
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, true)
  for (const key of ['current', 'latest', 'updateAvailable', 'releaseUrl', 'checkedAt', 'error', 'source']) {
    assert.ok(key in body, `update-check?fresh=1 响应缺 ${key} 字段`)
  }
  assert.equal(typeof body.current, 'string')
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

test('L11 纵深加固：已注册工作区根（家目录外）的绝对路径不得出现在错误 message', async () => {
  const env = makeEnv()
  const handler = await registeredHandler(env)
  // 探针：novel/index.yml 换成目录（fixtures 不产 index.yml，直接建目录）→
  // rebuild-index 落盘 rename 必炸 EISDIR，
  // 原始错误 message 恒带工作区根下的绝对路径（fs 错误自带完整路径）——正好
  // 检验路由层把已注册工作区根并入脱敏替换表。
  rmSync(path.join(env.root, 'novel', 'index.yml'), { force: true })
  mkdirSync(path.join(env.root, 'novel', 'index.yml'))
  const state = await call(handler, {
    method: 'POST', url: '/api/maoying/rebuild-index', headers: LOOPBACK,
    body: { path: env.root },
  })
  assert.equal(state.status, 500)
  const body = JSON.parse(state.raw)
  assert.equal(body.ok, false)
  assert.ok(!state.raw.includes(env.root), '错误 message 不得包含已注册工作区根的绝对路径')
  // 工作区根在家目录外（tmp 临时目录常态）时基础替换表接不住它——只有工作区
  // 根扩展层能把它换成 ~ 前缀形态；根碰巧在家目录内则基础表已覆盖，不重复断言。
  if (!env.root.startsWith(path.resolve(os.homedir()))) {
    assert.ok(body.error.includes('~/'), `工作区根应已脱敏为 ~ 前缀形态：${body.error}`)
  }
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

// ── 路由 disposer 生命周期挂接（0.1.23，修 HMR 热重载后死路由残留）──────────
// 病灶回放：宿主 runProfile 对 <home>/cordis.patch.yml 挂了 HMR 热重载，本插件
// 安装器版本变化时重写该文件 → 插件纤维整树重建。旧 apply 丢弃 register 返回
// 的 disposer，旧纤维销毁后 /api/maoying 残留死 handler（ctx 已 inactive），
// 新纤维 apply 被 duplicate prefix route 挡住 → 面板所有请求 500
// `cannot get required service "workspaceRegistry" in inactive context`。

/** 真实增删的 webServer 假件：register 落表，disposer 按对象出表。 */
function realTableWebServer() {
  const routes = []
  return {
    routes,
    webServer: {
      register(route) {
        if (routes.some((r) => r.kind === route.kind && r.path === route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    },
  }
}

/** 收集 ctx.effect 注册的 effect 回调（宿主纤维销毁时逐个调用其返回值）。 */
function effectCollectingCtx(webServer, registry) {
  const effects = []
  const warns = []
  return {
    effects,
    warns,
    ctx: {
      logger: { info() {}, warn(...args) { warns.push(args.map(String).join(' ')) } },
      workspaceRegistry: registry,
      get: () => null,
      effect(fn) { effects.push(fn) },
      webServer,
    },
  }
}

const flushApply = async () => {
  // registerCreatorRoutes → registerPrefixRouteWithRetry（await webServer.register）
  // → .then(wireRouteDisposal)：三段微任务链，两轮 setImmediate 足够沉淀。
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('apply()：路由 disposer 挂接 ctx.effect，纤维销毁时注销路由', async () => {
  const { apply } = await import('../index.mjs')
  const { routes, webServer } = realTableWebServer()
  const { ctx, effects } = effectCollectingCtx(webServer, makeRegistry([]))
  apply(ctx)
  await flushApply()
  assert.equal(routes.length, 1, '注册后路由应恰有一条')
  assert.equal(effects.length, 1, 'disposer 应挂接 ctx.effect')

  // 纤维销毁：宿主跑 effect 回调的返回值——路由应随之出表，不留死 handler。
  const dispose = effects[0]()
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(routes.length, 0, '纤维销毁后路由应已注销')

  // 纤维重建（HMR 热重载后的新 apply）：同一前缀应能再次注册成功。
  const again = effectCollectingCtx(webServer, makeRegistry([]))
  apply(again.ctx)
  await flushApply()
  assert.equal(routes.length, 1, '热重载后新纤维应能重新注册（不再被残留 duplicate 挡住）')
  assert.equal(again.effects.length, 1)
})

test('apply()：注册完成时纤维已销毁（effect 抛 INACTIVE_EFFECT）→ 路由立即注销', async () => {
  const { apply } = await import('../index.mjs')
  const { routes, webServer } = realTableWebServer()
  const warns = []
  const ctx = {
    logger: { info() {}, warn(...args) { warns.push(args.map(String).join(' ')) } },
    workspaceRegistry: makeRegistry([]),
    get: () => null,
    // 模拟 cordis：对 inactive context 的 fiber 调 effect 抛 INACTIVE_EFFECT。
    effect() { const e = new Error('cannot create effect on inactive context'); e.code = 'INACTIVE_EFFECT'; throw e },
    webServer,
  }
  apply(ctx)
  await flushApply()
  assert.equal(routes.length, 0, '竞态窗口内纤维已死，路由应立即手动注销，不残留')
})

test('apply()：宿主无 effect/on 接口 → 路由保留并 warn 提示残留风险', async () => {
  const { apply } = await import('../index.mjs')
  const { routes, webServer } = realTableWebServer()
  const warns = []
  const ctx = {
    logger: { info() {}, warn(...args) { warns.push(args.map(String).join(' ')) } },
    workspaceRegistry: makeRegistry([]),
    get: () => null,
    webServer,
  }
  apply(ctx)
  await flushApply()
  assert.equal(routes.length, 1, '纤维活着且宿主无生命周期接口，路由应保留')
  assert.ok(
    warns.some((w) => w.includes('创作台路由在插件卸载后可能残留')),
    `应有残留风险 warn，实得 ${JSON.stringify(warns)}`,
  )
})
