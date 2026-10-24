/**
 * 版本提示 —— 检测线上是否有比本地更新的版本（创作台面板用）。
 *
 * 同构移植自 dsh-paoding tools/lib/version.mjs（用户指定模仿其机制）。检测
 * 源三级：npm registry 与 npmmirror 镜像两路并行竞速（manifest 形状与数据
 * 一致，先成功者胜，官方源超时 / 被墙时国内几秒内可达的镜像顶上，分钟级
 * 同步延迟对「有没有新版」这个判断无伤大雅）；两路 npm 源皆败再串行走
 * GitHub releases/latest 兜底（独立数据源）。
 *
 * 零依赖纯 Node（>=18）：不引 cordis / npm 依赖，fetch 可注入（缺省用
 * globalThis.fetch），超时用 AbortSignal.timeout()。所有失败路径都不抛错，
 * 一律收敛为 { ok: false, error } 或带 error 字段的结果对象——调用方（面板
 * 路由）按「失败即静默」处理，绝不影响主流程。
 *
 * 相对 paoding 版的差异：本文件在包内 lib/ 下，package.json 向上一级即是
 * 包根（paoding 在 tools/lib/ 需向上两级）；包名与仓库名换成 dsh-maoying。
 */
import { readFile } from 'node:fs/promises'

// 仓库（与包名一致）的 GitHub latest release 接口与落地页。
const RELEASE_API = 'https://api.github.com/repos/lifangjin/dsh-maoying/releases/latest'
const RELEASE_PAGE = 'https://github.com/lifangjin/dsh-maoying/releases/latest'
// npm registry 的 latest 元数据端点（等价 dist-tags.latest，无认证无限流）。
const REGISTRY_LATEST = 'https://registry.npmjs.org/dsh-maoying/latest'
// npmmirror 镜像的同名端点：manifest 形状与官方源一致（顶层 version 即
// latest），同步自 npm registry，官方源不可达时的国内快路。
const MIRROR_LATEST = 'https://registry.npmmirror.com/dsh-maoying/latest'

// 读不到 package.json 时的版本兜底。当前版本不可知（source: 'fallback'）时
// updateAvailable 恒 false —— 拿「0.0.0 恒小于任何真实版本」去比较，反而必然
// 对任何 latest 误报新版，升级提示必须整体抑制（读不到版本就不提示）。
const FALLBACK_VERSION = '0.0.0'

/**
 * 合法版本号形状（M1）：semver 核心三段 + 可选预发布段（如 1.2.3-rc.1）。
 * 远端源（registry / npmmirror / GitHub tag）返回的串必须先过这道闸才允许
 * 进缓存、参与比较或拼进安装参数——对 version 只校验非空字符串的话，被控源
 * 返回的串可携带 shell 元字符，剥了 v 前缀就采信会经 self-update 的
 * `dsh-maoying@<version>` 拼参（win32 shell:true 下即命令注入）。
 */
export function isValidVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?$/.test(value)
}

// 内存缓存 TTL：1 小时内复用上次成功结果，过期才真的发外网请求。
const CACHE_TTL_MS = 60 * 60 * 1000
// 请求失败时的 stale-if-error 窗口：上次成功结果在 7 天内仍原样复用（lastGood）。
// 窗口刻意明显大于新鲜 TTL：外网偶发抖动不该立刻撤掉本可用的升级提示。
const LASTGOOD_TTL_MS = 7 * 24 * 60 * 60 * 1000

// 模块级缓存：只在成功后写入；失败结果不进缓存（下次调用仍会重试）。
let cache = { at: 0, info: null }

/**
 * 本地版本：读包根 package.json 的 version。读失败（文件缺失 / 解析失败 /
 * 字段异常）回退 FALLBACK_VERSION 并标记 source: 'fallback'。
 * @returns {Promise<{version: string, source: 'package.json'|'fallback'}>}
 */
export async function currentVersion() {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(raw)
    if (typeof pkg?.version === 'string' && pkg.version !== '') {
      return { version: pkg.version, source: 'package.json' }
    }
  } catch {
    /* 静默回退：版本读取失败不该打扰任何主流程 */
  }
  return { version: FALLBACK_VERSION, source: 'fallback' }
}

/**
 * 拆版本号：剥前缀 v/V，按 '.' 切段，`-` 后为预发布后缀（原样保留）。核心段
 * 必须纯数字才转数值，非纯数字段（如 '12abc'、空串）一律按 0——parseInt 的
 * 前缀解析会把 '12abc' 当成 12，这里显式拒绝。
 */
function parseVersion(value) {
  let s = String(value ?? '').trim()
  if (s.startsWith('v') || s.startsWith('V')) s = s.slice(1)
  // L3：build metadata（首个 '+' 起的段）按 semver 口径不参与比较，先截掉——
  // 否则 '1.2.3+build' 的核心段被切成 ['1','2','3+build']，'3+build' 非纯数字
  // 归 0，整体被误判成 1.2.0。
  const plus = s.indexOf('+')
  if (plus !== -1) s = s.slice(0, plus)
  const dash = s.indexOf('-')
  const coreText = dash === -1 ? s : s.slice(0, dash)
  const pre = dash === -1 ? '' : s.slice(dash + 1)
  const core = coreText.split('.').map((n) => (/^\d+$/.test(n) ? Number(n) : 0))
  return { core, pre }
}

/**
 * 预发布段逐段比较：按 '.' 切段，纯数字段转数值比（rc.10 必须大于 rc.2，
 * 字符串序会误判 'rc.10' < 'rc.2'），非数字段按字典序；段数不齐缺段视为
 * 空段，空段小于非空段（semver 口径：rc.1 < rc.1.0）。
 */
function comparePre(a, b) {
  const sa = a.split('.')
  const sb = b.split('.')
  const len = Math.max(sa.length, sb.length)
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? ''
    const y = sb[i] ?? ''
    if (x === y) continue
    if (x === '') return -1 // 缺段（空）< 非空
    if (y === '') return 1
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) < Number(y) ? -1 : 1
    return x < y ? -1 : 1 // 非数字段（含数字段与非数字段混排）按字典序
  }
  return 0
}

/**
 * 版本比较（可测纯函数）：a < b 返回 -1，相等返回 0，a > b 返回 1。
 * 简化语义（不追求完整 semver）：剥前缀 v/V 后按 '.' 逐段数值比较，缺段补 0；
 * 核心段相同时带预发布后缀（如 0.3.0-rc.1）视为低于无后缀同版本，两个都有
 * 预发布后缀则按 '.' 切段逐段比较（数字段数值比、其余字典序，见 comparePre）。
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < len; i++) {
    const x = pa.core[i] ?? 0
    const y = pb.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (pa.pre !== pb.pre) {
    if (pa.pre === '') return 1 // 无后缀 > 有后缀
    if (pb.pre === '') return -1
    return comparePre(pa.pre, pb.pre)
  }
  return 0
}

/**
 * 请求 GitHub latest release。任何失败（网络 / 超时 / 限流 / 解析）都不抛出，
 * 返回 { ok: false, error }；仓库尚无 release（404）不算错误，返回
 * { ok: true, tag: null, url: null, notFound: true }。成功返回
 * { ok: true, tag: 'vX.Y.Z', url: releasePage }。
 */
export async function fetchLatestRelease({ fetchImpl, timeoutMs = 3000 } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: 'fetch 不可用（当前运行时无 fetch 实现）' }
  // GitHub API 必须带 User-Agent，顺手报上包名与本地版本便于排障。
  const { version } = await currentVersion()
  try {
    const res = await doFetch(RELEASE_API, {
      headers: {
        'user-agent': `dsh-maoying/${version}`,
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return { ok: true, tag: null, url: null, notFound: true }
    if (!res.ok) {
      // 非 404 失败（403 限流、5xx 等）：带上 GitHub 的 message 便于排障
      //（典型如未认证配额用尽的 rate limit 提示），仍按失败静默收敛。
      let detail = ''
      try {
        const body = await res.json()
        if (body && typeof body.message === 'string' && body.message !== '') detail = `: ${body.message}`
      } catch {
        /* 正文非 JSON 时忽略，只报状态码 */
      }
      return { ok: false, error: `GitHub API HTTP ${res.status}${detail}` }
    }
    let data = null
    try {
      data = await res.json()
    } catch (err) {
      return { ok: false, error: `GitHub API 响应解析失败: ${err?.message ?? err}` }
    }
    const tag = typeof data?.tag_name === 'string' && data.tag_name !== '' ? data.tag_name : null
    if (!tag) return { ok: false, error: 'GitHub API 响应缺少 tag_name' }
    // M1：tag 同款形状校验（剥 v/V 前缀后验），非法 tag 不进缓存也不参与比较。
    if (!isValidVersion(tag.replace(/^v/i, ''))) return { ok: false, error: `GitHub release tag 非法: ${tag}` }
    const url = typeof data?.html_url === 'string' && data.html_url !== '' ? data.html_url : RELEASE_PAGE
    return { ok: true, tag, url }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * 请求一个 npm 系 manifest 端点（官方源与 npmmirror 镜像共用同一形状：完整
 * manifest，顶层 version 即 latest）。任何失败（网络 / 超时 / 解析 / 形状不对）
 * 都不抛出，返回 { ok: false, error }；成功返回 { ok: true, latest: 'vX.Y.Z',
 * releaseUrl, source }（端点的 version 不带 v 前缀，这里统一补齐，与 GitHub
 * tag 的显示口径一致）。
 */
async function fetchLatestManifest(url, label, source, { fetchImpl, timeoutMs = 3000 } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: 'fetch 不可用（当前运行时无 fetch 实现）' }
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/vnd.npm+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `${label} HTTP ${res.status}` }
    let data = null
    try {
      data = await res.json()
    } catch (err) {
      return { ok: false, error: `${label} 响应解析失败: ${err?.message ?? err}` }
    }
    // /<name>/latest 返回该版本的完整 manifest，顶层 version 即 latest 版本号；
    // CDN 缓存抖动可能回形状不对的正文，按失败处理走下一级检测源。
    const ver = typeof data?.version === 'string' && data.version !== '' ? data.version : null
    if (!ver) return { ok: false, error: `${label} 响应缺少 version` }
    // M1：形状非法（非 X.Y.Z[-预发布]，可能携带 shell 元字符）的 version 不进
    // 缓存也不参与比较/安装，按该路失败处理走下一级检测源。
    if (!isValidVersion(ver.replace(/^v/, ''))) return { ok: false, error: `${label} 响应 version 非法: ${ver}` }
    return { ok: true, latest: `v${ver}`, releaseUrl: RELEASE_PAGE, source }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * 请求 npm registry（官方源）的 latest 元数据——版本检测首选源。
 */
export async function fetchLatestFromRegistry(opts) {
  return await fetchLatestManifest(REGISTRY_LATEST, 'npm registry', 'npm', opts)
}

/**
 * 请求 npmmirror 镜像的 latest 元数据——官方源不可达（超时 / 被墙 / 代理
 * 黑洞）时的国内快路：manifest 形状与官方源一致，同步延迟分钟级，对「有
 * 没有新版」这个判断无伤大雅。
 */
export async function fetchLatestFromMirror(opts) {
  return await fetchLatestManifest(MIRROR_LATEST, 'npmmirror', 'mirror', opts)
}

/**
 * npm 双源并行竞速：registry 与 mirror 同时发起，谁先拿到有效版本（ok:true）
 * 就用谁——两源 manifest 形状与数据一致（mirror 同步自官方源），成功语义
 * 等价，先到先用不改变判定结果；单路超时同为 timeoutMs，npm 阶段最坏耗时
 * 仍由 timeoutMs 封顶（原三级串行最坏 3×timeout 收敛为 npm 并行 1× +
 * GitHub 串行 1×）。失败语义与旧串行链保持一致：registry 错误排前、mirror
 * 排后（对应 failures[0] / failures[1]），两路皆败才由调用方串行走 GitHub
 * 兜底。两路请求都提前挂好回调，先到即决出胜负，后到的结果作废但不产生
 * 未处理异常。
 */
function raceLatestFromNpm(opts) {
  return new Promise((resolve) => {
    const errors = [null, null] // [registry 错误, mirror 错误]，全败时透出排障
    let settled = 0 // 已落定的路数
    let winner = false // 是否已决出胜者
    const watch = (promise, index) => {
      promise.then(
        (hit) => {
          if (winner) return // 已有先到者，本路结果作废
          if (hit && hit.ok) {
            winner = true
            resolve({ ok: true, hit })
          } else {
            errors[index] = hit?.error ?? '未知失败'
          }
        },
        (err) => {
          errors[index] = String(err?.message ?? err)
        },
      ).finally(() => {
        settled += 1
        if (!winner && settled === 2) resolve({ ok: false, errors })
      })
    }
    // registry 先挂监听：两路同步落定时胜者确定性偏向官方源
    watch(fetchLatestFromRegistry(opts), 0)
    watch(fetchLatestFromMirror(opts), 1)
  })
}

/**
 * 实际执行一轮检测（缓存 TTL 与并发去重之外的检测主体，供 getVersionInfo
 * 调度）：npm registry 与 npmmirror 镜像并行竞速（见 raceLatestFromNpm），
 * 两路皆败才串行请求 GitHub release 兜底；三路皆败按 lastGood / 降级收敛。
 */
async function detectLatest({ fetchImpl, timeoutMs, nowMs }) {
  const { version: current, source: currentSource } = await currentVersion()
  let hit
  let failures = []
  const npm = await raceLatestFromNpm({ fetchImpl, timeoutMs })
  if (npm.ok) {
    hit = npm.hit
  } else {
    failures = npm.errors
    const rel = await fetchLatestRelease({ fetchImpl, timeoutMs })
    hit = rel.ok && rel.tag
      ? { ok: true, latest: rel.tag, releaseUrl: rel.url, source: 'github' }
      : { ok: false, error: rel.ok ? 'GitHub release 尚未发布（404）' : rel.error }
  }
  // hit 必为对象（竞速胜者或 GitHub 兜底结果，失败也已收敛为结果对象），
  // 无需再判真值。
  if (hit.ok) {
    const info = {
      current,
      latest: hit.latest ?? null,
      // 当前版本不可知（fallback 0.0.0）时不提示升级，latest 缺失同理。
      updateAvailable:
        currentSource === 'fallback' || !hit.latest ? false : compareVersions(current, hit.latest) < 0,
      releaseUrl: hit.releaseUrl ?? null,
      checkedAt: new Date(nowMs).toISOString(),
      error: null,
      source: hit.source ?? null,
    }
    cache = { at: nowMs, info }
    return info
  }
  // 三路皆败：优先复用 lastGood 窗口（7 天）内的上次成功结果；超窗才给降级
  // 结果（不写缓存）。error 把各路原因都带上，并附代理排查提示——最常见的
  // 「浏览器能上网、DSH 进程检测失败」是启动环境的代理变量指向了不可用的
  // 代理（DSH 遵循 HTTPS_PROXY 等变量，浏览器不走它们）。
  const combined = `三路检测均失败（npm registry: ${failures[0]}；npmmirror: ${failures[1]}；GitHub: ${hit.error}）。若本机经代理访问外网，请确认代理可用后重启 DSH 再试——DSH 进程遵循 HTTPS_PROXY / HTTP_PROXY 环境变量，浏览器不走它们，两者连通性可能不同`
  if (cache.info && nowMs - cache.at < LASTGOOD_TTL_MS) return cache.info
  return {
    current,
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    checkedAt: new Date(nowMs).toISOString(),
    error: combined,
    source: null,
  }
}

// in-flight 去重：并发的 getVersionInfo 调用（面板多处同时拉取）复用同一
// 次检测 promise，只发一轮外网请求；promise 落定即清空，下次按缓存 TTL 走。
// 注意并发窗口内各调用共享第一次调用注入的 now 语义（checkedAt 取先到者）。
let inflight = null

/**
 * 版本缓存失效（面板一键升级专用，lib/self-update.mjs 调用）：pnpm 把磁盘
 * 上的包装到新版本后，进程内这份缓存（含 1h TTL 与 7 天 lastGood 窗口里的
 * 旧结论）整体作废——下次 getVersionInfo 按磁盘新版本重算 updateAvailable。
 * 只重置缓存与 in-flight，不改任何检测行为。
 */
export function invalidateVersionCache() {
  cache = { at: 0, info: null }
  inflight = null
}

/**
 * 组合结果（面板路由专用）：带 1 小时内存缓存，过期才重新请求；请求失败时
 * 若上次成功结果在 lastGood 窗口（7 天，见 LASTGOOD_TTL_MS）内则原样复用
 * （stale-if-error），否则返回带 error 的降级结果（latest 置 null、
 * updateAvailable 恒 false——调用方静默）。当前版本不可知（FALLBACK_VERSION
 * 兜底）时 updateAvailable 恒 false：0.0.0 对任何 latest 都「更小」，比较必
 * 误报新版，升级提示整体抑制。检测源：npm registry 与 npmmirror 镜像并行
 * 竞速（先成功者胜），两路皆败才串行请求 GitHub release 兜底；三路皆败才
 * 算本次检测失败。并发调用经 in-flight 去重复用同一次检测。`force: true`
 * 为手动检测更新语义（路由 `update-check?fresh=1`）：先把模块级缓存压成
 * 空再走正常流程——只保证不命中 1h TTL 内的陈旧 cache，**不保证「另发
 * 一轮全新外网请求」**：若已有一轮 in-flight 检测在跑，它本来就是缓存
 * 失效后发起的新检测，复用等它落定即可（有意语义，与 invalidateVersionCache
 * 的整体作废不同——这里刻意不动 in-flight）。成功结果的
 * source 字段记录命中源。所有返回值均为缓存对象的浅拷贝——缓存要供最长
 * 7 天的 lastGood 复用，调用方原地改写返回对象不得污染缓存。
 * @returns {Promise<{current: string, latest: string|null, updateAvailable: boolean,
 *           releaseUrl: string|null, checkedAt: string, error: string|null,
 *           source: 'npm'|'mirror'|'github'|null}>}
 */
export async function getVersionInfo({ fetchImpl, timeoutMs = 3000, now, force = false } = {}) {
  const nowMs = typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now()
  // force（手动检测）：缓存置空 → 下方 TTL 判定必不命中，走真实检测。
  if (force) cache = { at: 0, info: null }
  // TTL 内直接复用缓存；一律返回浅拷贝，隔离调用方的原地改写。
  if (cache.info && nowMs - cache.at < CACHE_TTL_MS) return { ...cache.info }
  // in-flight 去重：并发调用共享同一次检测；浅拷贝统一在返回前做。
  if (!inflight) {
    inflight = detectLatest({ fetchImpl, timeoutMs, nowMs }).finally(() => {
      inflight = null
    })
  }
  const info = await inflight
  return { ...info }
}
