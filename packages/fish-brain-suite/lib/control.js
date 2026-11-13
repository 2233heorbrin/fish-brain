import { readFileSync } from 'node:fs'
import { BrainLifecycle } from './lifecycle.js'
import { nativeModules } from './native.js'

export const name = 'fish-brain-lifecycle'
export const inject = ['loader', 'agentPresets', 'agents', 'agentLoop', 'subagents', 'connection', 'sessionProjections']

export function installAdmissionHooks(ctx, lifecycle) {
  return [
    ctx.on('agent/created', ({ agent }) => lifecycle.attach(agent)),
    ctx.on('agent/disposed', ({ agent }) => { lifecycle.entries.delete(agent) }),
    // Session publication forbids nested append. Selection only observes the
    // native composition; admission and any binding write happen at pre-step.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      const agent = ctx.agents.get(session.id)
      if (agent) lifecycle.attach(agent)
    }),
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      await lifecycle.mayRun(agent, { signal })
      return next()
    }, { prepend: true }),
  ]
}

/** 把 fish-plugins.json 里的 <FISH_BRAIN_ROOT> / <PROFILE_DIR> 换成实际路径。 */
function substitutePlaceholders(value, vars) {
  if (typeof value === 'string') {
    return value.split('<FISH_BRAIN_ROOT>').join(vars.brainRoot || '')
      .split('<PROFILE_DIR>').join(vars.profileDir || '')
  }
  if (Array.isArray(value)) return value.map(v => substitutePlaceholders(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitutePlaceholders(v, vars)
    return out
  }
  return value
}

export async function apply(ctx, config) {
  const native = nativeModules(ctx)
  if (typeof ctx.agentLoop.releaseExact !== 'function') throw new Error('fish-brain requires native AgentHandle releaseExact support')
  const rawFishPlugins = JSON.parse(readFileSync(config.fishPluginsPath || new URL('../fish-plugins.json', import.meta.url), 'utf8'))
  const fishPlugins = substitutePlaceholders(rawFishPlugins, {
    brainRoot: config.brainRoot || process.env.FISH_BRAIN_ROOT || '',
    profileDir: config.profileDir || process.env.FISH_PROFILE_DIR || '',
  })
  const lifecycle = new BrainLifecycle(ctx, { ...config, fishPlugins }, native)
  ctx.provide('fishBrainLifecycle', lifecycle)
  installAdmissionHooks(ctx, lifecycle)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/fish-brain-lifecycle/state', methods: ['GET', 'HEAD'],
    fetch: request => new Response(request.method === 'HEAD' ? null : JSON.stringify(lifecycle.state()), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    }),
  }))
  ctx.effect(() => async () => { await lifecycle.enqueue(() => lifecycle.shutdown()) })
  // Avoid awaiting the Host's own Loader during activation. After it settles, absence of a suite means off.
  let cancelled = false
  ctx.effect(() => () => { cancelled = true })
  setImmediate(async () => {
    try {
      await ctx.loader.await()
      if (!cancelled && lifecycle.mode === 'starting') await lifecycle.enqueue(() => lifecycle.switchTo('disabled'))
    } catch (error) { lifecycle.mode = 'fault'; lifecycle.failures.push(String(error.message)); ctx.logger.error(error) }
  })
}

export default { name, inject, apply }
