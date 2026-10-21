/**
 * 面板内一键升级 —— 直接跑 pnpm 把本包装到当前 DSH profile（创作台面板用）。
 *
 * 背景：desktop 档的真实安装形态是 <dshHome>/profiles/<profile>/node_modules/
 * dsh-maoying（真实目录，非 symlink），宿主 dsh CLI 拒绝管理 desktop 档，唯一
 * 可行的升级命令是直接 pnpm：`pnpm --dir <profileDir> add dsh-maoying@latest`。
 *
 * 安全边界（缺一不可，全不满足绝不执行安装）：
 *   1) 安装形态判定——插件包自身目录先 realpathSync 取真路径，真路径 ≠ 常规
 *      路径即 link/symlink 安装（如 web 档指向 dev repo）→ 拒绝（dev-link，
 *      请在开发目录 git pull）；真路径不匹配 <dshHome>/profiles/<profile>/
 *      node_modules/dsh-maoying 结构 → 拒绝（unsupported-layout）。dshHome /
 *      profile 取 env.DSH_HOME / DSH_PROFILE（~ 前缀手动展开），缺失时回退从
 *      真路径的 profiles 祖先推导，推导不出同样拒绝。
 *   2) pnpm 解析——按候选路径逐个 existsSync + accessSync(X_OK)（PATH 各目录
 *      在前，homebrew / pnpm 官方安装位在后），一个都不可执行 → 拒绝
 *      （pnpm-missing）。绝不用 shell:true，无注入面。
 *   3) 超时 180 秒——超时 kill 子进程收敛为 timeout，不挂死面板请求。
 *
 * 所有失败路径都不抛错，一律收敛为 { ok: false, kind, message } 结果对象；
 * 成功返回 { ok: true, kind: 'installed', from, to, restartRequired: true }。
 * 硬约束：装完后运行中的进程仍是旧代码，必须重启 DeepSeek 才生效——restart-
 * Required 恒 true，UI 文案必须明说，不得暗示装完即生效。依赖全部可注入
 * （spawnImpl / realpathImpl / existsImpl / readImpl …），对齐 lib/version.mjs
 * 的 fetchImpl 模式，方便测试。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { invalidateVersionCache } from './version.mjs'

/** 安装超时：pnpm 冷缓存 + 国内网络最坏留足 3 分钟。 */
export const SELF_UPDATE_TIMEOUT_MS = 180 * 1000
/** 失败信息里保留的子进程输出尾部字节数（stdout / stderr 各一份）。 */
const OUTPUT_TAIL_BYTES = 2048

/**
 * 插件包自身目录（package.json 所在目录）。抽成函数便于测试注入假安装位。
 */
function defaultPkgDir() {
  return path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
}

/**
 * PATH 里 pnpm 之后的候选兜底（macOS 常见安装位；GUI 进程 PATH 常缺 pnpm，
 * 宿主进程又不经过 shell，PATH 找不到时按固定路径逐个试）。
 */
function extraPnpmCandidates(env) {
  const home = typeof env.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME.trim() : os.homedir()
  return [
    '/opt/homebrew/bin/pnpm',
    '/usr/local/bin/pnpm',
    path.join(home, '.local', 'share', 'pnpm', 'pnpm'),
    path.join(home, 'Library', 'pnpm', 'pnpm'),
  ]
}

/** 解析 pnpm 可执行文件：PATH 各目录在前、常见安装位兜底，去重后逐个可执行性检查。 */
function resolvePnpm(env, { existsImpl, accessImpl }) {
  const pathEnv = typeof env.PATH === 'string' ? env.PATH : ''
  const fromPath = pathEnv.split(path.delimiter).filter((d) => d !== '').map((d) => path.join(d, 'pnpm'))
  const candidates = [...new Set([...fromPath, ...extraPnpmCandidates(env)])]
  for (const candidate of candidates) {
    try {
      if (!existsImpl(candidate)) continue
      accessImpl(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* 存在但不可执行（或探测异常）：换下一个候选 */
    }
  }
  return null
}

/**
 * 从真路径的 profiles 祖先推导 { home, profile }：真路径必须形如
 * <dshHome>/profiles/<profile>/node_modules/dsh-maoying，其余形态返回 null。
 */
function deriveLayoutFromPath(realDir) {
  const pkgName = path.basename(realDir)
  const nmDir = path.dirname(realDir)
  if (pkgName !== 'dsh-maoying' || path.basename(nmDir) !== 'node_modules') return null
  const profile = path.basename(path.dirname(nmDir))
  const profilesDir = path.dirname(path.dirname(nmDir))
  if (path.basename(profilesDir) !== 'profiles') return null
  return { home: path.dirname(profilesDir), profile }
}

/** env 里的 dsh home（~ 前缀手动展开，环境变量不经过 shell 展开）。 */
function dshHomeFromEnv(env) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw === '') return null
  if (raw === '~' || raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(1))
  return raw
}

/**
 * 读安装目录 package.json 的 version；读不到（缺失 / 解析失败 / 字段异常）
 * 返回 null——from 缺失不拦安装（pnpm 退出码才是成败信号），to 缺失照常
 * ok:true（version 显示为 null，前端兜底显示）。
 */
async function readPkgVersion(pkgJsonPath, readImpl) {
  try {
    const raw = await readImpl(pkgJsonPath)
    const pkg = JSON.parse(raw)
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return null
  }
}

/** 组装最小注入面：缺省走真实 Node 实现，测试逐项替换。 */
function normalizeDeps(opts) {
  const env = opts.env ?? process.env
  return {
    env,
    spawnImpl: opts.spawnImpl ?? nodeSpawn,
    pkgDirImpl: opts.pkgDirImpl ?? defaultPkgDir,
    realpathImpl: opts.realpathImpl ?? ((p) => realpathSync(p)),
    existsImpl: opts.existsImpl ?? ((p) => existsSync(p)),
    accessImpl: opts.accessImpl ?? ((p, mode) => accessSync(p, mode)),
    readImpl:
      opts.readImpl ??
      ((p) => readFile(p, 'utf8')),
    logger: opts.logger ?? console,
    timeoutMs:
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : SELF_UPDATE_TIMEOUT_MS,
  }
}

/**
 * selfUpdate 主体（永不 reject；concurrency 去重与兜底 try/catch 在外层）。
 * @returns {Promise<{ok: boolean, kind: string, from?: string|null, to?: string|null,
 *           restartRequired?: boolean, message?: string}>}
 */
async function runSelfUpdate(opts = {}) {
  const { spawnImpl, pkgDirImpl, realpathImpl, existsImpl, accessImpl, readImpl, env, logger, timeoutMs } =
    normalizeDeps(opts)

  // ── a) 安装形态判定 ──────────────────────────────────────────────────────
  const pkgDir = pkgDirImpl()
  let realDir
  try {
    realDir = path.resolve(realpathImpl(pkgDir))
  } catch (err) {
    return { ok: false, kind: 'unsupported-layout', message: `安装目录读取失败: ${err?.message ?? err}` }
  }
  if (realDir !== path.resolve(pkgDir)) {
    return {
      ok: false,
      kind: 'dev-link',
      message: '当前安装指向开发目录（symlink/link 安装），请到开发目录 git pull 更新，这里不代装',
    }
  }
  const derived = deriveLayoutFromPath(realDir)
  const home = dshHomeFromEnv(env) ?? derived?.home ?? null
  const profileRaw = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  const profile = profileRaw !== '' ? profileRaw : derived?.profile ?? null
  const profileDir = home && profile ? path.join(home, 'profiles', profile) : null
  if (!derived || !profileDir || realDir !== path.resolve(path.join(profileDir, 'node_modules', 'dsh-maoying'))) {
    return {
      ok: false,
      kind: 'unsupported-layout',
      message: '当前安装形态不受面板内升级支持（不是 <dshHome>/profiles/<profile>/node_modules/dsh-maoying 目录安装），请用命令行升级',
    }
  }

  // ── b) 解析 pnpm ────────────────────────────────────────────────────────
  const pnpmPath = resolvePnpm(env, { existsImpl, accessImpl })
  if (!pnpmPath) {
    return {
      ok: false,
      kind: 'pnpm-missing',
      message: '未找到 pnpm 可执行文件（PATH 与常见安装路径都没有），请先安装 pnpm 后重试',
    }
  }

  const pkgJsonPath = path.join(realDir, 'package.json')
  const from = await readPkgVersion(pkgJsonPath, readImpl)

  // ── c) 执行安装（绝不用 shell:true，无注入面）────────────────────────────
  const exitInfo = await new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(pnpmPath, ['--dir', profileDir, 'add', 'dsh-maoying@latest'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ failed: true, kind: 'spawn-error', message: `pnpm 启动失败: ${err?.message ?? err}` })
      return
    }
    let out = Buffer.alloc(0)
    let errBuf = Buffer.alloc(0)
    const keepTail = (buf, chunk) => Buffer.concat([buf, Buffer.from(chunk)]).subarray(-OUTPUT_TAIL_BYTES)
    child.stdout?.on?.('data', (chunk) => { out = keepTail(out, chunk) })
    child.stderr?.on?.('data', (chunk) => { errBuf = keepTail(errBuf, chunk) })
    // 定时器只在进程仍存活时触发；exit 先到则清掉，不留挂起句柄。
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出：忽略 */ }
      resolve({
        failed: true,
        kind: 'timeout',
        message: `pnpm 安装超时（${Math.round(timeoutMs / 1000)} 秒）已中止，请检查网络后重试`,
      })
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ failed: false })
        return
      }
      const tailText = `${out.toString('utf8')}\n${errBuf.toString('utf8')}`.trim()
      resolve({
        failed: true,
        kind: 'pnpm-failed',
        message: `pnpm add 失败（${signal != null ? `signal ${signal}` : `exit ${code}`}）：${tailText !== '' ? tailText : '无输出'}`,
      })
    }
    child.on?.('exit', onExit)
    child.on?.('error', (err) => {
      clearTimeout(timer)
      resolve({ failed: true, kind: 'spawn-error', message: `pnpm 启动失败: ${err?.message ?? err}` })
    })
  })
  if (exitInfo.failed) {
    logger?.warn?.(`maoying 创作台: self-update 失败(${exitInfo.kind}): ${exitInfo.message}`)
    return { ok: false, kind: exitInfo.kind, message: exitInfo.message }
  }

  // ── d) 成功后重读新版本 + 版本缓存失效 ───────────────────────────────────
  const to = await readPkgVersion(pkgJsonPath, readImpl)
  // 装的是磁盘上的新包，进程内 update-check 的 1h 缓存已是旧结论，立刻失效，
  // 下次打开面板（重启后）按磁盘新版本重算 updateAvailable。
  invalidateVersionCache()
  logger?.info?.(`maoying 创作台: self-update 完成 ${from ?? '?'} → ${to ?? '?'}（重启 DeepSeek 后生效）`)
  return { ok: true, kind: 'installed', from, to, restartRequired: true }
}

// in-flight 去重：并发的 selfUpdate（连点按钮 / 双面板）复用同一次安装
// promise，pnpm add 绝不并发跑两份；promise 落定即清空。resetSelfUpdateInflight
// 仅供测试隔离模块级状态。
let inflight = null

/** 测试专用：清空模块级 in-flight 状态（生产勿用）。 */
export function resetSelfUpdateInflight() {
  inflight = null
}

/**
 * 面板一键升级入口（并发去重）。
 * @returns {Promise<{ok: boolean, kind: string, ...}>} 永不 reject
 */
export async function selfUpdate(opts = {}) {
  if (inflight) return inflight
  inflight = runSelfUpdate(opts).finally(() => {
    inflight = null
  })
  return inflight
}
