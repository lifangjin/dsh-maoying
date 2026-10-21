/**
 * v2 组合源（agent.cordis.v2.yml，AgentPreset 形状）与 v1（agent.cordis.yml，
 * 内联形状）的双源一致性测试。
 *
 * 核心价值是防漂移：v2 的 persona 与行结构逐字取自 v1，两文件必须同步演进——
 * 这里逐字节断言 5 段角色 persona 相等、主编 plugins 其余行深相等、v1 各角色
 * toolFilter.allow ⊆ v2 工具行能力覆盖（固定映射表换算），另加 v2 结构自检
 * （6 行、id 唯一、config.id 与行 id 后缀一致、!!js 仅 process.platform 两种）。
 *
 * YAML 解析借 /tmp/yamlcheck 的 yaml 包（与安装器运行时同款 v2）；本机没有该
 * 目录时结构级断言整体跳过（skip），不误报——但 persona 双源一致性另有字符串级
 * 降级断言兜底（直接对两文件原文做块标量抽取比对），不随 yaml 包缺席失效。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 防御性钉死 DSH_HOME——本文件只读包内源文件，绝不碰真实 ~/.dsh。
process.env.DSH_HOME ??= path.join(path.dirname(fileURLToPath(import.meta.url)), 'unused-home')

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { parseAgentPlugins, parsePresetMeta, parsePresetRows, preprocessPatchText } = await import(
  '../index.mjs'
)

/** 测试用 yaml 包：优先 /tmp/yamlcheck（本仓库测试约定），退回常规解析路径。 */
function loadTestYaml() {
  for (const base of ['/tmp/yamlcheck/node_modules/package.json', path.join(PLUGIN_ROOT, 'package.json')]) {
    try {
      const mod = createRequire(base)('yaml')
      if (mod && typeof mod.parse === 'function') return mod
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const yaml = loadTestYaml()

/** v1 组合源原文（无 yaml 包时的字符串级降级比对用）。 */
const v1Text = readFileSync(path.join(PLUGIN_ROOT, 'presets/maoying/agent.cordis.yml'), 'utf8')
/** v1 组合源解析后的 18 行。 */
const v1Rows = yaml ? parseAgentPlugins(yaml, readFileSync(path.join(PLUGIN_ROOT, 'presets/maoying/agent.cordis.yml'), 'utf8')) : null
/** v2 组合源解析后的 6 条 preset 声明行。 */
const v2Rows = yaml ? parsePresetRows(yaml, readFileSync(path.join(PLUGIN_ROOT, 'presets/maoying/agent.cordis.v2.yml'), 'utf8')) : null
/** v2 原文（!!js grep 断言与无 yaml 包时的字符串级降级比对用）。 */
const v2Text = readFileSync(path.join(PLUGIN_ROOT, 'presets/maoying/agent.cordis.v2.yml'), 'utf8')

const ROLES = ['outline', 'write', 'review', 'lore', 'research']
const ROLE_CN = { outline: '大纲师', write: '写手', review: '审校', lore: '设定管理员', research: '素材调研员' }

/** v1 delegation 组里的 5 条角色委派行，按 toolName 索引。 */
function v1DelegationRows() {
  const group = v1Rows.find((r) => r.id === 'delegation')
  return Object.fromEntries(
    group.config.filter((c) => c.name === '@deepseek-ai/dsh-tool-subagent').map((c) => [c.config.toolName, c]),
  )
}

/** v2 按 config.id 取 preset 行。 */
const v2Preset = (id) => v2Rows.find((r) => r.config.id === id)

/**
 * 字符串级降级抽取：从原始文本按 `<key>: |-` 标记行取块标量——收集标记行之后
 * 所有「空行或缩进更深」的行，去公共缩进后返回字符串数组。只认标记行形态，
 * 块外一概不看，保守而不猜结构；块内容为空返回 null（调用方据此报错，不静默）。
 */
function extractBlockScalars(text, key) {
  const marker = new RegExp(`^(\\s*)${key}: \\|-\\s*$`)
  const lines = text.split(/\r?\n/)
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const m = marker.exec(lines[i])
    if (m === null) continue
    const markerIndent = m[1].length
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') {
        body.push('')
        continue
      }
      if (line.match(/^[ \t]*/)[0].length <= markerIndent) break
      body.push(line)
    }
    const nonBlank = body.filter((l) => l.trim() !== '')
    if (nonBlank.length === 0) return null
    const minIndent = Math.min(...nonBlank.map((l) => l.match(/^[ \t]*/)[0].length))
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    blocks.push(body.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n'))
  }
  return blocks
}

// ── v2 结构自检 ─────────────────────────────────────────────────────────────

test('v2 文件可解析为 6 条 preset 声明行，id 唯一且 config.id 与行 id 后缀一致', (t) => {
  if (!yaml) return t.skip('本机没有可用的 yaml 包（/tmp/yamlcheck）')
  assert.equal(v2Rows.length, 6)
  const ids = v2Rows.map((r) => r.id)
  assert.equal(new Set(ids).size, 6, `行 id 必须唯一，实得 ${ids.join(', ')}`)
  for (const row of v2Rows) {
    assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
    assert.equal(row.id, `preset-${row.config.id}`, `行 id 应为 "preset-" + config.id：${row.id}`)
    assert.equal(typeof row.config.name, 'string')
    assert.equal(typeof row.config.description, 'string')
    assert.ok(Number.isInteger(row.config.order))
    assert.ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0)
  }
  assert.deepEqual(
    v2Rows.map((r) => r.config.id),
    ['maoying', 'maoying-outline', 'maoying-write', 'maoying-review', 'maoying-lore', 'maoying-research'],
  )
  assert.deepEqual(
    v2Rows.map((r) => r.config.order),
    [6, 61, 62, 63, 64, 65],
  )
})

test('主编 preset 元数据与 v1 preset.yml 同源；5 张角色 preset 命名与描述合规格', (t) => {
  if (!yaml) return t.skip('本机没有可用的 yaml 包（/tmp/yamlcheck）')
  const meta = parsePresetMeta(yaml, readFileSync(path.join(PLUGIN_ROOT, 'presets/maoying/preset.yml'), 'utf8'))
  const main = v2Preset('maoying').config
  assert.equal(main.name, meta.name)
  assert.equal(main.description, meta.description)
  assert.equal(main.order, meta.order)
  for (const role of ROLES) {
    const cfg = v2Preset(`maoying-${role}`).config
    assert.equal(cfg.name, `毛颖·${ROLE_CN[role]}（内部）`)
    assert.ok(cfg.description.includes('由主编委派自动选用'), `${role} description 应注明自动选用`)
    assert.ok(cfg.description.includes('单独开会话'), `${role} description 应注明可单独开会话`)
  }
})

test('v2 文件中 !!js 表达式仅 process.platform 两种（grep 断言）', () => {
  const exprs = [...v2Text.matchAll(/!!js\s+(.+)/g)].map((m) => m[1].trim())
  assert.ok(exprs.length >= 2, 'v2 应含 !!js 表达式（tool-bash / tool-pwsh 的 disabled）')
  for (const expr of exprs) {
    assert.ok(
      expr === "process.platform === 'win32'" || expr === "process.platform !== 'win32'",
      `出现未知 !!js 表达式「${expr}」——必须同步扩充 index.mjs preprocessPatchText`,
    )
  }
})

// ── 主编 preset：v1 同构 + 委派行换形状 ──────────────────────────────────────

test('主编 preset plugins：行 id 集合与 v1 完全一致，非委派行逐字节深相等', (t) => {
  if (!yaml) return t.skip('本机没有可用的 yaml 包（/tmp/yamlcheck）')
  const mainPlugins = v2Preset('maoying').config.plugins
  assert.deepEqual(
    mainPlugins.map((r) => r.id),
    v1Rows.map((r) => r.id),
    '主编 plugins 行序与行 id 必须与 v1 完全一致',
  )
  const delegationIds = new Set(ROLES.map((role) => `delegation-${role}`))
  for (let i = 0; i < v1Rows.length; i++) {
    // delegation 组整行除外（内部 5 条委派行已换形状，另有专测）；其余行必须逐字同 v1
    if (delegationIds.has(v1Rows[i].id) || v1Rows[i].id === 'delegation') continue
    assert.deepEqual(mainPlugins[i], v1Rows[i], `行 ${v1Rows[i].id} 与 v1 不一致——v2 必须逐字同步 v1`)
  }
})

test('主编 preset 5 条委派行：无 persona/toolFilter，agentPreset 与角色 preset 一一对应', (t) => {
  if (!yaml) return t.skip('本机没有可用的 yaml 包（/tmp/yamlcheck）')
  const v1Map = v1DelegationRows()
  const delegationGroup = v2Preset('maoying').config.plugins.find((r) => r.id === 'delegation')
  const subagentRows = delegationGroup.config.filter((c) => c.name === '@deepseek-ai/dsh-tool-subagent')
  assert.equal(subagentRows.length, 5)
  for (const row of subagentRows) {
    const role = row.config.toolName
    assert.ok(ROLES.includes(role))
    assert.equal(row.id, `delegation-${role}`)
    assert.ok(!('persona' in row.config), `delegation-${role} 不得再带 persona 键（0.2.1-rc.2+ 直接拒绝）`)
    assert.ok(!('toolFilter' in row.config), `delegation-${role} 不得再带 toolFilter 键`)
    assert.equal(row.config.provider, v1Map[role].config.provider)
    assert.equal(row.config.backgroundMode, v1Map[role].config.backgroundMode)
    assert.equal(row.config.agentPreset, `maoying-${role}`)
    assert.ok(v2Rows.some((r) => r.config.id === row.config.agentPreset), `agentPreset ${row.config.agentPreset} 必须已在本补丁树声明`)
  }
  // 子代理管理两行原样保留
  assert.ok(delegationGroup.config.some((c) => c.id === 'tool-subagent-control'))
  assert.ok(delegationGroup.config.some((c) => c.id === 'tool-subagent-list-agents'))
})

// ── 双源一致性防漂移（本文件核心）───────────────────────────────────────────

/**
 * 工具行 → 模型可见工具名（v1 toolFilter.allow 的口径）换算表。布尔键缺省视为
 * 开启（与 dsh-tool-fs 默认全量一致）。skill-filesystem 是技能目录注入组件，
 * 不直接提供模型可见工具，与 tool-skill 合并计 skill。
 */
const CAPABILITY_OF_ROW = {
  'tool-fs': (row) => {
    const c = row.config ?? {}
    return [
      c.read !== false && 'read',
      c.readImage !== false && 'read_image',
      c.write !== false && 'write',
      c.edit !== false && 'edit',
    ].filter(Boolean)
  },
  'tool-fs-search': () => ['glob', 'grep'],
  'tool-bash': () => ['bash'],
  'tool-pwsh': () => ['bash'],
  'skill-filesystem': () => [],
  'tool-skill': () => ['skill'],
  'tool-ask-user': () => ['ask_user_question'],
  'tool-todo': () => ['todo_write'],
  'tool-web': (row) => (row.config?.fetch ? ['web_search', 'web_fetch'] : ['web_search']),
  'tool-goal': () => ['create_goal', 'update_goal', 'get_goal'],
  'tool-jobs': () => ['job_output', 'job_list', 'job_kill'],
}

/** v1 五角色的 toolFilter.allow 权威底册（design.md §4 表；防 v1 侧漂移）。 */
const EXPECTED_V1_ALLOW = {
  outline: ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'bash', 'skill', 'ask_user_question', 'todo_write'],
  write: ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'bash', 'skill', 'ask_user_question', 'todo_write'],
  review: ['read', 'read_image', 'glob', 'grep', 'skill', 'todo_write', 'ask_user_question'],
  lore: ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'skill', 'ask_user_question', 'todo_write'],
  research: ['web_search', 'web_fetch', 'glob', 'grep', 'read', 'write', 'bash', 'ask_user_question', 'todo_write'],
}

/**
 * v2 相对 v1 的有意收窄白名单：research 不再带 shell（考据不需要 bash，收窄
 * 攻击面）。改回必须同步更新这张表——收窄差异在这里显式记账，而不是静默放过。
 */
const V2_INTENTIONAL_NARROWING = { research: ['bash'] }

for (const role of ROLES) {
  test(`[${role}] v1 persona 逐字节 === v2 角色 preset persona`, (t) => {
    if (!yaml) return t.skip('本机没有可用的 yaml 包（/tmp/yamlcheck）')
    const v1Persona = v1DelegationRows()[role].config.persona
    const rolePlugins = v2Preset(`maoying-${role}`).config.plugins
    const personaRow = rolePlugins.find((r) => r.id === 'persona')
    assert.ok(personaRow, `maoying-${role} 缺 persona 行`)
    assert.equal(personaRow.name, '@deepseek-ai/dsh-persona')
    // v1 侧防漂移：allow 底册比对（意外漂移即失败）
    assert.deepEqual(v1DelegationRows()[role].config.toolFilter.allow, EXPECTED_V1_ALLOW[role])
    assert.equal(personaRow.config.prefix, v1Persona, 'persona 文本必须逐字节复制（防双源漂移）')
  })

  test(`[${role}] v1 toolFilter.allow ⊆ v2 工具行能力覆盖（固定映射表换算）`, (t) => {
    if (!yaml) return t.skip('本机没有可用的 yaml 包（/tmp/yamlcheck）')
    const rolePlugins = v2Preset(`maoying-${role}`).config.plugins
    const coverage = new Set()
    for (const row of rolePlugins) {
      const capability = CAPABILITY_OF_ROW[row.id]
      if (capability === undefined && !['persona', 'agent-instructions', 'compaction'].includes(row.id)) {
        assert.fail(`maoying-${role} 出现映射表未收录的工具行「${row.id}」——请补 CAPABILITY_OF_ROW`)
      }
      if (capability) for (const name of capability(row)) coverage.add(name)
    }
    const narrowed = V2_INTENTIONAL_NARROWING[role] ?? []
    for (const name of narrowed) {
      assert.ok(
        v1DelegationRows()[role].config.toolFilter.allow.includes(name),
        `收窄白名单里的「${name}」必须确实在 v1 allow 里（表与源不符）`,
      )
    }
    for (const name of v1DelegationRows()[role].config.toolFilter.allow) {
      if (narrowed.includes(name)) continue
      assert.ok(coverage.has(name), `v1 allow 的「${name}」在 v2 maoying-${role} 无对应工具行覆盖`)
    }
  })
}

// ── 无 yaml 包时的字符串级降级（防一致性把关在干净机器上静默失效）────────────

test('降级（无 yaml 包）：v1/v2 角色 persona 原始文本抽取逐字节一致', (t) => {
  if (yaml) return t.skip('本机有 yaml 包，结构级断言已覆盖；字符串级降级仅在其缺席时启用')
  const v1Personas = extractBlockScalars(v1Text, 'persona')
  const v2Prefixes = extractBlockScalars(v2Text, 'prefix')
  // 抽数量不对 = 抽取器与文件形态脱节，报错而非静默放过
  assert.ok(Array.isArray(v1Personas) && v1Personas.length === ROLES.length, `v1 应抽出 ${ROLES.length} 段角色 persona，实得 ${v1Personas && v1Personas.length}`)
  // v2 的 prefix 块含主编 persona（第 1 段），角色段取其后 5 段；v1/v2 文件内角色顺序一致
  assert.ok(Array.isArray(v2Prefixes) && v2Prefixes.length === ROLES.length + 1, `v2 应抽出 ${ROLES.length + 1} 段 prefix（主编 + 5 角色），实得 ${v2Prefixes && v2Prefixes.length}`)
  for (let i = 0; i < ROLES.length; i++) {
    assert.equal(v1Personas[i], v2Prefixes[i + 1], `[${ROLES[i]}] 降级比对：v1 persona 与 v2 prefix 原始文本不一致——v2 必须逐字同步 v1`)
  }
})
