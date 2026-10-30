/**
 * 托管块写入层测试（issue #1 配套；假 home + 注入 env/argv，全程 tmpdir，不碰真实 ~/.dsh）：
 *
 *   · resolvePatchLayer：环境变量覆盖两值、大小写/首尾空白宽容、非法值 warn 后
 *     回退启发式；启发式三条件（platform === 'android' / home 含
 *     com.deepseek.harness.compat / 含 /payload/ 路径段）→ profile，普通 home
 *     → home；payload 必须是完整路径段（payload.dsh 不算）；
 *   · resolveProfilePatchPath：--profile 两种写法、缺省兜底 web、参数在值缺失
 *     视同没传、目录不存在返回 null；
 *   · upsertManagedBlock：patchPath 自定义写入（tmp 临时件落同目录、home 层默
 *     认文件不被误建、自定义新文件不带 home 头注释、home 默认路径仍带头注释）、
 *     写前 YAML 自检（parse 抛错 → 'rejected' 且目标一字节未动）、presetName
 *     坏块检测（块外「- id: <显示名>」→ warn 不删；不匹配的 id 不误报）；
 *   · removeManagedBlockFromHome：removed / absent（无文件 / 无块）/ damaged
 *    （只有起始标记）三路，块外用户内容逐字节保留；
 *   · ensurePresetInstalled 集成：profile 层模式下 home 遗留块被清、profile
 *     patch 被写、二跑幂等 skipped；profile 目录缺失退回 home 层；home 层默认
 *     回归（patchLayer/patchPath 字段），profile 残留托管块只 warn 不删。
 *
 * 依赖真 yaml 包的集成用例借 /tmp/yamlcheck staging（AGENTS.md 约定），缺席时
 * 优雅 skip；纯函数与小手术用例全部用假 yaml 对象，不依赖 staging。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { MANAGED_BEGIN, MANAGED_END, PATCH_LAYER_ENV, ensurePresetInstalled, removeManagedBlockFromHome, resolvePatchLayer, resolveProfilePatchPath, upsertManagedBlock } =
  await import('../index.mjs')

// ── 假 home / 假 logger / 假 yaml ────────────────────────────────────────────

const YAML_STAGING = '/tmp/yamlcheck/node_modules/yaml'
const HAS_YAML_STAGING = existsSync(YAML_STAGING)

function skipWithoutYamlStaging(t) {
  if (!HAS_YAML_STAGING) t.skip('本机没有 /tmp/yamlcheck 的 yaml 包（npm install --no-save --prefix /tmp/yamlcheck yaml@2 可补）')
}

function makeLogger() {
  const lines = { info: [], warn: [] }
  return {
    lines,
    logger: {
      info: (...args) => lines.info.push(args.map(String).join(' ')),
      warn: (...args) => lines.warn.push(args.map(String).join(' ')),
    },
  }
}

/** 假 yaml 对象（纯函数/小手术用例用，不依赖 staging）：parse 恒成功。 */
const FAKE_YAML_OK = { parse: () => ({ fake: true }) }
/** 假 yaml 对象：parse 必抛（写前自检的 rejected 路径）。 */
const FAKE_YAML_BROKEN = { parse: () => { throw new Error('bad structure: 坏行在这里') } }

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'maoying-layer-'))
  cleanup.push(home)
  return home
}

/** 假 home：node_modules 里塞 yaml 包 + 假宿主版本（集成用例，保证 rows 可组装）。 */
function makeFakeHome({ hostVersion }) {
  const home = makeHome()
  assert.ok(HAS_YAML_STAGING, '本机缺少 /tmp/yamlcheck 的 yaml 包，无法搭建假 home')
  mkdirSync(path.join(home, 'node_modules'), { recursive: true })
  cpSync(YAML_STAGING, path.join(home, 'node_modules', 'yaml'), { recursive: true })
  const pkgPath = path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  mkdirSync(path.dirname(pkgPath), { recursive: true })
  writeFileSync(pkgPath, JSON.stringify({ name: '@deepseek-ai/dsh', version: hostVersion }), 'utf8')
  return home
}

/** 钉死 argv[1] 进假宿主包目录：宿主版本探测确定性命中 home 全局探针（对照 installer-shape）。 */
function pinArgv1(home) {
  process.argv[1] = path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'entry.mjs')
}

// 测试内统一改 env/argv，结束时全部恢复（node --test 每文件独立进程，互不影响）。
const PREV_DSH_HOME = process.env.DSH_HOME
const PREV_LAYER_ENV = process.env[PATCH_LAYER_ENV]
const PREV_ARGV1 = process.argv[1]
const cleanup = []
test.after(() => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREV_DSH_HOME
  if (PREV_LAYER_ENV === undefined) delete process.env[PATCH_LAYER_ENV]
  else process.env[PATCH_LAYER_ENV] = PREV_LAYER_ENV
  process.argv[1] = PREV_ARGV1
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function withHome(home, fn) {
  process.env.DSH_HOME = home
  pinArgv1(home)
  return fn()
}

const PATCH_WEB = (home) => path.join(home, 'profiles', 'web', 'cordis.patch.yml')
const HOME_PATCH = (home) => path.join(home, 'cordis.patch.yml')

/** 手搓一个最小托管块文本（不依赖 yaml 序列化）。 */
const makeBlock = (rowId) => `${MANAGED_BEGIN}\n- insert:\n    - id: ${rowId}\n${MANAGED_END}`

// ── resolvePatchLayer ────────────────────────────────────────────────────────

test('resolvePatchLayer：环境变量覆盖优先于启发式（home/profile 两值各测，大小写与空白宽容）', () => {
  const compatHome = '/data/user/0/com.deepseek.harness.compat/files/payload/.dsh'
  // 启发式必判 profile 的环境里，env=home 生效
  assert.equal(resolvePatchLayer(compatHome, { [PATCH_LAYER_ENV]: 'home' }, { platform: 'android' }), 'home')
  // 启发式必判 home 的环境里，env=profile 生效
  assert.equal(resolvePatchLayer('/home/u/.dsh', { [PATCH_LAYER_ENV]: 'profile' }, { platform: 'linux' }), 'profile')
  // 大小写与首尾空白宽容
  assert.equal(resolvePatchLayer('/home/u/.dsh', { [PATCH_LAYER_ENV]: '  PROFILE ' }, { platform: 'linux' }), 'profile')
  assert.equal(resolvePatchLayer(compatHome, { [PATCH_LAYER_ENV]: 'Home' }, { platform: 'android' }), 'home')
  // 缺省（无 env）走启发式
  assert.equal(resolvePatchLayer(compatHome, {}, { platform: 'android' }), 'profile')
  assert.equal(resolvePatchLayer('/home/u/.dsh', {}, { platform: 'linux' }), 'home')
})

test('resolvePatchLayer：非法 env 值 warn 一次并回退启发式', () => {
  const { lines, logger } = makeLogger()
  assert.equal(resolvePatchLayer('/home/u/.dsh', { [PATCH_LAYER_ENV]: 'sideways' }, { platform: 'linux', logger }), 'home')
  assert.equal(resolvePatchLayer('/data/user/0/com.deepseek.harness.compat/files/.dsh', { [PATCH_LAYER_ENV]: 'sideways' }, { platform: 'linux', logger }), 'profile')
  assert.equal(lines.warn.length, 2, '每个非法值各 warn 一次')
  assert.ok(lines.warn[0].includes(PATCH_LAYER_ENV) && lines.warn[0].includes('sideways'), 'warn 应带环境变量名与原值')
  assert.ok(lines.warn[0].includes('home'), 'warn 应带回退结果')
  // 空串/非字符串视同未设置，不 warn
  const quiet = makeLogger()
  assert.equal(resolvePatchLayer('/home/u/.dsh', { [PATCH_LAYER_ENV]: '' }, { platform: 'linux', logger: quiet.logger }), 'home')
  assert.equal(resolvePatchLayer('/home/u/.dsh', {}, { platform: 'linux', logger: quiet.logger }), 'home')
  assert.equal(quiet.lines.warn.length, 0)
})

test('resolvePatchLayer：启发式三条件——android / compat 路径 / payload 路径段（段必须整段命中）', () => {
  assert.equal(resolvePatchLayer('/root/.dsh', {}, { platform: 'android' }), 'profile', 'android 平台即 profile')
  assert.equal(
    resolvePatchLayer('/data/user/0/com.deepseek.harness.compat/files/.dsh', {}, { platform: 'linux' }),
    'profile',
    'home 含 compat 包名即 profile（无 payload 段也算）',
  )
  assert.equal(resolvePatchLayer('/data/user/0/com.deepseek.harness.compat/files/payload/.dsh', {}, { platform: 'linux' }), 'profile')
  assert.equal(resolvePatchLayer('/srv/payload/.dsh', {}, { platform: 'linux' }), 'profile', '/payload/ 段命中')
  assert.equal(resolvePatchLayer('/srv/payload.dsh/x', {}, { platform: 'linux' }), 'home', 'payload.dsh 不是整段，不算')
  assert.equal(resolvePatchLayer('/home/u/.dsh', {}, { platform: 'linux' }), 'home')
  assert.equal(resolvePatchLayer('/Users/u/.dsh', {}, { platform: 'darwin' }), 'home')
})

// ── resolveProfilePatchPath ──────────────────────────────────────────────────

test('resolveProfilePatchPath：--profile 两种写法、缺省兜底 web、值缺失视同没传、目录缺失返回 null', () => {
  const home = makeHome()
  mkdirSync(path.join(home, 'profiles', 'alpha'), { recursive: true })
  mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })

  assert.equal(resolveProfilePatchPath(home, ['dsh', '--profile', 'alpha']), path.join(home, 'profiles', 'alpha', 'cordis.patch.yml'))
  assert.equal(resolveProfilePatchPath(home, ['dsh', '--profile=alpha']), path.join(home, 'profiles', 'alpha', 'cordis.patch.yml'))
  assert.equal(resolveProfilePatchPath(home, ['dsh', 'web']), path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '无参数兜底 web')
  assert.equal(resolveProfilePatchPath(home, []), path.join(home, 'profiles', 'web', 'cordis.patch.yml'))
  assert.equal(resolveProfilePatchPath(home, ['dsh', '--profile']), path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '参数在值缺失 → 兜底 web')
  assert.equal(resolveProfilePatchPath(home, ['dsh', '--profile=']), path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '空值 → 兜底 web')
  assert.equal(resolveProfilePatchPath(home, ['dsh', '--profile', 'ghost']), null, '目录不存在返回 null')
  assert.equal(resolveProfilePatchPath(home, ['dsh', '--profile', 'ghost', '--profile', 'alpha']), null, '首个命中为准：目录不存在就是 null')
})

// ── upsertManagedBlock：patchPath 自定义写入 ─────────────────────────────────

test('upsertManagedBlock：patchPath 自定义写入——tmp 落同目录、home 层文件不被误建、新文件不带 home 头注释', () => {
  const home = makeHome()
  mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  const { logger } = makeLogger()

  const action = upsertManagedBlock(home, makeBlock('preset-maoying'), {
    versionMarkerCurrent: false,
    logger,
    patchPath: PATCH_WEB(home),
  })
  assert.equal(action, 'created')
  const text = readFileSync(PATCH_WEB(home), 'utf8')
  assert.ok(text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END), '托管块应写入自定义路径')
  assert.equal(text.includes('home 级 patch 层'), false, '自定义路径的新文件不写 home 级头注释')
  assert.equal(existsSync(HOME_PATCH(home)), false, 'home 层默认文件绝不被误建')
  for (const dir of [path.dirname(PATCH_WEB(home)), home]) {
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.cordis.patch.yml.tmp-'))
    assert.deepEqual(leftovers, [], `临时件写完即走（${dir}）`)
  }

  // 二跑幂等：版本标记一致 + 块内容一致 → skipped 零写盘
  const before = readFileSync(PATCH_WEB(home), 'utf8')
  assert.equal(upsertManagedBlock(home, makeBlock('preset-maoying'), { versionMarkerCurrent: true, logger, patchPath: PATCH_WEB(home) }), 'skipped')
  assert.equal(readFileSync(PATCH_WEB(home), 'utf8'), before)
})

test('upsertManagedBlock：home 层默认路径回归——块外用户内容保留，新文件仍带头注释', () => {
  const home = makeHome()
  writeFileSync(HOME_PATCH(home), '# 用户手工条目\n- insert:\n    - id: user-own\n', 'utf8')
  // 既有文件但没有托管块 → 文末追加，动作是 created（updated 只属于整块替换）
  const action = upsertManagedBlock(home, makeBlock('preset-maoying'), { versionMarkerCurrent: false })
  assert.equal(action, 'created')
  const text = readFileSync(HOME_PATCH(home), 'utf8')
  assert.ok(text.startsWith('# 用户手工条目'), '块外用户内容在前且逐字节保留')
  assert.ok(text.includes(MANAGED_BEGIN))

  // 全新 home 默认路径：created + home 级头注释（该路径独有）
  const fresh = makeHome()
  assert.equal(upsertManagedBlock(fresh, makeBlock('preset-maoying'), { versionMarkerCurrent: false }), 'created')
  assert.ok(readFileSync(HOME_PATCH(fresh), 'utf8').startsWith('# DeepSeek Harness home 级 patch 层'))
})

// ── upsertManagedBlock：写前 YAML 自检 ───────────────────────────────────────

test('upsertManagedBlock：写前自检 parse 抛错 → rejected，目标文件一字节未动', () => {
  const home = makeHome()
  const { lines, logger } = makeLogger()

  // 目标已存在：原内容保留
  writeFileSync(HOME_PATCH(home), 'KEEP: true\n', 'utf8')
  let action = upsertManagedBlock(home, makeBlock('preset-maoying'), {
    versionMarkerCurrent: false,
    logger,
    yaml: FAKE_YAML_BROKEN,
  })
  assert.equal(action, 'rejected')
  assert.equal(readFileSync(HOME_PATCH(home), 'utf8'), 'KEEP: true\n', 'rejected 不写盘')
  assert.equal(lines.warn.length, 1)
  assert.ok(lines.warn[0].includes(HOME_PATCH(home)), 'warn 带目标文件路径')
  assert.ok(lines.warn[0].includes('自检') && lines.warn[0].includes('bad structure'), 'warn 带解析错误信息')

  // 目标不存在：也不该被创建
  const fresh = makeHome()
  action = upsertManagedBlock(fresh, makeBlock('preset-maoying'), { versionMarkerCurrent: false, logger, yaml: FAKE_YAML_BROKEN })
  assert.equal(action, 'rejected')
  assert.equal(existsSync(HOME_PATCH(fresh)), false, 'rejected 连新文件都不建')

  // 假 yaml parse 通过 → 照常写入（自检只拦坏内容）
  assert.equal(upsertManagedBlock(fresh, makeBlock('preset-maoying'), { versionMarkerCurrent: false, logger, yaml: FAKE_YAML_OK }), 'created')
  assert.ok(readFileSync(HOME_PATCH(fresh), 'utf8').includes(MANAGED_BEGIN))

  // 未传 yaml（旧调用方形态）：维持原行为，不做自检
  const legacy = makeHome()
  assert.equal(upsertManagedBlock(legacy, makeBlock('preset-maoying'), { versionMarkerCurrent: false }), 'created')
})

// ── upsertManagedBlock：presetName 坏块检测 ──────────────────────────────────

test('upsertManagedBlock：块外「- id: <预设显示名>」坏行 → warn 不删、照常写入；不匹配的 id 不误报', () => {
  const home = makeHome()
  const DISPLAY_NAME = '毛颖创作 (Maoying)'
  // issue #1 的坏块形状：显示名被当 id，后跟 8 空格缩进的 name:
  writeFileSync(HOME_PATCH(home), `- id: ${DISPLAY_NAME}\n        name: ${DISPLAY_NAME}\n`, 'utf8')
  const { lines, logger } = makeLogger()

  const action = upsertManagedBlock(home, makeBlock('preset-maoying'), { versionMarkerCurrent: false, logger, presetName: DISPLAY_NAME, yaml: FAKE_YAML_OK })
  assert.equal(action, 'created', '坏块只 warn 不拒写（rejected 是自检的职责）')
  const text = readFileSync(HOME_PATCH(home), 'utf8')
  assert.ok(text.includes(`- id: ${DISPLAY_NAME}`), '块外坏行一字节不动（那是用户内容）')
  assert.ok(text.includes(MANAGED_BEGIN))
  assert.equal(lines.warn.length, 1)
  assert.ok(lines.warn[0].includes(`- id: ${DISPLAY_NAME}`) && lines.warn[0].includes('坏行'), 'warn 点名坏行形状')

  // 块外 id 是真正的 preset id（不匹配显示名）→ 不误报
  const clean = makeHome()
  writeFileSync(HOME_PATCH(clean), '- id: preset-maoying\n    name: some-package\n', 'utf8')
  const quiet = makeLogger()
  upsertManagedBlock(clean, makeBlock('preset-maoying'), { versionMarkerCurrent: false, logger: quiet.logger, presetName: DISPLAY_NAME, yaml: FAKE_YAML_OK })
  assert.equal(quiet.lines.warn.length, 0, '正常 id 不该触发坏块 warn')

  // 坏行恰好长在托管块内（自家声明行形状）→ 不算块外坏行，不 warn
  const inside = makeHome()
  const blockWithDisplayName = `${MANAGED_BEGIN}\n- insert:\n    - id: preset-maoying\n      name: ${DISPLAY_NAME}\n${MANAGED_END}`
  upsertManagedBlock(inside, blockWithDisplayName, { versionMarkerCurrent: false, logger: quiet.logger, presetName: DISPLAY_NAME, yaml: FAKE_YAML_OK })
  assert.equal(quiet.lines.warn.filter((l) => l.includes('坏行')).length, 0, '托管块内的同名行不是块外坏行')
})

// ── removeManagedBlockFromHome ───────────────────────────────────────────────

test('removeManagedBlockFromHome：removed——整段删除含标记，块外用户内容逐字节保留', () => {
  const home = makeHome()
  writeFileSync(HOME_PATCH(home), `HEAD: 1\n${MANAGED_BEGIN}\n- insert:\n    - id: stale\n${MANAGED_END}\nTAIL: 2\n`, 'utf8')
  const { logger } = makeLogger()
  assert.equal(removeManagedBlockFromHome(home, { logger }), 'removed')
  assert.equal(readFileSync(HOME_PATCH(home), 'utf8'), 'HEAD: 1\nTAIL: 2\n', '块外内容逐字节保留、块含标记整段消失')
})

test('removeManagedBlockFromHome：absent（无文件 / 无块）与 damaged（只有起始标记）', () => {
  const home = makeHome()
  assert.equal(removeManagedBlockFromHome(home), 'absent', '文件不存在 no-op')

  writeFileSync(HOME_PATCH(home), 'USER: 1\n', 'utf8')
  assert.equal(removeManagedBlockFromHome(home), 'absent', '无托管块 no-op')
  assert.equal(readFileSync(HOME_PATCH(home), 'utf8'), 'USER: 1\n')

  const damaged = makeHome()
  const damagedText = `${MANAGED_BEGIN}\n- insert:\n    - id: broken\n`
  writeFileSync(HOME_PATCH(damaged), damagedText, 'utf8')
  const { lines, logger } = makeLogger()
  assert.equal(removeManagedBlockFromHome(damaged, { logger }), 'damaged', '损坏块不炸主流程')
  assert.equal(readFileSync(HOME_PATCH(damaged), 'utf8'), damagedText, 'damaged 原文件一字节不动')
  assert.equal(lines.warn.length, 1)
  assert.ok(lines.warn[0].includes('损坏'))
})

// ── ensurePresetInstalled 集成（需真 yaml staging）──────────────────────────

test('ensurePresetInstalled：profile 层模式——home 遗留块被清、profile patch 被写、二跑幂等', (t) => {
  skipWithoutYamlStaging(t)
  const home = makeFakeHome({ hostVersion: '0.2.1-rc.2' })
  mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(HOME_PATCH(home), `# 用户手工条目\n${MANAGED_BEGIN}\n- insert:\n    - id: stale-maoying\n${MANAGED_END}\n`, 'utf8')
  process.env[PATCH_LAYER_ENV] = 'profile'
  withHome(home, () => {
    const { lines, logger } = makeLogger()
    const result = ensurePresetInstalled({ logger })
    assert.equal(result.status, 'ok')
    assert.equal(result.patchLayer, 'profile')
    assert.equal(result.patchPath, PATCH_WEB(home))
    assert.equal(result.blockAction, 'created')

    const profileText = readFileSync(PATCH_WEB(home), 'utf8')
    assert.ok(profileText.includes(MANAGED_BEGIN) && profileText.includes('preset-maoying'), 'profile patch 应含托管块')
    assert.equal(profileText.includes('home 级 patch 层'), false, 'profile 层新文件不写 home 头注释')
    const homeText = readFileSync(HOME_PATCH(home), 'utf8')
    assert.equal(homeText.includes(MANAGED_BEGIN), false, 'home 层遗留托管块应被整段清掉（防双声明）')
    assert.ok(homeText.includes('# 用户手工条目'), '清理只动托管块，块外用户内容保留')
    assert.ok(lines.info.some((l) => l.includes('托管块已写入 profile 层（web）')), `安装日志应带层信息：${lines.info}`)
    assert.ok(lines.info.some((l) => l.includes('已清理 home 层遗留托管块')), '清理动作应有 info 留痕')

    // 二跑幂等：skipped 零写盘，home 层 absent 无第二次清理 info
    const before = readFileSync(PATCH_WEB(home), 'utf8')
    const rerun = ensurePresetInstalled({ logger: makeLogger().logger })
    assert.equal(rerun.status, 'ok')
    assert.equal(rerun.blockAction, 'skipped')
    assert.equal(rerun.patchLayer, 'profile')
    assert.equal(readFileSync(PATCH_WEB(home), 'utf8'), before, '二跑零写盘')
  })
})

test('ensurePresetInstalled：profile 目录缺失 → warn 退回 home 层，托管块照常落 home', (t) => {
  skipWithoutYamlStaging(t)
  const home = makeFakeHome({ hostVersion: '0.2.1-rc.2' })
  process.env[PATCH_LAYER_ENV] = 'profile'
  withHome(home, () => {
    const { lines, logger } = makeLogger()
    const result = ensurePresetInstalled({ logger })
    assert.equal(result.status, 'ok')
    assert.equal(result.patchLayer, 'home', '退回 home 层')
    assert.equal(result.patchPath, HOME_PATCH(home))
    assert.equal(result.blockAction, 'created')
    assert.ok(readFileSync(HOME_PATCH(home), 'utf8').includes(MANAGED_BEGIN))
    assert.equal(lines.warn.filter((l) => l.includes('退回 home 层')).length, 1, '退回应 warn 一次')
  })
})

test('ensurePresetInstalled：home 层默认回归 + profile 残留托管块只 warn 不删', (t) => {
  skipWithoutYamlStaging(t)
  const home = makeFakeHome({ hostVersion: '0.2.1-rc.2' })
  mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  const PROFILE_ORIGINAL = `${MANAGED_BEGIN}\n- insert:\n    - id: hand-moved-maoying\n${MANAGED_END}\n`
  writeFileSync(PATCH_WEB(home), PROFILE_ORIGINAL, 'utf8')
  delete process.env[PATCH_LAYER_ENV] // 本用例测 home 层默认：显式清掉层覆盖
  withHome(home, () => {
    const { lines, logger } = makeLogger()
    const result = ensurePresetInstalled({ logger })
    assert.equal(result.status, 'ok')
    assert.equal(result.patchLayer, 'home')
    assert.equal(result.patchPath, HOME_PATCH(home))
    assert.equal(result.blockAction, 'created')
    assert.ok(readFileSync(HOME_PATCH(home), 'utf8').includes(MANAGED_BEGIN), 'home 层照常写入')
    assert.equal(readFileSync(PATCH_WEB(home), 'utf8'), PROFILE_ORIGINAL, 'home 层模式绝不自动删 profile 层托管块')
    assert.equal(lines.warn.filter((l) => l.includes('双声明')).length, 1, '应恰好一条双声明 warn')
  })
})
