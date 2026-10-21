import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, getVersionInfo } from '../lib/version.mjs'

const json = (body) => ({ ok: true, status: 200, json: async () => body })

test('compareVersions：核心段逐位比较、缺段补 0、预发布后缀低于同版本', () => {
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1)
  assert.equal(compareVersions('0.2.0', '0.1.10'), 1)
  assert.equal(compareVersions('v0.1.10', '0.1.10'), 0)
  assert.equal(compareVersions('0.1', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0-rc.2'), -1)
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.1'), 1)
  assert.equal(compareVersions('0.1.9', '0.1.9'), 0)
})

test('getVersionInfo：registry 命中 → updateAvailable 判定正确', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('registry.npmjs.org')) return json({ version: '9.9.9' })
    throw new Error('不应走到更低级源')
  }
  const info = await getVersionInfo({
    fetchImpl, now: 1_000_000,
    // 本包真实版本 < 9.9.9，必然提示
  })
  assert.equal(info.source, 'npm')
  assert.equal(info.latest, 'v9.9.9')
  assert.equal(info.error, null)
  assert.equal(calls.length, 1, 'registry 命中后不得再请求镜像 / GitHub')
})

test('getVersionInfo：registry 挂 → 镜像顶上；全挂 → lastGood 复用，超窗降级', async () => {
  const alwaysFail = async () => { throw new Error('net down') }
  // 先灌一份成功结果进缓存（用 registry 命中源）
  const good = await getVersionInfo({
    fetchImpl: async (url) => {
      if (String(url).includes('registry.npmjs.org')) return json({ version: '9.9.9' })
      throw new Error('no')
    },
    now: 1_000_000,
  })
  assert.equal(good.updateAvailable, true)
  // TTL 内：直接复用，不发请求
  const cached = await getVersionInfo({ fetchImpl: alwaysFail, now: 1_000_000 + 1000 })
  assert.equal(cached.latest, 'v9.9.9')
  // TTL 过：三路全挂 → lastGood（7 天窗口内）复用
  const stale = await getVersionInfo({ fetchImpl: alwaysFail, now: 1_000_000 + 2 * 60 * 60 * 1000 })
  assert.equal(stale.latest, 'v9.9.9')
  assert.equal(stale.error, null)
  // 超过 7 天 → 降级：latest null、updateAvailable false、error 带三路原因
  const dead = await getVersionInfo({ fetchImpl: alwaysFail, now: 1_000_000 + 8 * 24 * 60 * 60 * 1000 })
  assert.equal(dead.latest, null)
  assert.equal(dead.updateAvailable, false)
  assert.match(dead.error, /三路检测均失败/)
  assert.match(dead.error, /npm registry/)
  assert.match(dead.error, /npmmirror/)
  assert.match(dead.error, /GitHub/)
})

test('getVersionInfo：镜像兜底与 GitHub 兜底', async () => {
  const mirror = await getVersionInfo({
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.includes('registry.npmjs.org')) return { ok: false, status: 503, json: async () => ({}) }
      if (u.includes('registry.npmmirror.com')) return json({ version: '9.9.8' })
      throw new Error('no')
    },
    now: 20_000_000_000,
  })
  assert.equal(mirror.source, 'mirror')
  assert.equal(mirror.latest, 'v9.9.8')
  const gh = await getVersionInfo({
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.includes('registry.npmjs.org') || u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
      if (u.includes('api.github.com')) return json({ tag_name: 'v9.9.7', html_url: 'https://github.com/lifangjin/dsh-maoying/releases/tag/v9.9.7' })
      throw new Error('no')
    },
    now: 30_000_000_000,
  })
  assert.equal(gh.source, 'github')
  assert.equal(gh.latest, 'v9.9.7')
  assert.equal(gh.releaseUrl, 'https://github.com/lifangjin/dsh-maoying/releases/tag/v9.9.7')
})
