/* fish-engineering-tools-gate · Host half
 * 「开启思考与执行」只控制 preset 为 fish 的 Agent。
 * 关闭：隐藏选定的 DSH 原生工程工具，并拒绝旧句柄调用；开启：撤销本插件的限制。
 * standard（包括鱼派发的 standard Worker）和其他 Agent 不受此开关影响。
 * 鱼脑总开关关闭时本插件随之卸载；独立的子 Agent 开关保持原有语义。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'fish-engineering-tools-gate'
export const inject = ['tools', 'connection', 'agents', 'agentPresets']

/** fish 可见面的原生工程工具清单；只限制 fish，不改变原生插件本身或其他 Agent。 */
const CONTROLLED = Object.freeze([
  'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'pwsh', 'job_list', 'job_output', 'job_kill',
  'web_search', 'web_fetch',
  'exit_plan_mode', 'create_goal', 'update_goal', 'get_goal', 'todo_write', 'workflow',
  'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list',
  'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'skill',
  'worker' // fish 将原生 subagent 工具配置成的别名，同样受控。
])

const CONTROLLED_SET = new Set(CONTROLLED)

const DEFAULT_STATE_PATH = 'D:/deepseek框架/DSH/profiles/fish-main/engineering-tools.json'
const TARGET_PRESET = 'fish'

const DENY_REASON = '已拒绝：当前 fish Agent 的思考与执行已关闭，不能使用原生工程工具或委派 Worker；可继续对话，或由用户开启此开关。'

function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || DEFAULT_STATE_PATH
}

function loadState(statePath) {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    return raw?.enabled === true
  } catch {
    /* 缺省或损坏 = 关闭（聊天模式），与界面默认一致 */
    return false
  }
}

function saveState(statePath, enabled) {
  const dir = dirname(statePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${statePath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  renameSync(tmp, statePath)
}

function jsonResponse(request, value, status = 200) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function apply(ctx, config = {}) {
  const statePath = normalizePath(config.statePath)
  /* 保留用户选择；关闭时只限制 fish 的原生工程工具。 */
  let enabled = loadState(statePath)

  /** agent -> { preset, hide?, guard? } */
  const tracked = new Map()

  function presetOf(agent) {
    try {
      const list = ctx.agentPresets.inspectCompositions(agent.ctx)
      if (!Array.isArray(list) || list.length === 0) return undefined
      return list[0].id
    } catch {
      return undefined
    }
  }

  function engage(entry, agent) {
    if (CONTROLLED.length === 0 || entry.hide !== undefined) return
    entry.hide = agent.ctx.tools.hide(CONTROLLED)
    entry.guard = agent.ctx.tools.guard((exec) => {
      if (enabled) return undefined
      const toolName = typeof exec?.name === 'string' ? exec.name : ''
      return CONTROLLED_SET.has(toolName) ? DENY_REASON : undefined
    })
  }

  function disengage(entry) {
    const failures = []
    try { entry.guard?.(); entry.guard = undefined } catch (error) { failures.push(error) }
    try { entry.hide?.(); entry.hide = undefined } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'fish engineering gate release failed')
  }

  function track(agent) {
    const preset = presetOf(agent)
    if (preset !== TARGET_PRESET) { untrack(agent); return }
    if (tracked.has(agent)) return
    const entry = { preset, hide: undefined, guard: undefined }
    tracked.set(agent, entry)
    if (!enabled) engage(entry, agent)
  }

  function untrack(agent) {
    const entry = tracked.get(agent)
    if (entry === undefined) return
    disengage(entry)
    tracked.delete(agent)
  }

  function reconcile() {
    for (const [agent, entry] of tracked) {
      if (enabled) disengage(entry)
      else engage(entry, agent)
    }
  }

  /* 已存在的 Agent（重启后恢复的会话）与后续新建的 Agent 都要覆盖 */
  try {
    for (const agent of ctx.agents.list()) track(agent)
  } catch { /* 服务未就绪时由 agent/created 兜底 */ }
  ctx.on('agent/created', ({ agent }) => { track(agent) })
  // DSH 在空白会话中原地切换预设，不会再次触发 agent/created。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'agent-preset/selected') return
    const agent = ctx.agents.get(session.id)
    if (agent) track(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { untrack(agent) })
  ctx.effect(() => () => {
    for (const [agent, entry] of tracked) { disengage(entry); tracked.delete(agent) }
  }, 'fish-engineering-tools-gate: release all agents')

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/fish-eng-tools/state',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET' || request.method === 'HEAD') {
          return jsonResponse(request, {
            enabled,
            tools: [...CONTROLLED],
            targetPreset: TARGET_PRESET,
            statePath,
            defaultEnabled: false,
            agents: tracked.size,
          })
        }

        let payload
        try {
          payload = await request.json()
        } catch {
          return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。', enabled }, 400)
        }
        if (typeof payload?.enabled !== 'boolean') {
          return jsonResponse(request, { ok: false, error: 'enabled 必须是布尔值。', enabled }, 400)
        }

        const previous = enabled
        try {
          saveState(statePath, payload.enabled)
        } catch (error) {
          /* 落盘失败：状态不动，如实回报，不返回虚假成功 */
          return jsonResponse(request, {
            ok: false,
            error: `保存失败：${(error && error.message) || String(error)}`,
            enabled: previous,
          }, 500)
        }

        enabled = payload.enabled
        let failed = 0
        for (const [agent, entry] of tracked) {
          try {
            if (enabled) disengage(entry)
            else engage(entry, agent)
          } catch {
            failed += 1
          }
        }
        return jsonResponse(request, { ok: true, enabled, agents: tracked.size, failed })
      },
    }),
    'fish-engineering-tools-gate: state endpoint'
  )
}

export default { name, inject, apply }
