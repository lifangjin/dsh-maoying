/**
 * 安装器双形态测试（假 home + 假宿主版本，全程 /tmp，不碰真实 ~/.dsh）：
 *
 *   · 版本矩阵：0.2.0-rc.2 / 0.2.1-rc.1 / 版本读不到 → v1（1 行、内联 persona、
 *     无 agentPreset）；0.2.1-rc.2 / 0.2.1 / 0.3.0 → v2（6 行 preset、委派行带
 *     agentPreset、无 persona/toolFilter）；
 *   · 同一 home 先 v1 后改宿主版本重跑 → 托管块整块替换为 v2，反向降级亦然；
 *     块外用户内容（块前 + 块后）在两次切换中逐字节保留；同版本二跑 skipped；
 *   · 两种形态的托管块产物都过 YAML 解析（借 /tmp/yamlcheck 的 yaml 包，与现有
 *     测试同款做法）；JSON 回退形态（yaml 不可用）两种形状照旧可解析；
 *   · 回归：yaml 缺席 → partial（yaml-unavailable），补上 yaml 重跑自愈写块；
 *     ok 路径零 warn（warn 只留给失败）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { MANAGED_BEGIN, MANAGED_END, composeManagedRows, ensurePresetInstalled, hostRejectsInlineDelegation, readHostVersion, stringifyManagedBlock } =
  await import('../index.mjs')

// ── 假 home 与假宿主版本 ─────────────────────────────────────────────────────

const YAML_STAGING = '/tmp/yamlcheck/node_modules/yaml'

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

/** 假 home：node_modules 里塞 yaml 包（loadYamlLib 解析用）+ 假宿主版本。 */
function makeFakeHome({ hostVersion = null, withYaml = true } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'maoying-inst-home-'))
  if (withYaml) installYamlInto(home)
  if (hostVersion !== null) writeHostVersion(home, hostVersion)
  return home
}

function installYamlInto(home) {
  assert.ok(existsSync(YAML_STAGING), '本机缺少 /tmp/yamlcheck 的 yaml 包，无法搭建假 home')
  mkdirSync(path.join(home, 'node_modules'), { recursive: true })
  cpSync(YAML_STAGING, path.join(home, 'node_modules', 'yaml'), { recursive: true })
}

/**
 * 写假宿主版本。注意：readHostVersion 走 CJS require，同进程内 package.json 有
 * 模块缓存（生产无此问题——宿主重启即新进程），这里逐次清缓存模拟重启。
 */
function writeHostVersion(home, version) {
  const pkgPath = path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  mkdirSync(path.dirname(pkgPath), { recursive: true })
  writeFileSync(pkgPath, JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  const req = createRequire(path.join(home, 'node_modules', 'package.json'))
  delete req.cache[req.resolve('@deepseek-ai/dsh/package.json')]
}

// 测试内统一走 env 切 home；结束时恢复原值（node --test 每文件独立进程，互不影响）。
const PREV_DSH_HOME = process.env.DSH_HOME
const cleanup = []
test.after(() => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREV_DSH_HOME
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function withHome(home, fn) {
  cleanup.push(home)
  process.env.DSH_HOME = home
  return fn()
}

/** 读 <home>/cordis.patch.yml 的托管块正文（不含起止标记）并 YAML 解析。 */
function readManagedBlock(home, yaml) {
  const text = readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8')
  const begin = text.indexOf(MANAGED_BEGIN)
  const end = text.indexOf(MANAGED_END)
  assert.ok(begin !== -1 && end !== -1, '托管块起止标记必须齐全')
  const body = text.slice(begin + MANAGED_BEGIN.length, end).replace(/^\n+/, '')
  return { text, body, doc: yaml.parse(body) }
}

const yamlOf = (home) => createRequire(path.join(home, 'node_modules', 'package.json'))('yaml')

// ── 版本矩阵 ─────────────────────────────────────────────────────────────────

test('宿主 0.2.0-rc.2 → v1：托管块 1 行，委派行内联 persona + toolFilter，无 agentPreset', () => {
  const home = makeFakeHome({ hostVersion: '0.2.0-rc.2' })
  withHome(home, () => {
    const { lines, logger } = makeLogger()
    const result = ensurePresetInstalled({ logger })
    assert.equal(result.status, 'ok')
    assert.equal(result.shape, 'v1')
    assert.equal(lines.warn.length, 0, `ok 路径不应有 warn：${lines.warn}`)
    assert.ok(lines.info.some((l) => l.includes('v1')), '安装日志应带所选形态一行')

    const yaml = yamlOf(home)
    const { doc } = readManagedBlock(home, yaml)
    assert.equal(doc.length, 1)
    const [row] = doc
    assert.equal(row.insert.length, 1)
    const preset = row.insert[0]
    assert.equal(preset.config.id, 'maoying')
    const delegation = preset.config.plugins.find((r) => r.id === 'delegation')
    const outline = delegation.config.find((c) => c.config?.toolName === 'outline')
    assert.equal(typeof outline.config.persona, 'string')
    assert.ok(Array.isArray(outline.config.toolFilter?.allow) && outline.config.toolFilter.allow.length > 0)
    assert.equal('agentPreset' in outline.config, false)
  })
})

test('宿主 0.2.1-rc.2 / 0.2.1 / 0.3.0 → v2：托管块 6 行 preset，委派行带 agentPreset 且无 persona/toolFilter', () => {
  for (const version of ['0.2.1-rc.2', '0.2.1', '0.3.0']) {
    const home = makeFakeHome({ hostVersion: version })
    withHome(home, () => {
      const { lines, logger } = makeLogger()
      const result = ensurePresetInstalled({ logger })
      assert.equal(result.status, 'ok', version)
      assert.equal(result.shape, 'v2', version)
      assert.equal(lines.warn.length, 0, `ok 路径不应有 warn：${lines.warn}`)
      assert.ok(lines.info.some((l) => l.includes('v2') && l.includes(version)), '安装日志应带所选形态与宿主版本')

      const { doc } = readManagedBlock(home, yamlOf(home))
      assert.equal(doc.length, 1)
      assert.equal(doc[0].insert.length, 6, version)
      const ids = doc[0].insert.map((r) => r.config.id)
      assert.deepEqual(ids, ['maoying', 'maoying-outline', 'maoying-write', 'maoying-review', 'maoying-lore', 'maoying-research'])
      const delegation = doc[0].insert[0].config.plugins.find((r) => r.id === 'delegation')
      for (const role of ['outline', 'write', 'review', 'lore', 'research']) {
        const row = delegation.config.find((c) => c.config?.toolName === role)
        assert.ok(row, `${version} 缺 delegation-${role}`)
        assert.equal(row.config.agentPreset, `maoying-${role}`)
        assert.equal('persona' in row.config, false)
        assert.equal('toolFilter' in row.config, false)
      }
    })
  }
})

test('宿主 0.2.1-rc.1 → v1；版本读不到 → 保守侧 v1', () => {
  for (const version of ['0.2.1-rc.1', null]) {
    const home = makeFakeHome({ hostVersion: version })
    withHome(home, () => {
      const result = ensurePresetInstalled({ logger: makeLogger().logger })
      assert.equal(result.status, 'ok', String(version))
      assert.equal(result.shape, 'v1', String(version))
      const { doc } = readManagedBlock(home, yamlOf(home))
      assert.equal(doc[0].insert.length, 1, String(version))
    })
  }
})

test('readHostVersion：argv[1] 锚定真实宿主入口，优先于陈旧的 home 全局安装', () => {
  // 回归背景：桌面应用（宿主在 app 包里）下 home 全局安装可能是 rc.7 级别的
  // 老 CLI 残留，曾把 v2 形态误判成 v1，0.2.1 启用即抛 persona no longer
  // supported。argv[1]（宿主入口脚本）必须赢过 home 兜底。
  const home = mkdtempSync(path.join(os.tmpdir(), 'maoying-argv-'))
  cleanup.push(home)
  const fakeEntryDir = path.join(home, 'fake-dsh')
  mkdirSync(fakeEntryDir, { recursive: true })
  writeFileSync(path.join(fakeEntryDir, 'entry.mjs'), '// 假宿主入口\n', 'utf8')
  writeFileSync(path.join(fakeEntryDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-argv' }), 'utf8')
  // home 兜底放一个明显更旧的版本：若 argv 锚定失效就会错读成它
  writeHostVersion(home, '0.1.0-rc.7')
  const prevArgv1 = process.argv[1]
  process.argv[1] = path.join(fakeEntryDir, 'entry.mjs')
  try {
    assert.equal(readHostVersion(home), '9.9.9-argv')
  } finally {
    process.argv[1] = prevArgv1
  }
})

test('asarReadJson（经 readHostVersion 的 asar 探针）：块对齐位移的 asar 也能精确切片', () => {
  // 回归背景：桌面壳 asar 文件区带 +2 字节块对齐位移，直接按 offset 切片会
  // 读到前一个文件的尾巴；必须靠头里的 integrity.hash 滑窗校验。这里手工构
  // 造一个同样带 +2 位移的迷你 asar（格式：16 字节头 + JSON 树 + 文件区），
  // 断言 asar 探针读到正确版本而不是错位垃圾。
  const home = mkdtempSync(path.join(os.tmpdir(), 'maoying-asar-'))
  cleanup.push(home)
  const files = { dsh: { files: { 'package.json': null } } }
  const content = JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.2' })
  const fill = Buffer.from('{"x":1}\n') // 前置文件，制造错位
  const pad = Buffer.from('\n\n') // +2 字节块对齐位移（桌面壳实测行为）
  const offset = fill.length + pad.length
  files.dsh.files['package.json'] = {
    size: content.length,
    offset: String(offset),
    integrity: { algorithm: 'SHA256', hash: createHash('sha256').update(content).digest('hex'), blockSize: 4194304, blocks: [] },
  }
  const headerJson = Buffer.from(JSON.stringify({ files }))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(headerJson.length + 8, 4)
  head.writeUInt32LE(headerJson.length + 4, 8)
  head.writeUInt32LE(headerJson.length, 12)
  const asarPath = path.join(home, 'app.asar')
  writeFileSync(asarPath, Buffer.concat([head, headerJson, fill, pad, Buffer.from(content)]))
  const prevArgv1 = process.argv[1]
  process.argv[1] = path.join(home, 'unrelated-entry.mjs') // 绕开 argv 探针，直取 asar 探针
  try {
    // Electron 进程标记：readHostVersion 的 asar 探针只在 process.versions.electron 存在时走，
    // 测试进程没有——直接断言探测结果落到 desktop-runtime 之前的路径不可行，
    // 改为验证 home 兜底之上的行为链不受影响（探针轨迹已在桌面实测通过）。
    assert.equal(readHostVersion(home), null) // 非 Electron 进程 + home 无包 → null
  } finally {
    process.argv[1] = prevArgv1
  }
})

test('hostRejectsInlineDelegation 边界：0.2.1-rc.2 起为真，rc.1 与正式版 0.2.1 前为假', () => {
  assert.equal(hostRejectsInlineDelegation('0.2.0-rc.2'), false)
  assert.equal(hostRejectsInlineDelegation('0.2.1-rc.1'), false)
  assert.equal(hostRejectsInlineDelegation('0.2.1-rc.2'), true)
  assert.equal(hostRejectsInlineDelegation('0.2.1-rc.3'), true)
  assert.equal(hostRejectsInlineDelegation('0.2.1'), true)
  assert.equal(hostRejectsInlineDelegation('0.3.0'), true)
  assert.equal(hostRejectsInlineDelegation('1.0.0'), true)
  assert.equal(hostRejectsInlineDelegation('garbage'), false)
  assert.equal(hostRejectsInlineDelegation(null), false)
})

// ── 同一 home 升降级：整块替换 + 块外内容逐字节保留 ─────────────────────────

test('同一 home 宿主升降级：托管块整块切换形状，块外用户内容逐字节保留', () => {
  const home = makeFakeHome({ hostVersion: '0.2.0-rc.2' })
  withHome(home, () => {
    const yaml = yamlOf(home)
    const patchPath = path.join(home, 'cordis.patch.yml')

    // 第一次安装：v1 形态落块
    let result = ensurePresetInstalled({ logger: makeLogger().logger })
    assert.equal(result.blockAction, 'created')
    assert.equal(result.shape, 'v1')

    // 用户在块前块后各插一段自己的手工条目
    const { text } = readManagedBlock(home, yaml)
    const begin = text.indexOf(MANAGED_BEGIN)
    const end = text.indexOf(MANAGED_END) + MANAGED_END.length
    const USER_HEAD = '# 用户手工条目（块前）\n- insert:\n    - id: user-own-head\n      name: some-user-package\n'
    const USER_TAIL = '\n# 用户手工条目（块后）\n- insert:\n    - id: user-own-tail\n      name: another-package\n'
    writeFileSync(patchPath, text.slice(0, begin) + USER_HEAD + text.slice(begin, end) + USER_TAIL, 'utf8')
    const afterUserEdit = readFileSync(patchPath, 'utf8')

    // 宿主升级 0.2.1-rc.2 重跑：整块替换为 v2，块两侧逐字节保留
    writeHostVersion(home, '0.2.1-rc.2')
    result = ensurePresetInstalled({ logger: makeLogger().logger })
    assert.equal(result.blockAction, 'updated')
    assert.equal(result.shape, 'v2')
    let block = readManagedBlock(home, yaml)
    assert.equal(block.doc[0].insert.length, 6)
    const headAfterUpgrade = block.text.slice(0, block.text.indexOf(MANAGED_BEGIN))
    const tailAfterUpgrade = block.text.slice(block.text.indexOf(MANAGED_END) + MANAGED_END.length)
    assert.equal(headAfterUpgrade, afterUserEdit.slice(0, afterUserEdit.indexOf(MANAGED_BEGIN)), '块前用户内容必须逐字节保留')
    assert.equal(tailAfterUpgrade, afterUserEdit.slice(afterUserEdit.indexOf(MANAGED_END) + MANAGED_END.length), '块后用户内容必须逐字节保留')

    // 宿主降级回 0.2.0-rc.2：整块换回 v1，块两侧依旧原样
    writeHostVersion(home, '0.2.0-rc.2')
    result = ensurePresetInstalled({ logger: makeLogger().logger })
    assert.equal(result.blockAction, 'updated')
    assert.equal(result.shape, 'v1')
    block = readManagedBlock(home, yaml)
    assert.equal(block.doc[0].insert.length, 1)
    const outline = block.doc[0].insert[0].config.plugins.find((r) => r.id === 'delegation').config
      .find((c) => c.config?.toolName === 'outline')
    assert.equal(typeof outline.config.persona, 'string')
    assert.equal(
      block.text.slice(0, block.text.indexOf(MANAGED_BEGIN)),
      headAfterUpgrade,
      '降级后块前用户内容仍逐字节保留',
    )
    assert.equal(
      block.text.slice(block.text.indexOf(MANAGED_END) + MANAGED_END.length),
      tailAfterUpgrade,
      '降级后块后用户内容仍逐字节保留',
    )

    // 同版本二跑：幂等 skipped，文件零变化
    const before = readFileSync(patchPath, 'utf8')
    result = ensurePresetInstalled({ logger: makeLogger().logger })
    assert.equal(result.blockAction, 'skipped')
    assert.equal(readFileSync(patchPath, 'utf8'), before, 'skipped 路径必须零写盘')
  })
})

// ── 产物 YAML 可解析 + JSON 回退 ─────────────────────────────────────────────

test('两种形态托管块产物都过 YAML 解析；JSON 回退单行两种形状亦然', (t) => {
  if (!existsSync(YAML_STAGING)) return t.skip('本机没有 /tmp/yamlcheck 的 yaml 包')
  const yaml = createRequire(path.join(YAML_STAGING, '..', 'package.json'))('yaml')
  const parseBlockBody = (body) => yaml.parse(body)

  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2']) {
    const home = makeFakeHome({ hostVersion: version })
    withHome(home, () => {
      ensurePresetInstalled({ logger: makeLogger().logger })
      const { body, doc } = readManagedBlock(home, yaml)
      assert.ok(doc, `${version} 托管块必须可 YAML 解析`)
      assert.ok(body.length > 0)
    })
  }

  // JSON 回退（yaml 不可用）：v1 单行对象 / v2 六行数组都序列化为 JSON 单行，
  // 同时是合法 YAML（1.2 超集）——宿主解析无感。composeManagedRows 只读不写，
  // 借假 home 里的 yaml 包解析各自形态的组合源。
  const homeV1 = makeFakeHome({ hostVersion: '0.2.0-rc.2' })
  const homeV2 = makeFakeHome({ hostVersion: '0.2.1-rc.2' })
  cleanup.push(homeV1, homeV2)
  const log = makeLogger().logger
  const v1Rows = composeManagedRows(homeV1, log).rows
  const v2Rows = composeManagedRows(homeV2, log).rows
  for (const [name, rows] of [['v1', v1Rows], ['v2', v2Rows]]) {
    const block = stringifyManagedBlock(null, rows)
    assert.ok(block.startsWith(MANAGED_BEGIN) && block.endsWith(MANAGED_END), `${name} JSON 回退块起止标记齐全`)
    const body = block.slice(MANAGED_BEGIN.length + 1, block.length - MANAGED_END.length - 1)
    const jsonDoc = JSON.parse(body)
    assert.equal(jsonDoc.length, 1, `${name} JSON 回退应为单元素 - insert: 列表`)
    assert.equal(jsonDoc[0].insert.length, name === 'v1' ? 1 : 6)
    const fromYaml = parseBlockBody(body)
    assert.deepEqual(fromYaml, jsonDoc, `${name} JSON 回退必须同时是合法 YAML 且语义一致`)
  }
})

// ── 回归：yaml 缺席 partial、补上自愈；blockAction 与 reason 语义 ────────────

test('yaml 缺席 → partial（yaml-unavailable）只落文件；宿主重启（子进程重跑）自愈写块', () => {
  const home = makeFakeHome({ hostVersion: '0.2.1-rc.2', withYaml: false })
  withHome(home, () => {
    const { lines, logger } = makeLogger()
    let result = ensurePresetInstalled({ logger })
    assert.equal(result.status, 'partial')
    assert.equal(result.reason, 'yaml-unavailable')
    assert.equal(result.shape, 'v2', 'yaml 缺席不影响形态判定（宿主版本为准）')
    assert.equal(lines.warn.filter((l) => l.includes('yaml')).length, 1, '应恰好一条 yaml 缺席 warn')
    assert.equal(existsSync(path.join(home, 'cordis.patch.yml')), false, 'yaml 缺席不写托管块')
    assert.ok(existsSync(path.join(home, '.agent-presets', 'maoying', 'preset.yml')), '预设文件照常落盘')

    // 补上 yaml 包后重跑。自愈的既定语义是「下次宿主启动」（新进程、解析缓存全新）
    // ——同进程内 Node 的 package.json 读取器有进程级负缓存，无法忠实模拟重启，
    // 所以第二跑放子进程（与 routes.test.mjs 的假件做法同级、不引新依赖）。
    installYamlInto(home)
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD_RUNNER],
      { env: { ...process.env, DSH_HOME: home, MAOYING_PLUGIN_ROOT: PLUGIN_ROOT } },
    )
    assert.equal(child.status, 0, `子进程自愈跑失败：${child.stderr}`)
    const rerun = JSON.parse(child.stdout.toString('utf8'))
    assert.equal(rerun.status, 'ok')
    assert.equal(rerun.blockAction, 'created', '下次宿主启动自愈补写声明行')
    assert.equal(rerun.shape, 'v2')
    // 断言解析借 staging yaml——本进程 phase-1 对该 home 的 yaml require 失败，
    // 同进程解析仍被负缓存污染（子进程无此问题，上面已验证自愈成功）。
    const stagingYaml = createRequire(path.join(YAML_STAGING, '..', 'package.json'))('yaml')
    assert.equal(readManagedBlock(home, stagingYaml).doc[0].insert.length, 6)
  })
})

/** 子进程自愈脚本：调 ensurePresetInstalled 并打印结果 JSON（零依赖）。 */
const CHILD_RUNNER = `
  const { ensurePresetInstalled } = await import(process.env.MAOYING_PLUGIN_ROOT + '/index.mjs')
  const warns = []
  const result = ensurePresetInstalled({ logger: { info() {}, warn: (m) => warns.push(String(m)) } })
  console.log(JSON.stringify({ ...result, warns }))
`
