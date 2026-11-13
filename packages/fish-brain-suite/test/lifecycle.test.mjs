import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, cp, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runtime, mod } from './native-harness.mjs'
import { observeRelease } from '../lib/native.js'
import * as engGate from '../../fish-engineering-tools-gate/index.js'
import * as collabGate from '../../fish-agent-collab-gate/index.js'
import * as control from '../lib/control.js'

const fixture = new URL('./fixtures.mjs', import.meta.url).href
const row = (id, config) => ({ id, name: fixture, config })
const fish = [row('self', { context: 'agent:self', tool: 'fish_memory_search', listener: true, timer: true }), row('mood', { context: 'agent:mood' }), row('thinking', { context: 'agent:thinking', tool: 'worker' })]
const standard = [row('engineering', { tool: 'native_engineering', context: 'native:engineering' }), row('independent', { tool: 'independent_plugin' })]
const names = assembly => assembly.tools.map(t => t.name).sort()
const contexts = assembly => assembly.contexts.map(c => c.name)

test('native preset generations unload exact fish Agent, contexts, tools, listeners and timers; standard survives; off/on has no duplicates', async () => {
  globalThis.__fishFixtureCalls = 0; globalThis.__fishFixtureTicks = 0
  const r = await runtime(fish, standard)
  try {
    const disable = await r.lifecycle.enable()
    const a = (await r.create('fish-enabled', 'fish')).agent
    await r.lifecycle.mayRun(a)
    const s = (await r.create('standard-independent', 'standard')).agent
    assert.deepEqual(names(await r.assembly(a)), ['fish_memory_search', 'worker'])
    assert(contexts(await r.assembly(a)).includes('agent:self'))
    assert(!contexts(await r.assembly(s)).some(name => /^agent:(self|mood|thinking)$/.test(name)))
    const oldLog = a.session.snapshotEvents()
    await disable()
    assert.equal(r.lifecycle.state().fullyDisabled, false, 'suite children not yet acknowledged')
    r.lifecycle.finishDisabled()
    assert.equal(r.ctx.agents.get(a.id), undefined)
    assert.equal(r.ctx.agents.get(s.id), s)
    assert.deepEqual(a.session.snapshotEvents().filter(e => !['turn/cancel', 'inbox/splice'].includes(e.type)), oldLog.filter(e => !['turn/cancel', 'inbox/splice'].includes(e.type)))
    const ticks = globalThis.__fishFixtureTicks
    r.ctx.emit('fish-brain-fixture/ping')
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(globalThis.__fishFixtureTicks, ticks)
    assert.equal(globalThis.__fishFixtureCalls, 0)
    assert.equal(r.lifecycle.state().fullyDisabled, true)
    const nativeFish = (await r.create('fish-disabled-native', 'fish')).agent
    assert.deepEqual(names(await r.assembly(nativeFish)), ['independent_plugin', 'native_engineering'])
    assert(!contexts(await r.assembly(nativeFish)).some(name => /^agent:(self|mood|thinking)$/.test(name)))
    const seeded = (await r.create('seeded-old', 'fish', { seed: oldLog })).agent
    await assert.rejects(r.lifecycle.mayRun(seeded), /NEW_CONVERSATION_REQUIRED/)
    const disabledEpoch = r.lifecycle.epoch
    await r.lifecycle.enable()
    assert.notEqual(r.lifecycle.epoch, disabledEpoch)
    assert.equal(r.ctx.agents.get(nativeFish.id), undefined)
    const again = (await r.create('fish-enabled-again', 'fish')).agent
    assert.deepEqual(names(await r.assembly(again)), ['fish_memory_search', 'worker'])
    assert.equal(contexts(await r.assembly(again)).filter(x => x === 'agent:self').length, 1)
    assert.equal(r.ctx.agents.get(s.id), s)
  } finally { await r.cleanup() }
})

test('explicit stale bindings reject at execution, not publication; cold history stays readable', async () => {
  const r = await runtime(fish, standard)
  try {
    const disable = await r.lifecycle.enable()
    const a = (await r.create('old-history', 'fish')).agent
    await r.lifecycle.mayRun(a)
    const epoch = r.lifecycle.epoch
    const stored = a.session.snapshotEvents()
    await disable(); r.lifecycle.finishDisabled()
    assert.notEqual(epoch, r.lifecycle.epoch)
    assert(stored.some(e => e.type === 'plugin:fish-brain/binding'))
    const current = (await r.create('new-history', 'fish', { seed: stored })).agent
    await assert.rejects(r.lifecycle.mayRun(current), /NEW_CONVERSATION_REQUIRED/)
    assert.equal(r.lifecycle.mode, 'disabled')
    assert.equal(stored.filter(e => e.type === 'plugin:fish-brain/binding').length, 1)
  } finally { await r.cleanup() }
})

test('contained native disposer errors set fault and never claim fully disabled', async () => {
  const r = await runtime([row('failure', { context: 'agent:self', failRelease: true })], standard)
  await r.lifecycle.enable()
  await r.create('failure-fish', 'fish')
  await assert.rejects(r.lifecycle.switchTo('disabled'), /FIXTURE_RELEASE_FAILURE/)
  assert.equal(r.lifecycle.state().mode, 'fault')
  assert.equal(r.lifecycle.state().fullyDisabled, false)
  await r.cleanup()
})

test('AgentLoop exact disposer rejects lookalike identity and leaves other roots resident', async () => {
  const r = await runtime([], standard)
  try {
    await r.lifecycle.switchTo('disabled')
    const a = (await r.create('exact-one', 'standard')).agent
    const b = (await r.create('exact-two', 'standard')).agent
    await assert.rejects(r.ctx.agentLoop.releaseExact({ id: a.id }), /exact live agent/)
    await r.ctx.agentLoop.releaseExact(a)
    assert.equal(r.ctx.agents.get(a.id), undefined)
    assert.equal(r.ctx.sessions.get(a.id), undefined)
    assert.equal(r.ctx.agents.get(b.id), b)
  } finally { await r.cleanup() }
})

test('release observer ignores unrelated plugin errors and reports the owned exact fiber', async () => {
  const r = await runtime([], standard)
  try {
    const other = r.ctx.plugin(ctx => { ctx.effect(() => () => { throw new Error('unrelated') }) })
    const owned = r.ctx.plugin(ctx => { ctx.effect(() => () => { throw new Error('owned failure') }) })
    await other.await(); await owned.await()
    await observeRelease(r.ctx, [owned], async () => { await other.dispose(); await other.await() })
    await assert.rejects(observeRelease(r.ctx, [owned], async () => { await owned.dispose(); await owned.await() }), /owned failure/)
    await other.dispose(); await owned.dispose()
  } finally { await r.cleanup() }
})

test('native spawn forest and active fish turn stop; independent standard and native team stay running', async () => {
  const r = await runtime(fish, standard)
  const activations = []
  try {
    // Hold the real native driver before its model boundary. No provider or model is called.
    r.ctx.on('agent/pre-step', ({ signal }) => new Promise(resolve => {
      if (signal.aborted) return resolve({ kind: 'reject' })
      signal.addEventListener('abort', () => resolve({ kind: 'reject' }), { once: true })
    }))
    await r.lifecycle.enable()
    const a = (await r.create('fish-active-parent', 'fish')).agent
    const s = (await r.create('standard-active-parent', 'standard')).agent
    const spawn = async (id, parent) => {
      const activation = await r.ctx.subagents.startActivation({ provider: 'spawn', label: 'isolated cancel check', childId: id,
        request: { parent, agentPreset: 'standard', maxDepth: 2, prompt: [{ type: 'text', text: 'fixture task only' }] },
        signal: new AbortController().signal, delivery: 'caller' })
      activations.push(activation)
      return activation
    }
    const one = await spawn('fish-worker-one', a)
    const two = await spawn('fish-worker-two', a)
    const independent = await spawn('native-independent-team', s)
    const active = a.runMaintenance(signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })))
    await new Promise(resolve => setImmediate(resolve))
    await r.lifecycle.switchTo('disabled')
    await active
    assert.equal(r.ctx.agents.get(a.id), undefined)
    assert.equal(r.ctx.agents.get(one.childId), undefined)
    assert.equal(r.ctx.agents.get(two.childId), undefined)
    assert.equal(r.ctx.agents.get(s.id), s)
    assert(r.ctx.agents.get(independent.childId))
    assert.equal(r.ctx.agentPresets.composedPreset(r.ctx.agents.get(independent.childId).ctx), 'standard')
  } finally {
    await Promise.all(activations.map(a => a.dispose()))
    await r.cleanup()
  }
})

test('actual fish adapters assemble only into fish; off restores native tools and removes all fish Prompt providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fish-brain-adapters-'))
  const plugins = JSON.parse(await readFile(new URL('../fish-plugins.json', import.meta.url), 'utf8'))
  await writeFile(join(directory, 'self.md'), 'Isolated fish SELF fixture')
  await writeFile(join(directory, 'personality.json'), '{}')
  for (const entry of plugins) {
    if (entry.id === 'dsh-memory-shipei') Object.assign(entry.config, { selfPath: join(directory, 'self.md'), statePath: join(directory, 'personality.json') })
    if (['dsh-agent-mood', 'dsh-agent-thinking'].includes(entry.id)) entry.config.stateDir = join(directory, entry.id)
    if (entry.id === 'fish-memory-readonly-tools') {
      await cp(entry.config.dataDir, join(directory, 'documents'), { recursive: true })
      entry.config.dataDir = join(directory, 'documents')
    }
  }
  const r = await runtime(plugins, standard)
  try {
    // A pre-existing independent Agent catches the thinking adapter's eager enumeration leak.
    const s = (await r.create('standard-before-fish-mount', 'standard')).agent
    const disable = await r.lifecycle.enable()
    const a = (await r.create('actual-adapters-fish', 'fish')).agent
    const prompt = await r.assembly(a)
    for (const key of ['agent:self', 'agent:mood', 'agent:thinking']) assert.equal(contexts(prompt).filter(c => c === key).length, 1)
    assert.deepEqual(names(prompt), ['fish_memory_search', 'worker'])
    assert(!JSON.stringify(await r.assembly(s)).includes('agent:thinking'))
    assert(!JSON.stringify(await r.assembly(s)).includes('agent:self'))
    await disable(); r.lifecycle.finishDisabled()
    const off = (await r.create('actual-adapters-off', 'fish')).agent
    assert.deepEqual(names(await r.assembly(off)), ['independent_plugin', 'native_engineering'])
    assert(!JSON.stringify(await r.assembly(off)).includes('agent:self'))
    assert.equal(r.ctx.agents.get(s.id), s)
  } finally { await r.cleanup() }
})

test('both self-owned gates disappear, preserve bytes and restore settings; other guards remain', async () => {
  const r = await runtime([], [row('native-write', { tool: 'write' }), row('native-delegate', { tool: 'subagent' })])
  const routes = new Map()
  r.ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  const paths = ['engineering.json', 'collab.json'].map(name => join(r.directory, name))
  await Promise.all(paths.map(path => writeFile(path, '{"enabled":false,"preserved":"original"}\n')))
  try {
    await r.lifecycle.switchTo('disabled')
    const a = (await r.create('standard-gate-fixture', 'standard')).agent
    const other = a.ctx.tools.guard(exec => exec.name === 'write' ? 'OTHER_PLUGIN_GUARD' : undefined)
    const call = name => r.ctx.tools.execute({ callId: 'fixture-' + name, name, arguments: {}, agent: a, signal: new AbortController().signal })
    for (let cycle = 0; cycle < 2; cycle++) {
      const eng = r.ctx.plugin(engGate, { statePath: paths[0] })
      const collab = r.ctx.plugin(collabGate, { statePath: paths[1] })
      await eng.await(); await collab.await()
      assert(names(await r.assembly(a)).includes('write'), 'engineering switch must preserve native tools')
      assert(JSON.stringify(await call('write')).includes('OTHER_PLUGIN_GUARD'))
      assert(JSON.stringify(await call('subagent')).includes('已拒绝'), 'independent collaboration switch remains effective')
      assert.equal(routes.size, 2)
      await observeRelease(r.ctx, [eng, collab], async () => {
        await eng.dispose(); await eng.await(); await collab.dispose(); await collab.await()
      })
      assert.equal(routes.size, 0)
      assert(names(await r.assembly(a)).includes('write'))
      assert(JSON.stringify(await call('write')).includes('OTHER_PLUGIN_GUARD'))
      assert(!JSON.stringify(await call('subagent')).includes('已拒绝'))
      for (const path of paths) assert.equal(await readFile(path, 'utf8'), '{"enabled":false,"preserved":"original"}\n')
    }
    other()
  } finally { await r.cleanup() }
})

test('actual native Loader Group owns suite children and reports child release failure', async () => {
  const r = await runtime(fish, standard)
  r.ctx.provide('fishBrainLifecycle', r.lifecycle)
  const { EntryTree } = mod('cordis-plugin-loader')
  const tree = new EntryTree(r.ctx)
  try {
    await tree.root.update([{ id: 'suite', name: new URL('../lib/index.js', import.meta.url).href,
      config: [row('ui-fixture', { listener: true })] }])
    const fiber = tree.store.suite.fiber
    await fiber.await()
    assert.equal(r.lifecycle.mode, 'enabled')
    await r.create('suite-fish', 'fish')
    await fiber.dispose(); await fiber.await()
    assert.equal(r.lifecycle.state().fullyDisabled, true)
    assert.equal(r.ctx.agents.get('suite-fish'), undefined)
    await tree.root.update([{ id: 'suite-failing', name: new URL('../lib/index.js', import.meta.url).href,
      config: [row('failed-ui', { failRelease: true })] }])
    const bad = tree.store['suite-failing'].fiber
    await bad.await()
    await bad.dispose(); await bad.await()
    assert.equal(r.lifecycle.state().fullyDisabled, false)
    assert.equal(r.lifecycle.state().mode, 'fault')
  } finally { tree.root.stop(); await r.cleanup() }
})

test('production controller boots a disabled fish card, exposes read-only truthful status and follows native suite lifecycle', async () => {
  const r = await runtime([], standard)
  r.unhook()
  const routes = new Map()
  r.ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  const pluginsFile = join(r.directory, 'fish.json')
  await writeFile(pluginsFile, JSON.stringify(fish))
  const fiber = r.ctx.plugin(control, { fishPluginsPath: pluginsFile, epochPath: join(r.directory, 'control-epoch.json') })
  try {
    await fiber.await()
    await new Promise(resolve => setImmediate(resolve))
    const life = r.ctx.get('fishBrainLifecycle')
    await life.chain
    assert.equal(life.state().fullyDisabled, true)
    assert.match((await r.ctx.agentPresets.list()).find(item => item.id === 'fish').name, /鱼脑已关闭/)
    assert.equal(r.ctx.agentPresets.defaultId, 'standard')
    const status = routes.get('/api/fish-brain-lifecycle/state')
    assert.deepEqual(status.methods, ['GET', 'HEAD'])
    assert.equal((await (await status.fetch(new Request('http://fixture/api/fish-brain-lifecycle/state'))).json()).mode, 'disabled')
    const off = (await r.create('controller-disabled-fish', 'fish')).agent
    assert.deepEqual(names(await r.assembly(off)), ['independent_plugin', 'native_engineering'])
    const disable = await life.enable()
    assert.equal(r.ctx.agents.get(off.id), undefined)
    const on = (await r.create('controller-enabled-fish', 'fish')).agent
    assert.deepEqual(names(await r.assembly(on)), ['fish_memory_search', 'worker'])
    await disable(); life.finishDisabled()
    assert.equal(r.ctx.agents.get(on.id), undefined)
    assert.equal(life.state().fullyDisabled, true)
  } finally { await fiber.dispose(); await fiber.await(); await r.cleanup() }
})

test('actual fish-brain-ui routes are owned by the suite and all disappear on native unload', async () => {
  const r = await runtime(fish, standard)
  const routes = new Map()
  r.ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  r.ctx.provide('fishBrainLifecycle', r.lifecycle)
  const { EntryTree } = mod('cordis-plugin-loader')
  const tree = new EntryTree(r.ctx)
  try {
    await tree.root.update([{ id: 'ui-suite', name: new URL('../lib/index.js', import.meta.url).href, config: [{
      id: 'real-ui', name: new URL('../../fish-brain-ui/lib/index.js', import.meta.url).href,
      config: { freezeMatrixPath: 'D:/deepseek框架/鱼的大脑/总说明/全脑V1冻结矩阵.json', brainRoot: 'D:/deepseek框架/鱼的大脑' },
    }] }])
    const fiber = tree.store['ui-suite'].fiber
    await fiber.await()
    assert(routes.has('/api/fish-brain/ui'))
    assert(routes.has('/api/fish-brain/events'))
    assert([...routes.values()].every(route => JSON.stringify(route.methods) === '["GET","HEAD"]'))
    const request = new Request('http://fixture/api/fish-brain/ui')
    const response = await routes.get('/api/fish-brain/ui').fetch(request)
    assert.equal(response.status, 200)
    assert((await response.text()).includes('<html'))
    await fiber.dispose(); await fiber.await()
    assert.equal(routes.size, 0)
    assert.equal(r.lifecycle.state().fullyDisabled, true)
  } finally { tree.root.stop(); await r.cleanup() }
})
