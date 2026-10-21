/**
 * 毛颖主编工具面白名单（restrict.mjs）
 *
 * dsh-maoying 毛颖创作 preset 组件。挂 system-prompt/assemble
 * 瀑布，把主编（主 agent）的模型可见工具面收窄为「角色委派 + 内部检索 +
 * 协调」白名单。委派子代理不在此过滤——各角色的工具面由委派行的 toolFilter
 * 在子代理创建时以 per-child tools.restrict() 收窄，这里再过滤会与之相交、
 * 错误地砍掉角色工具面。
 *
 * 主编保留：
 *   - 角色委派：outline / write / review / lore / research
 *   - 子代理管理：send_message / list_agents / interrupt_agent
 *   - 内部检索（热路径，不绕委派）：glob / grep / read / read_image / bash
 *   - 协调：todo_write / ask_user_question / goal_* / job_* / exit_plan_mode
 *
 * 主编看不到（白名单外收窄——只为省请求成本，不是安全边界）：web_search /
 * web_fetch（考据委派 research）、skill 目录（registry deny 堵 ~1.3k 注入）、
 * 以及未列出的一切通用委派与工作流工具。
 *
 * write / edit 保留在白名单（见 MAIN_AGENT_ALLOW 尾段）：主编需要亲自做小修
 * 小补（改 phase、补 frontmatter、微调摘要），这些活不值得委派一次。
 *
 * Host 工具（mcp__*、插件工具）一律不硬编码——是否挂载是检测期事实，
 * 硬编码会让未装对应插件的宿主直接出错。本文件只留 dsh 核心工具。
 *
 * Fail-open：任何意外错误原样返回 assembly，过滤器 bug 绝不能弄死会话。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'maoying-restrict'

/** Prompt assembly and the tool registry must exist before this filter runs. */
export const inject = ['systemPrompt', 'tools']

/** 主编（主 agent）白名单。对 assembly.tools（注册后）的名字做匹配，未挂载的工具自然缺席，不报错。 */
const MAIN_AGENT_ALLOW = new Set([
  // ── 角色委派 ─────────────────────────────────────────────────────
  'outline',
  'write',
  'review',
  'lore',
  'research',
  // ── 子代理管理 ───────────────────────────────────────────────────
  'send_message',
  'list_agents',
  'interrupt_agent',
  // ── 内部检索（热路径） ───────────────────────────────────────────
  'glob',
  'grep',
  'read',
  'read_image',
  'bash',
  // ── 协调 ─────────────────────────────────────────────────────────
  'todo_write',
  'ask_user_question',
  'get_goal',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'job_output',
  'job_list',
  'job_kill',
  // ── 主编亲笔（小修小补不过委派） ────────────────────────────────
  'write',
  'edit',
])

/**
 * registry 级补充：skill 目录注入（dsh-tool-skill）的守卫看的是 registry 可见性
 * 而非上面的模型可见面，因此对主 agent 在 agent/created 时做 registry deny，
 * 把 ~1.3k-token 的技能目录注入一并堵住。子代理豁免（其工具面来自各委派的
 * toolFilter，scope 不交叉）。
 */
const MAIN_AGENT_REGISTRY_DENY = ['skill']

/** Warn once so a misbehaving filter never spams the log per request. */
let warned = false

/**
 * context.agent 是否为委派子代理而非会话主 agent。子会话头部带
 * origin: 'subagent' 与 delegationDepth >= 1；origin 是持久信号，delegationDepth
 * 作 belt-and-braces 兜底。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

export function apply(ctx, config = {}) {
  const allow = new Set(config.allow ?? MAIN_AGENT_ALLOW)
  if (allow.size === 0) {
    throw new TypeError(
      `${name}: configured allow list is empty — refusing to strip every tool from the main agent`,
    )
  }

  // prepend: true 把过滤器放在瀑布最外层，await next() 观察到完整下游结果后再施加白名单。
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, context, next) => {
      const assembled = await next()
      try {
        const agent = context?.agent
        if (agent === undefined) return assembled
        if (isDelegatedChild(agent)) return assembled

        const tools = Array.isArray(assembled.tools) ? assembled.tools : []
        const filtered = tools.filter((tool) => allow.has(tool?.name))
        if (!warned) {
          ctx.logger.info(
            `${name}: main agent tool surface ${tools.length} -> ${filtered.length} tools (allow=${[...allow].sort().join(', ')})`,
          )
          warned = true
        }
        return { ...assembled, tools: filtered }
      } catch (error) {
        ctx.logger.warn(`${name}: filter failed, exposing full catalog: ${String(error)}`)
        return assembled
      }
    },
    { prepend: true },
  )

  // registry 级 deny（skill 目录注入）。失败只 warn，不影响模型可见面的过滤。
  const disposers = []
  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || isDelegatedChild(agent)) return
    try {
      const tools = agent?.ctx?.tools
      if (tools === undefined || typeof tools.restrict !== 'function') return
      const deny = MAIN_AGENT_REGISTRY_DENY.filter(
        (name) => !allow.has(name) && tools.get(name, agent) !== undefined,
      )
      if (deny.length === 0) return
      disposers.push(tools.restrict({ deny }))
      ctx.logger.info(`${name}: main agent registry deny: ${deny.sort().join(', ')}`)
    } catch (error) {
      ctx.logger.warn(`${name}: registry deny failed, skill catalog may inject: ${String(error)}`)
    }
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // best-effort lift on plugin unload
        }
      }
    }, `${name}: main agent registry deny lift`)
  }
}
