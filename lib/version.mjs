/**
 * 版本提示 —— 检测线上是否有比本地更新的版本（创作台面板用）。
 *
 * 同构移植自 dsh-paoding tools/lib/version.mjs（用户指定模仿其机制）。检测源
 * 三级：npm registry 的 /latest 端点优先（无认证无限流，发布即可见）；失败再
 * 试 npmmirror 镜像（官方源超时 / 被墙时国内几秒内可达，分钟级同步延迟对
 * 「有没有新版」这个判断无伤大雅）；最后 GitHub releases/latest 兜底。
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

/** 拆版本号：剥前缀 v/V，按 '.' 切数值段，`-` 后为预发布后缀（原样保留）。 */
function parseVersion(value) {
  let s = String(value ?? '').trim()
  if (s.startsWith('v') || s.startsWith('V')) s = s.slice(1)
  const dash = s.indexOf('-')
  const coreText = dash === -1 ? s : s.slice(0, dash)
  const pre = dash === -1 ? '' : s.slice(dash + 1)
  const core = coreText.split('.').map((n) => {
    const x = parseInt(n, 10)
    return Number.isFinite(x) ? x : 0
  })
  return { core, pre }
}

/**
 * 版本比较（可测纯函数）：a < b 返回 -1，相等返回 0，a > b 返回 1。
 * 简化语义（不追求完整 semver）：剥前缀 v/V 后按 '.' 逐段数值比较，缺段补 0；
 * 核心段相同时带预发布后缀（如 0.3.0-rc.1）视为低于无后缀同版本，两个都有
 * 预发布后缀则按字符串比较。
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
    return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0
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
 * 组合结果（面板路由专用）：带 1 小时内存缓存，过期才重新请求；请求失败时
 * 若上次成功结果在 lastGood 窗口（7 天，见 LASTGOOD_TTL_MS）内则原样复用
 * （stale-if-error），否则返回带 error 的降级结果（latest 置 null、
 * updateAvailable 恒 false——调用方静默）。当前版本不可知（FALLBACK_VERSION
 * 兜底）时 updateAvailable 恒 false：0.0.0 对任何 latest 都「更小」，比较必
 * 误报新版，升级提示整体抑制。检测源三级：npm registry 优先，失败再试
 * npmmirror 镜像，最后 GitHub release；三路皆败才算本次检测失败。成功结果的
 * source 字段记录命中源。
 * @returns {Promise<{current: string, latest: string|null, updateAvailable: boolean,
 *           releaseUrl: string|null, checkedAt: string, error: string|null,
 *           source: 'npm'|'mirror'|'github'|null}>}
 */
export async function getVersionInfo({ fetchImpl, timeoutMs = 3000, now } = {}) {
  const nowMs = typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now()
  if (cache.info && nowMs - cache.at < CACHE_TTL_MS) return cache.info
  const { version: current, source: currentSource } = await currentVersion()
  // 三级链：① npm registry（官方源）；② npmmirror 镜像（官方源不可达时的
  // 国内快路）；③ GitHub releases/latest（镜像也挂时的独立数据源）。
  const failures = []
  let hit = await fetchLatestFromRegistry({ fetchImpl, timeoutMs })
  if (!hit.ok) {
    failures.push(hit.error)
    hit = await fetchLatestFromMirror({ fetchImpl, timeoutMs })
  }
  if (!hit.ok) {
    failures.push(hit.error)
    const rel = await fetchLatestRelease({ fetchImpl, timeoutMs })
    hit = rel.ok && rel.tag
      ? { ok: true, latest: rel.tag, releaseUrl: rel.url, source: 'github' }
      : { ok: false, error: rel.ok ? 'GitHub release 尚未发布（404）' : rel.error }
  }
  if (hit && hit.ok) {
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
