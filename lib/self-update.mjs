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
 * （10s），拿不到 latest 绝不做半截升级；latest 剥 v 后强制 semver 形状校验
 * （X.Y.Z[-预发布]，M1）——被控源返回的串携带 shell 元字符时绝不进 spawn 参数
 * （win32 shell:true 下即命令注入），不匹配按 no-target 拒绝。
 * compareVersions(target, current) <= 0 直接短路「已是最新」，不 spawn。装完
 * 失效版本检测缓存。
 *
 * 装后对账（M2）：退出码 0 只代表 pnpm/npm 自认装完，半装/坏包要重启才暴露
 * ——装完回读安装位 package.json 的 version 与精确目标对账，读不到或不符一律
 * 收敛 verify-failed（新 kind，走既有 ok:false 分支，client 透传兼容），
 * message 给手动重装出路，绝不静默当成功。
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
 * 全局 CLI 顺带更新（方案 B：desktop profile 与全局 npm 安装是两份独立拷贝，
 * 只更 profile 会版本偏斜）：profile 阶段落定（installed 装完 / up-to-date
 * 短路）后跑独立的全局阶段，目标是两份安装收敛到同一精确版本：
 *   - detectGlobalCli 零 spawn 纯文件系统检测：PATH 各目录 + /opt/homebrew/bin
 *     + /usr/local/bin 找 `maoying`（win32 `maoying.cmd`），existsSync 预筛；
 *     命中后 realpathSync 该 bin 两级上溯得包根（bin/maoying.mjs → 包根），
 *     包根 package.json 的 name 必须是 dsh-maoying 才认（防怪链接）；包根
 *     realpath 落在本 profile 目录内（如 profile 自带 .bin/maoying）→ 不是
 *     全局安装，跳过该候选继续找。找不到任何候选 → { found: false }。
 *   - 找不到全局安装 → globalCli: { ok: true, skipped: 'missing' }，不 spawn；
 *   - 全局 version 不落后精确目标（含比目标更新，L5：绝不静默降级）→
 *     skipped: 'same'，不 spawn；仅落后才 spawn `npm i -g dsh-maoying@<target>`
 *     （cwd=os.tmpdir()、独立 120s 超时，npm 候选链与 pnpm 同款 spawn ENOENT
 *     探测：裸 npm → execPath 同目录 → /opt/homebrew/bin → /usr/local/bin →
 *     /opt/homebrew/opt/node@XX/bin）。装完同样回读全局安装位对账，不符收敛
 *     globalCli.ok:false + kind:'verify-failed'（不强求回滚）。
 *   - 全局阶段失败（npm 缺失 / 非零 / 超时）**不拖累整体结果**：profile 已装
 *     好，重启照常生效；globalCli.ok:false + 中文 error（含手动出路
 *     `npm i -g dsh-maoying@<target>`）如实透出。dev-link / unsupported-layout /
 *     no-target / profile-missing 等失败路径维持整单拒绝，不碰全局。
 *
 * 所有失败路径都不抛错，一律收敛为 { ok: false, kind, message } 结果对象；
 * 成功返回 { ok: true, kind: 'installed', from, to, restartRequired: true,
 * globalCli }，已是最新短路返回 { ok: true, kind: 'up-to-date', from,
 * globalCli }（globalCli 形状见上节）。硬约束：装完后运行
 * 中的进程仍是旧代码，必须重启 DeepSeek 才生效——restartRequired 恒 true，UI
 * 文案必须明说，不得暗示装完即生效。依赖全部可注入（spawnImpl / realpathImpl /
 * existsImpl / readdirImpl / fetchImpl / platform …），对齐 lib/version.mjs 的
 * fetchImpl 模式，方便测试。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  compareVersions,
  currentVersion,
  fetchLatestFromMirror,
  fetchLatestFromRegistry,
  invalidateVersionCache,
  isValidVersion,
} from './version.mjs'

/** 安装超时：pnpm 冷缓存 + 国内网络最坏留足 3 分钟。 */
export const SELF_UPDATE_TIMEOUT_MS = 180 * 1000
/** 全局 CLI 更新超时：npm i -g 单包安装，独立于 profile 的 180s，2 分钟收敛。 */
export const GLOBAL_CLI_TIMEOUT_MS = 120 * 1000
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
 * close 事件必然到达，调用方绝不悬挂）。win32（shell:true）下 child 只是
 * cmd.exe 包装壳，SIGTERM 杀不到底层进程，超时改用 taskkill /T /F 按进程树
 * 整棵杀（L12，见 timer 内注释）；platform 参数仅供测试注入，缺省进程平台。
 */
export function defaultSpawn(command, args, options, timeoutMs, timeoutLabel, platform = process.platform) {
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
      try {
        if (platform === 'win32' && child.pid != null) {
          // L12：win32（shell:true）下 child 只是 cmd.exe 包装壳，kill 只杀得
          // 掉壳，底层 pnpm/node 变孤儿继续占用网络与文件锁。taskkill /T /F
          // 按 PID 树杀整棵进程（/T 含子孙、/F 强制），壳被杀后 close 事件照
          // 常到达；taskkill 自身启动失败（System32 内置，基本不可能）退回
          // SIGKILL，下方宽限兜底不变。
          const killer = nodeSpawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
          killer.on('error', () => { try { child.kill('SIGKILL') } catch { /* 已退出：忽略 */ } })
        } else {
          // 非 win32：先 SIGTERM 给宽限（pnpm 尊重），TERM_GRACE_MS 后仍不退
          // 由下方 SIGKILL 兜底。
          child.kill('SIGTERM')
        }
      } catch { /* 已退出：忽略 */ }
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

/**
 * 全局 maoying CLI 检测（零 spawn，纯文件系统；机制见文件头注「全局 CLI 顺带
 * 更新」节）。bin 候选位 = env.PATH 各目录 + /opt/homebrew/bin + /usr/local/bin
 * （去重保序），找 `maoying`（win32 `maoying.cmd`），existsSync 预筛；命中后
 * 定位包根：win32 且真路径是 .cmd/.exe shim 时（npm/pnpm 的全局 bin 是
 * <prefix>/ 下的普通文件 shim，realpath 原样返回，两级上溯会得到 prefix 的
 * 父目录 → 包根 name 校验必失败 → Windows 恒 skipped:'missing' 静默漏更，
 * 见 M3），prefix 即 dirname(命令路径)，包根取 <prefix>/node_modules/dsh-
 * maoying；否则 realpathSync 该 bin 两级上溯得包根（bin/maoying.mjs → 包根）。
 * 包根 package.json 的 name 必须是 dsh-maoying 才认（防怪链接）；包根
 * realpath 落在 profileDir 内（或就是它）→ 是 profile 自己的
 * .bin/maoying，跳过该候选继续找。全落空 → { found: false }。
 * 任何一步异常（断链 symlink / 包根不可读 / JSON 坏）都只跳过该候选，不抛错。
 */
function detectGlobalCli({ env, platform, profileDir, existsImpl, realpathImpl, readImpl }) {
  const binName = `maoying${platform === 'win32' ? '.cmd' : ''}`
  const dirs = String(typeof env.PATH === 'string' ? env.PATH : '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter((d) => d !== '')
  dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  // profile 目录 realpath 只算一次（目录此刻必然存在——package.json 就绪闸已过；
  // 读不到真路径就退回原路径，比对退化为保守不误杀全局候选）。
  let realProfileDir = null
  try { realProfileDir = path.resolve(realpathImpl(profileDir)) } catch { realProfileDir = path.resolve(profileDir) }
  for (const dir of [...new Set(dirs)]) {
    const bin = path.join(dir, binName)
    if (!existsImpl(bin)) continue
    let cli
    try { cli = path.resolve(realpathImpl(bin)) } catch { continue }
    // M3：win32 的 .cmd/.exe shim 是 <prefix>/ 下的普通文件（realpath 原样
    // 返回），两级上溯得到的是 prefix 的父目录，包根校验必失败；shim 形态下
    // prefix 就是 dirname(命令路径)，包根直接取 <prefix>/node_modules/dsh-
    // maoying。darwin/linux 的 bin 是包根 bin/ 下的真入口，两级上溯维持原语义
    //（限 win32 判 shim：posix 上碰巧叫 *.cmd 的文件不按 shim 处理）。
    const isWinShim = platform === 'win32' && /\.(cmd|exe)$/i.test(cli)
    const root = isWinShim
      ? path.join(path.dirname(cli), 'node_modules', 'dsh-maoying')
      : path.dirname(path.dirname(cli))
    let manifest
    try { manifest = JSON.parse(readImpl(path.join(root, 'package.json'))) } catch { continue }
    if (manifest?.name !== 'dsh-maoying') continue
    let realRoot
    try { realRoot = path.resolve(realpathImpl(root)) } catch { realRoot = path.resolve(root) }
    if (realRoot === realProfileDir || realRoot.startsWith(realProfileDir + path.sep)) continue
    return {
      found: true,
      bin,
      root,
      version: typeof manifest.version === 'string' ? manifest.version : '',
    }
  }
  return { found: false }
}

/**
 * 组装 npm 候选链（全局 CLI 更新用，与 pnpm 链同款 spawn ENOENT 探测语义）：
 * 裸 npm → execPath 同目录（node 与 npm 同落位的常规发行形态）→
 * /opt/homebrew/bin → /usr/local/bin → /opt/homebrew/opt/node@XX/bin（readdirSync
 * 过滤 node 前缀目录，兜 keg-only node@XX）。绝对路径候选 existsSync 预筛；
 * 去重保序。win32 的 npm 是 .cmd shim，命令补后缀（配合 shell:true）。
 */
function buildNpmCandidates({ platform, execPath, existsImpl, readdirImpl }) {
  const suffix = platform === 'win32' ? '.cmd' : ''
  const candidates = [{ command: `npm${suffix}`, label: 'npm' }]
  const absolute = [
    path.join(path.dirname(execPath), `npm${suffix}`),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
  ]
  try {
    const nodeDirs = readdirImpl('/opt/homebrew/opt')
      .filter((name) => name.startsWith('node'))
      .sort()
    for (const dir of nodeDirs) absolute.push(path.join('/opt/homebrew/opt', dir, 'bin', `npm${suffix}`))
  } catch { /* 无 /opt/homebrew/opt：跳过这组候选 */ }
  for (const p of [...new Set(absolute)]) {
    if (existsImpl(p)) candidates.push({ command: p, label: p })
  }
  return candidates
}

/**
 * 全局 CLI 阶段（profile 阶段落定后跑；失败绝不拖累整体结果，形状见文件头注）。
 * 返回 { ok: true, skipped: 'missing' } / { ok: true, skipped: 'same', version } /
 * { ok: true, from, to: targetVersion } / { ok: false, error, output?, kind? }
 * （kind 仅装后对账失败时为 'verify-failed'）。
 * spawn 走 npm 候选链（仅 ENOENT 换下一路），cwd=os.tmpdir()（npm 全局装与
 * cwd 无关，不该在 profile / 仓库里跑），独立 globalTimeoutMs 超时。
 */
async function updateGlobalCliStage({ targetVersion, profileDir }, deps) {
  const { env, platform, execPath, spawnImpl, existsImpl, readdirImpl, realpathImpl, readImpl, logger, globalTimeoutMs } = deps
  // M1：targetVersion 进 spawn 参数（win32 shell:true）前再闸一次形状——上游
  // 已验，这里是双保险，非法串绝不拼参、绝不安装。
  if (!isValidVersion(targetVersion)) {
    const error = `目标版本串非法（${String(targetVersion)}），已拒绝更新全局 CLI；可手动执行：npm i -g dsh-maoying@latest`
    logger?.warn?.(`maoying 创作台: 全局 CLI 更新失败(bad-target): ${error}`)
    return { ok: false, error }
  }
  const g = detectGlobalCli({ env, platform, profileDir, existsImpl, realpathImpl, readImpl })
  if (!g.found) return { ok: true, skipped: 'missing' }
  // 版本比对（'' = 包根 package.json 缺 version，当旧版处理装到精确目标）。
  // L5：不落后（>=）即跳过——旧实现只对同版短路，全局比目标还新时会被
  // `npm i -g dsh-maoying@<旧目标>` 静默降级；语义应为「全局仍落后才更到
  // 同版」，绝不降级。
  if (g.version !== '' && compareVersions(g.version, targetVersion) >= 0) {
    logger?.info?.(`maoying 创作台: 全局 maoying CLI ${g.version} 不落后于目标 ${targetVersion}，跳过更新`)
    return { ok: true, skipped: 'same', version: g.version }
  }

  const spawnOptions = {
    cwd: os.tmpdir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: platform === 'win32',
  }
  const candidates = buildNpmCandidates({ platform, execPath, existsImpl, readdirImpl })
  const installArgs = ['i', '-g', `dsh-maoying@${targetVersion}`]
  const manual = `npm i -g dsh-maoying@${targetVersion}`

  let proc = null
  for (const cand of candidates) {
    proc = await spawnImpl(cand.command, installArgs, spawnOptions, globalTimeoutMs, 'npm i -g')
    if (proc?.errorCode !== 'ENOENT') break
  }
  const output = tailOutput(proc?.output)

  // 以下失败路径一律 globalCli.ok:false + 中文 error 含手动出路；整体结果由
  // 调用方维持 ok:true（profile 已装好，全局失败不追责整单）。
  if (proc?.errorCode === 'ENOENT') {
    const tried = candidates.map((c) => c.label).join(' / ')
    const error = `未找到可用的 npm（已试 ${tried}），全局 CLI 未更新；可手动执行：${manual}`
    logger?.warn?.(`maoying 创作台: 全局 CLI 更新失败(npm-missing): ${error}`)
    return { ok: false, error }
  }
  if (proc?.errorCode === 'ETIMEDOUT') {
    logger?.warn?.('maoying 创作台: 全局 CLI 更新失败(timeout): ' + String(proc?.error ?? ''))
    return {
      ok: false,
      error: `npm i -g 超时（${Math.round(globalTimeoutMs / 1000)} 秒）已中止，全局 CLI 未更新；可手动执行：${manual}`,
      output,
    }
  }
  if (proc?.error) {
    const error = `npm 启动失败: ${proc.error}，全局 CLI 未更新；可手动执行：${manual}`
    logger?.warn?.(`maoying 创作台: 全局 CLI 更新失败(spawn): ${proc.error}`)
    return { ok: false, error, output }
  }
  if (proc?.code !== 0) {
    const error = `npm i -g 失败（exit ${proc?.code}），全局 CLI 未更新；可手动执行：${manual}`
    logger?.warn?.(`maoying 创作台: 全局 CLI 更新失败(exit ${proc?.code}): ${output}`)
    return { ok: false, error, output }
  }
  // M2：全局装后对账（思路同 profile，不强求回滚）——npm 退出码 0 只代表
  // npm 自认装完，磁盘半装要重启才暴露。重跑同款零 spawn 检测回读全局安装位
  // package.json：version 与精确目标相符才算成功；重检落空（读不到）或不符
  // 如实报 verify-failed，error 带手动重装出路。整体结果仍由调用方维持
  // ok:true（profile 已装好，全局失败不追责整单）。
  const recheck = detectGlobalCli({ env, platform, profileDir, existsImpl, realpathImpl, readImpl })
  if (!recheck.found || recheck.version !== targetVersion) {
    const detail = recheck.found
      ? `npm i -g 后磁盘 version ${recheck.version} ≠ 目标 ${targetVersion}`
      : 'npm i -g 后未在 PATH 检测到全局 maoying 安装'
    const error = `全局 CLI 更新后对账失败（${detail}），请手动重装：npm i -g dsh-maoying@${targetVersion}`
    logger?.warn?.(`maoying 创作台: 全局 CLI 更新失败(verify-failed): ${detail}`)
    return { ok: false, kind: 'verify-failed', error, output }
  }
  logger?.info?.(`maoying 创作台: 全局 maoying CLI ${g.version} → ${targetVersion}`)
  return { ok: true, from: g.version, to: targetVersion }
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
    readImpl: opts.readImpl ?? ((p) => readFileSync(p, 'utf8')),
    fetchImpl: opts.fetchImpl ?? null,
    logger: opts.logger ?? console,
    timeoutMs:
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : SELF_UPDATE_TIMEOUT_MS,
    globalTimeoutMs:
      typeof opts.globalTimeoutMs === 'number' && opts.globalTimeoutMs > 0
        ? opts.globalTimeoutMs
        : GLOBAL_CLI_TIMEOUT_MS,
  }
}

/**
 * selfUpdate 主体（永不 reject；concurrency 去重与兜底 try/catch 在外层）。
 * @returns {Promise<{ok: boolean, kind: string, from?: string|null, to?: string|null,
 *           restartRequired?: boolean, message?: string,
 *           globalCli?: {ok: true, skipped: 'missing'} | {ok: true, skipped: 'same', version: string} |
 *                       {ok: true, from: string, to: string} | {ok: false, error: string, output?: string}}>}
 *           globalCli 仅两个成功路径携带，形状见文件头注「全局 CLI 顺带更新」节。
 */
async function runSelfUpdate(opts = {}) {
  const {
    env, platform, execPath, spawnImpl, pkgDirImpl, realpathImpl, existsImpl, readdirImpl, readImpl,
    fetchImpl, logger, timeoutMs, globalTimeoutMs,
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
  const targetVersion = target.replace(/^v/, '')
  // M1：targetVersion 使用前强制形状校验（X.Y.Z[-预发布]）——registry/npmmirror
  // 被控时返回的串只剥 v 前缀就采信，会拼进 `dsh-maoying@${targetVersion}`
  // 与响应文案（win32 shell:true 下即命令注入）。不匹配按 no-target 拒绝，
  // 绝不 spawn。version.mjs 源头已验，这里是使用点的双保险。
  if (!isValidVersion(targetVersion)) {
    return {
      ok: false,
      kind: 'no-target',
      message: `线上版本串非法（${target}），已拒绝升级以防注入；请稍后重试或用命令行升级`,
    }
  }
  // 全局 CLI 阶段的依赖包（两个成功路径各跑一次；失败路径整单拒绝、碰都不碰）。
  const globalDeps = { env, platform, execPath, spawnImpl, existsImpl, readdirImpl, realpathImpl, readImpl, logger, globalTimeoutMs }
  if (compareVersions(target, current) <= 0) {
    logger?.info?.(`maoying 创作台: self-update 短路：本地 ${current} 已不落后线上 ${target}`)
    // 方案 B 语义 = 两份同版：profile 已是 target 时全局 CLI 若仍落后，照样更到
    // 同一精确版本（全局没装 / 已同版时阶段内自行跳过，不 spawn）。
    const globalCli = await updateGlobalCliStage({ targetVersion, profileDir }, globalDeps)
    return { ok: true, kind: 'up-to-date', from: current, globalCli }
  }

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

  // ── e) 装后对账（M2）：退出码 0 只代表 pnpm 自认装完，半装/坏包要重启才
  //       暴露。回读安装位 package.json 的 version 与精确目标对账，相符才算
  //       成功；读不到或不符一律 verify-failed（新 kind，走既有 ok:false 分支，
  //       client 透传兼容）并给手动重装出路；与其他 profile 阶段失败路径同
  //       收敛，整单不碰全局。
  const installedManifest = path.join(profileDir, 'node_modules', 'dsh-maoying', 'package.json')
  let installedVersion = null
  try {
    installedVersion = JSON.parse(readImpl(installedManifest))?.version ?? null
  } catch { /* 读不到 / 解析失败：对账按失败处理 */ }
  if (installedVersion !== targetVersion) {
    const detail = installedVersion === null
      ? `读不到 ${installedManifest}（安装未落盘或已损坏）`
      : `磁盘 version ${installedVersion} ≠ 目标 ${targetVersion}`
    logger?.warn?.(`maoying 创作台: self-update 对账失败(verify-failed): ${detail}`)
    return {
      ok: false,
      kind: 'verify-failed',
      message: `升级后对账失败（${detail}），请手动重装：cd ${profileDir} && pnpm add dsh-maoying@${targetVersion}`,
    }
  }

  // ── f) 成功：版本缓存立刻失效（装的是磁盘新包，进程内 1h 缓存已是旧结论）。
  //       to 取预检到的精确目标版本（已与磁盘对账）。随后跑全局 CLI 阶段（方案
  //       B：desktop profile 与全局 npm 安装是两份独立拷贝，顺带更到同一精确
  //       版本）；全局阶段失败不拖累整体——profile 已装好，重启照常生效，
  //       globalCli.ok:false 如实透出。
  invalidateVersionCache()
  logger?.info?.(`maoying 创作台: self-update 完成 ${current} → ${targetVersion}（重启 DeepSeek 后生效）`)
  const globalCli = await updateGlobalCliStage({ targetVersion, profileDir }, globalDeps)
  return { ok: true, kind: 'installed', from: current, to: targetVersion, restartRequired: true, globalCli }
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
