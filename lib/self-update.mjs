/**
 * 面板内一键升级 —— 版本预检 + pnpm 候选链（机制对齐 dsh-paoding
 * tools/lib/upgrade.mjs，0.1.18 起）。
 *
 * 背景：desktop 档的真实安装形态是 <dshHome>/profiles/<profile>/node_modules/
 * dsh-maoying（真实目录，非 symlink），宿主 dsh CLI 拒绝管理 desktop 档，唯一
 * 可行的升级命令是在 profile 目录里直跑 `pnpm add dsh-maoying@<精确版本>`：
 *   - cwd 就是 profile 目录（pnpm 的操作对象是它），不带 --dir；
 *   - 装精确版本而非 @latest——避开 pnpm 新鲜度防护 / 镜像 packument 滞后
 *     造成的「跑了但啥也没装」静默空转。
 *
 * pnpm 解析（0.1.18 重写，修复「未找到 pnpm」误报）：不再 existsSync+
 * accessSync(X_OK) 文件预筛（corepack 管理且未 `corepack enable` 的机器 PATH
 * 里没有裸 pnpm，桌面 GUI 进程 PATH 还可能是 launchd 最小集，预筛必落空），
 * 改为 spawn ENOENT 探测链：逐候选真 spawn，仅 err.code==='ENOENT' 才换下一
 * 路；EACCES / 超时 / 非零退出都是真实运行结果，如实返回不换通道。候选链：
 *   1) 裸 pnpm（npm i -g / homebrew 等常规安装）；
 *   2) 裸 corepack（corepack 随 node 发行，未 enable 也能 `corepack pnpm ...`
 *      即装即用）；
 *   3) /opt/homebrew/bin/corepack（existsSync 预筛，不在盘上不浪费 spawn）；
 *   4) /opt/homebrew/opt/node@XX/bin/corepack（readdirSync 过滤 node 前缀目录
 *      拼路径，
 *      兜住 keg-only 的 node@XX 版代安装——desktop Electron 最小 PATH 实测
 *      全靠它命中）；
 *   5) path.dirname(process.execPath)/corepack（桌面 Electron 下无用但无害，
 *      headless / web profile 的 node 同目录形态有用）；
 *   6) ~/Library/pnpm、~/.local/share/pnpm（pnpm 独立安装脚本落位）。
 * win32 的 pnpm / corepack 都是 .cmd shim，spawn 必须 shell:true（Node 直接
 * spawn .cmd 会 EINVAL，见 CVE-2024-27980 加固），命令补 .cmd 后缀、参数保持
 * 数组形式；darwin/linux 恒 shell:false，无注入面。
 *
 * 升级前版本预检：fetchLatestFromRegistry（10s）失败再 fetchLatestFromMirror
 * （10s），拿不到 latest 绝不做半截升级；compareVersions(target, current) <= 0
 * 直接短路「已是最新」，不 spawn。装完失效版本检测缓存。
 *
 * 安全边界（缺一不可，全不满足绝不执行安装）：
 *   1) 安装形态判定——插件包自身目录先 realpathSync 取真路径，真路径 ≠ 常规
 *      路径即 link/symlink 安装（如 web 档指向 dev repo）→ 拒绝（dev-link，
 *      指路 git pull）；真路径不匹配 <dshHome>/profiles/<profile>/node_modules/
 *      dsh-maoying 结构 → 拒绝（unsupported-layout）。dshHome / profile 取
 *      env.DSH_HOME / DSH_PROFILE（~ 前缀手动展开），缺失时回退从真路径的
 *      profiles 祖先推导，推导不出同样拒绝。
 *   2) profile 就绪判定——profile 目录没有 package.json（未初始化）→ 拒绝
 *      （profile-missing），不硬跑 pnpm（会在空目录另起一份 package.json）。
 *   3) 超时 180 秒——超时 SIGTERM（5s 后升级 SIGKILL）收敛为 timeout，不挂死
 *      面板请求。
 *
 * 所有失败路径都不抛错，一律收敛为 { ok: false, kind, message } 结果对象；
 * 成功返回 { ok: true, kind: 'installed', from, to, restartRequired: true }，
 * 已是最新短路返回 { ok: true, kind: 'up-to-date', from }。硬约束：装完后运行
 * 中的进程仍是旧代码，必须重启 DeepSeek 才生效——restartRequired 恒 true，UI
 * 文案必须明说，不得暗示装完即生效。依赖全部可注入（spawnImpl / realpathImpl /
 * existsImpl / readdirImpl / fetchImpl / platform …），对齐 lib/version.mjs 的
 * fetchImpl 模式，方便测试。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  compareVersions,
  currentVersion,
  fetchLatestFromMirror,
  fetchLatestFromRegistry,
  invalidateVersionCache,
} from './version.mjs'

/** 安装超时：pnpm 冷缓存 + 国内网络最坏留足 3 分钟。 */
export const SELF_UPDATE_TIMEOUT_MS = 180 * 1000
/** 版本预检单路（registry / mirror）超时：用户显式点了「升级」，等得起。 */
const VERSION_TIMEOUT_MS = 10 * 1000
/**
 * 失败信息里保留的子进程输出尾部长度（stdout+stderr 合并后取尾）：8KB——
 * pnpm 的报错结论都在尾部，但镜像 404 / 对账冲突这类关键行可能被进度刷屏
 * 顶得很深，2KB 不够排障。
 */
const OUTPUT_TAIL_BYTES = 8 * 1024
/** 输出累积硬上限：超过先截一版，防异常刷爆内存。 */
const OUTPUT_HARD_CAP_BYTES = 1024 * 1024
/** SIGTERM 后留给进程自行退出的宽限，超时升级 SIGKILL。 */
const TERM_GRACE_MS = 5 * 1000

/**
 * 插件包自身目录（package.json 所在目录）。抽成函数便于测试注入假安装位。
 */
function defaultPkgDir() {
  return path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
}

/**
 * 缺省子进程执行器（可被 spawnImpl 注入替换，测试用）：spawn 任意命令，合并
 * 收集 stdout+stderr，永不 reject，统一收敛为
 *   { code, output, error?, errorCode? }
 * error 仅子进程异常（spawn 失败 / 超时）时存在；errorCode 为结构化失败码：
 * spawn 失败透传 err.code（如 'ENOENT'，候选链据此换下一路），超时收敛为
 * 'ETIMEDOUT'。timeoutLabel 只用于超时文案标明哪条通道超时。超时先 SIGTERM，
 * TERM_GRACE_MS 后仍不退则 SIGKILL 兜底（pnpm 尊重 SIGTERM；SIGKILL 保证
 * close 事件必然到达，调用方绝不悬挂）。
 */
export function defaultSpawn(command, args, options, timeoutMs, timeoutLabel) {
  return new Promise((resolve) => {
    let child
    try {
      child = nodeSpawn(command, args, options)
    } catch (err) {
      // 参数非法等同步异常：与 error 事件同一收敛形状。
      resolve({ code: null, output: '', error: String(err?.message ?? err), errorCode: err?.code ?? null })
      return
    }
    let output = ''
    const onChunk = (chunk) => {
      output += chunk.toString()
      if (output.length > OUTPUT_HARD_CAP_BYTES) output = output.slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* 已退出：忽略 */ }
    }, timeoutMs)
    const killTimer = setTimeout(() => {
      if (!timedOut) return
      try { child.kill('SIGKILL') } catch { /* 已退出：忽略 */ }
    }, timeoutMs + TERM_GRACE_MS)
    const settle = (r) => { clearTimeout(timer); clearTimeout(killTimer); resolve(r) }
    child.on('error', (err) => {
      settle({ code: null, output: tailOutput(output), error: String(err?.message ?? err), errorCode: err?.code ?? null })
    })
    child.on('close', (code) => {
      settle(timedOut
        ? { code, output: tailOutput(output), error: `${timeoutLabel} 超时（${Math.round(timeoutMs / 1000)} 秒）已中止`, errorCode: 'ETIMEDOUT' }
        : { code, output: tailOutput(output) })
    })
  })
}

/** 取尾部：超长只留最后 OUTPUT_TAIL_BYTES。 */
function tailOutput(text) {
  const s = String(text ?? '')
  return s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s
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

/** env 里的用户 home（PATH 候选拼接用；缺失回退 os.homedir()）。 */
function homeFromEnv(env) {
  const raw = typeof env.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME.trim() : ''
  return raw !== '' ? raw : os.homedir()
}

/**
 * 组装 pnpm 候选链（详见文件头注）：裸 pnpm → 裸 corepack（+['pnpm'] 前缀）
 * → 各绝对路径落位（existsSync 预筛，不存在不浪费 spawn；去重保序）。
 * win32 的 pnpm / corepack 是 .cmd shim，命令补 .cmd 后缀（配合 shell:true）；
 * darwin/linux 补空串。/opt/homebrew 系仅 darwin+homebrew 存在，existsSync
 * 自然过滤，无需按平台分支。
 */
function buildCandidates({ platform, env, execPath, existsImpl, readdirImpl }) {
  const suffix = platform === 'win32' ? '.cmd' : ''
  const candidates = [
    { command: `pnpm${suffix}`, argsPrefix: [], label: 'pnpm' },
    { command: `corepack${suffix}`, argsPrefix: ['pnpm'], label: 'corepack pnpm' },
  ]
  const absolute = ['/opt/homebrew/bin/corepack']
  try {
    // /opt/homebrew/opt/<node 版本目录>/bin/corepack：目录不存在（非 ARM
    // homebrew mac）readdir 抛错即跳过；命中多个 node 版本时按名排序全收。
    const nodeDirs = readdirImpl('/opt/homebrew/opt')
      .filter((name) => name.startsWith('node'))
      .sort()
    for (const dir of nodeDirs) absolute.push(path.join('/opt/homebrew/opt', dir, 'bin', `corepack${suffix}`))
  } catch { /* 无 /opt/homebrew/opt：跳过这组候选 */ }
  absolute.push(path.join(path.dirname(execPath), `corepack${suffix}`))
  const home = homeFromEnv(env)
  absolute.push(path.join(home, 'Library', 'pnpm', `pnpm${suffix}`))
  absolute.push(path.join(home, '.local', 'share', 'pnpm', `pnpm${suffix}`))
  for (const p of [...new Set(absolute)]) {
    if (existsImpl(p)) candidates.push({ command: p, argsPrefix: [], label: p })
  }
  return candidates
}

/** 组装最小注入面：缺省走真实 Node 实现，测试逐项替换。 */
function normalizeDeps(opts = {}) {
  return {
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
    execPath: opts.execPath ?? process.execPath,
    spawnImpl: opts.spawnImpl ?? defaultSpawn,
    pkgDirImpl: opts.pkgDirImpl ?? defaultPkgDir,
    realpathImpl: opts.realpathImpl ?? ((p) => realpathSync(p)),
    existsImpl: opts.existsImpl ?? ((p) => existsSync(p)),
    readdirImpl: opts.readdirImpl ?? ((p) => readdirSync(p)),
    fetchImpl: opts.fetchImpl ?? null,
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
  const {
    env, platform, execPath, spawnImpl, pkgDirImpl, realpathImpl, existsImpl, readdirImpl,
    fetchImpl, logger, timeoutMs,
  } = normalizeDeps(opts)

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

  // ── b) 版本预检：拿不到 latest 绝不做半截升级（宁可不动现有安装）─────────
  //    官方源失败再试 npmmirror 镜像（点「升级」的用户网络本来就在出状况，
  //    多一路快路实打实救回一次升级）；仍拿不到如实报 no-target。
  const { version: current } = await currentVersion()
  const reg = await fetchLatestFromRegistry({ fetchImpl, timeoutMs: VERSION_TIMEOUT_MS })
  const mirror = reg.ok ? null : await fetchLatestFromMirror({ fetchImpl, timeoutMs: VERSION_TIMEOUT_MS })
  const manifest = reg.ok ? reg : mirror
  if (!manifest.ok) {
    return {
      ok: false,
      kind: 'no-target',
      message: `无法确定最新版本：官方源 ${reg.error}；镜像 ${manifest.error}`,
    }
  }
  const target = manifest.latest // 形如 v0.2.3
  if (compareVersions(target, current) <= 0) {
    logger?.info?.(`maoying 创作台: self-update 短路：本地 ${current} 已不落后线上 ${target}`)
    return { ok: true, kind: 'up-to-date', from: current }
  }
  const targetVersion = target.replace(/^v/, '')

  // ── c) profile 就绪判定：目录没有 package.json 说明未初始化，诚实失败，
  //      不硬跑（pnpm 会在空目录另起一份 package.json，装到错误的位置）。
  if (!existsImpl(path.join(profileDir, 'package.json'))) {
    return {
      ok: false,
      kind: 'profile-missing',
      message: `profile 未初始化（${profileDir} 缺 package.json），无法就地升级，请先重启 DeepSeek 或重新安装插件`,
    }
  }

  // ── d) pnpm 候选链：spawn ENOENT（命令不存在）才换下一路，EACCES / 超时 /
  //       非零退出都是真实运行结果，如实返回不换通道。cwd 就是 profile 目录
  //       （pnpm 的操作对象是它），不带 --dir；装精确版本而非 @latest（避开
  //       pnpm 新鲜度防护 / 镜像 packument 滞后的静默空转）。
  //       win32 的 pnpm/corepack 是 .cmd shim，必须借 shell 拉起（Node 直接
  //       spawn .cmd 会 EINVAL，见 CVE-2024-27980 加固），参数保持数组形式。
  const useShell = platform === 'win32'
  const spawnOptions = {
    cwd: profileDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
  }
  const candidates = buildCandidates({ platform, env, execPath, existsImpl, readdirImpl })
  const installArgs = ['add', `dsh-maoying@${targetVersion}`]

  let proc = null
  for (const cand of candidates) {
    proc = await spawnImpl(cand.command, [...cand.argsPrefix, ...installArgs], spawnOptions, timeoutMs, 'pnpm add')
    if (proc?.errorCode !== 'ENOENT') break
  }
  const output = tailOutput(proc?.output)

  // 全候选 ENOENT：给可操作的出路，不裸抛 spawn pnpm ENOENT（本修复的病灶）。
  if (proc?.errorCode === 'ENOENT') {
    const tried = candidates.map((c) => c.label).join(' / ')
    return {
      ok: false,
      kind: 'pnpm-missing',
      message: `未找到可用的 pnpm（已试 ${tried}）。可先在终端执行 corepack enable 并重启 DSH 后重试；或手动升级：cd ${profileDir} && corepack pnpm add dsh-maoying@${targetVersion}`,
    }
  }
  if (proc?.errorCode === 'ETIMEDOUT') {
    // 超时：SIGTERM 已发（宽限后 SIGKILL），如实收敛不换通道。
    logger?.warn?.('maoying 创作台: self-update 失败(timeout): ' + String(proc?.error ?? ''))
    return {
      ok: false,
      kind: 'timeout',
      message: `pnpm 安装超时（${Math.round(timeoutMs / 1000)} 秒）已中止，请检查网络后重试`,
    }
  }
  if (proc?.error) {
    // 其他子进程异常（EACCES 等真实结果，不换通道、不猜原因）。
    logger?.warn?.(`maoying 创作台: self-update 失败(spawn): ${proc.error}`)
    return { ok: false, kind: 'nonzero', message: `pnpm 启动失败: ${proc.error}` }
  }
  if (proc?.code !== 0) {
    return {
      ok: false,
      kind: 'nonzero',
      message: `pnpm add 失败（exit ${proc?.code}）：${output !== '' ? output : '无输出'}`,
    }
  }

  // ── e) 成功：版本缓存立刻失效（装的是磁盘新包，进程内 1h 缓存已是旧结论）。
  //       to 取预检到的精确目标版本（退出码即成败信号，不做磁盘后验——本进程
  //       代码不随升级变化，无从对账）。
  invalidateVersionCache()
  logger?.info?.(`maoying 创作台: self-update 完成 ${current} → ${targetVersion}（重启 DeepSeek 后生效）`)
  return { ok: true, kind: 'installed', from: current, to: targetVersion, restartRequired: true }
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
