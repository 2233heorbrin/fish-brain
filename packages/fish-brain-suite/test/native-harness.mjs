import { createRequire } from 'node:module'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchAgentLoop } from '../tools/agent-loop-release.mjs'
import { BrainLifecycle } from '../lib/lifecycle.js'
import { nativeModules } from '../lib/native.js'
import { installAdmissionHooks } from '../lib/control.js'

export const anchor = process.env.DSH_TEST_ANCHOR || 'C:/Users/ACER/AppData/Roaming/DSH/data/versions/0.2.1-rc.5/node_modules/@deepseek-ai/dsh-web-app/package.json'
export const req = createRequire(anchor)
export const mod = name => req('@deepseek-ai/' + name)
const { Context } = mod('cordis')

export async function patchedLoop() {
  const source = patchAgentLoop((await readFile(req.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8')).replaceAll('\r\n', '\n'))
  const resolved = source.replace(/from "((?!node:)[^\"]+)"/g, (_, id) => `from "${pathToFileURL(req.resolve(id)).href}"`)
  return (await import('data:text/javascript;base64,' + Buffer.from(resolved + '\n//# sourceURL=fish-brain-native-agent-loop.fixture.js').toString('base64'))).default
}

export async function runtime(fishPlugins = [], standardPlugins = []) {
  const directory = await mkdtemp(join(tmpdir(), 'fish-brain-lifecycle-'))
  const ctx = new Context().extend({ baseUrl: pathToFileURL(anchor).href })
  const logs = []
  ctx.logger.exporter({ levels: { default: 3 }, export: msg => logs.push(msg) })
  ctx.provide('profileContext', { installAnchor: anchor, dir: directory })
  const native = nativeModules(ctx)
  const fibers = []
  for (const [name, config] of [
    ['cordis-plugin-loader', {}], ['dsh-session-projection', {}], ['dsh-session', {}],
    ['dsh-agent', {}], ['dsh-llm', {}], ['dsh-system-prompt', {}], ['dsh-tools', {}],
    ['dsh-agent-preset-registry', { default: 'standard' }], ['dsh-fs-local', {}], ['dsh-working-directory', {}],
    ['dsh-token-meter', {}], ['dsh-commands', {}], ['dsh-user-questions', {}],
  ]) {
    const value = mod(name)
    const fiber = ctx.plugin(value.default || value, config)
    await fiber.await()
    if (fiber.state !== 2) throw new Error('fixture service unavailable: ' + name + ': ' + Object.keys(fiber.inject).filter(k => !fiber.ctx.get(k)))
    fibers.push(fiber)
  }
  ctx.loader.builtins.group = mod('cordis-plugin-group').default
  const loopFiber = ctx.plugin(await patchedLoop(), {})
  await loopFiber.await()
  fibers.push(loopFiber)
  const subagent = ctx.plugin(mod('dsh-subagent').default, { maxDepth: 2 })
  await subagent.await()
  if (subagent.state !== 2) throw new Error('subagent missing ' + Object.keys(subagent.inject).filter(k => !subagent.ctx.get(k)))
  fibers.push(subagent)
  const spawnProvider = ctx.plugin(mod('dsh-subagent-spawn-in-process'))
  await spawnProvider.await()
  fibers.push(spawnProvider)
  const lifecycle = new BrainLifecycle(ctx, { fishPlugins, epochPath: join(directory, 'epoch.json') }, native)
  const hooks = installAdmissionHooks(ctx, lifecycle)
  const standardOff = await ctx.agentPresets.register({ id: 'standard', plugins: standardPlugins })
  const create = (id, preset, options = {}) => ctx.agentLoop.createAgent(ctx, {
    sessionId: id, agentOptions: {}, ...options,
    setup: async (child, agent) => {
      await ctx.agentPresets.mount(child, preset)
      return await options.setup?.(child, agent)
    },
  })
  const assembly = agent => agent.ctx.systemPrompt.assemble(mod('dsh-agent').assembleContextFor(agent))
  const cleanup = async () => {
    await lifecycle.shutdown()
    await standardOff()
    for (const fiber of fibers.reverse()) { await fiber.dispose(); await fiber.await() }
  }
  return { ctx, logs, lifecycle, create, assembly, cleanup, directory, native, unhook: () => hooks.forEach(fn => fn()) }
}
