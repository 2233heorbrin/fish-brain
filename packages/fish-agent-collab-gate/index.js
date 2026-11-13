/* fish-agent-collab-gate · Host half
 *
 * 「多 Agent 协作」总闸：关闭时用 ctx.tools.guard() 拒绝派发类工具的执行准入。
 * 这是执行检查（真实准入），不是提示词约束：无论并行还是逐个串行调用，
 * 都必须在守卫处通过，因此无法靠「一次派一个」绕过。
 *
 * 拦截清单（项目实际存在的全部派发入口）：
 *   - subagent        standard 的常规委派
 *   - subagent_fork   standard 的分叉委派
 *   - worker          fish 的固定 standard Worker 通道
 *
 * 不碰任何其他工具：规划、任务清单、bash / fs / search 等普通工具完全不受影响；
 * 不改人格、记忆、权限与 Agent 隔离边界。
 * 已运行中的子 Agent 不会被终止，只会在下一次尝试派发时收到拒绝原因。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'fish-agent-collab-gate'
export const inject = ['tools', 'connection']

/** 派发类工具：关闭时一律拒绝执行准入（覆盖并行、串行与单个 Worker）。 */
const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork', 'worker'])

const DEFAULT_STATE_PATH = process.env.FISH_COLLAB_STATE
  || (process.env.FISH_PROFILE_DIR ? process.env.FISH_PROFILE_DIR.replace(/[\\/]+$/, '') + '/agent-collab.json' : 'agent-collab.json')

const DENY_REASON =
  '已拒绝：当前 profile 的「允许创建子 Agent」为关闭状态，不能新建任何子 Agent（包括单个 Worker、并行协作与串行委派）。'
  + '请由当前 Agent 直接使用自身的规划、任务清单和普通工具完成任务，不要重复尝试创建子 Agent。'
  + '如果任务确实缺少必需能力（例如鱼缺少工程执行工具），请如实向用户说明限制，并建议用户把当前会话或预设切换到 standard；不要自行切换，也不要索取额外权限。'

function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || DEFAULT_STATE_PATH
}

function loadState(statePath) {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    return raw?.enabled === true
  } catch {
    /* 文件缺失或损坏 = 默认关闭：宁可不派发，也不越权放开 */
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
  /* 同步读一次作为初值；守卫是同步函数，不能在里面做 IO。 */
  let enabled = loadState(statePath)

  /* 执行准入：关闭时拒绝派发工具。已运行中的子 Agent 不会被终止，
     它们只会在下一次尝试派发时收到这条拒绝原因。 */
  ctx.effect(
    () => ctx.tools.guard((exec) => {
      if (enabled) return undefined
      const toolName = typeof exec?.name === 'string' ? exec.name : ''
      return DISPATCH_TOOLS.has(toolName) ? DENY_REASON : undefined
    }),
    'fish-agent-collab-gate: dispatch admission guard'
  )

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/fish-collab-gate/state',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const isRead = request.method === 'GET' || request.method === 'HEAD'

        if (isRead) {
          return jsonResponse(request, {
            enabled,
            tools: [...DISPATCH_TOOLS],
            statePath,
            defaultEnabled: false,
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
          /* 写失败：内存状态保持原值，如实回报，绝不返回虚假成功 */
          return jsonResponse(request, {
            ok: false,
            error: `保存失败：${(error && error.message) || String(error)}`,
            enabled: previous,
          }, 500)
        }
        enabled = payload.enabled
        return jsonResponse(request, { ok: true, enabled })
      },
    }),
    'fish-agent-collab-gate: state endpoint'
  )
}

export default { name, inject, apply }
