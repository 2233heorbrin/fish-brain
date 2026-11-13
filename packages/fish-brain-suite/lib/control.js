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

export async function apply(ctx, config) {
  const native = nativeModules(ctx)
  if (typeof ctx.agentLoop.releaseExact !== 'function') throw new Error('fish-brain requires native AgentHandle releaseExact support')
  const fishPlugins = JSON.parse(readFileSync(config.fishPluginsPath || new URL('../fish-plugins.json', import.meta.url), 'utf8'))
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
