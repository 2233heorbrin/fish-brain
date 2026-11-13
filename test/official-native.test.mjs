import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const anchor = process.env.FISH_DSH_TEST_ANCHOR, install = process.env.FISH_TEST_INSTALL_ROOT
if (!anchor || !install) throw new Error('Provide isolated official DSH anchor and installed tarball root')
const req = createRequire(anchor), mod = id => req('@deepseek-ai/' + id)
const packageRoot = join(install, 'node_modules/fish-brain'), load = path => import(pathToFileURL(join(packageRoot, path)))
const { Context } = mod('cordis')
const {scopeOf} = mod('dsh-scope')
const temp = mkdtempSync(join(tmpdir(), 'fish-official-native-'))

test('official native presets isolate SELF, memory, mood, thinking and fixed standard Worker', async () => {
  const ctx = new Context().extend({ baseUrl: pathToFileURL(anchor).href })
  const errors = [], fibers = [], handles = []
  ctx.logger.exporter({ levels: { default: 1 }, export: entry => { if (entry.type === 'error') errors.push(entry.args.map(String).join(' ')) } })
  ctx.provide('profileContext', { dir: temp, installAnchor: anchor })
  for (const name of ['cordis-plugin-loader', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm',
    'dsh-system-prompt', 'dsh-tools', 'dsh-agent-preset-registry', 'dsh-fs-local', 'dsh-working-directory',
    'dsh-token-meter', 'dsh-commands', 'dsh-user-questions', 'dsh-agent-loop', 'dsh-subagent', 'dsh-subagent-spawn-in-process']) {
    const value = mod(name), config = name === 'dsh-agent-preset-registry' ? { default: 'standard' } : name === 'dsh-subagent' ? { maxDepth: 1 } : {}
    const fiber = ctx.plugin(value.default || value, config); await fiber.await(); fibers.push(fiber)
    assert.equal(fiber.state, 2, name + ': ' + errors.join('; '))
  }
  ctx.loader.builtins.group = mod('cordis-plugin-group').default
  const { ProfileData } = await load('internal/profile-data.js'), data = new ProfileData(temp, 'brain')
  data.initialize({ root: temp }); const paths = data.state().paths
  const self = join(paths.人格, 'generated/SELF.compat.md'); writeFileSync(self, 'SYNTHETIC_FISH_SELF_ONLY')
  const store = join(paths.脑区运行状态, '记忆/documents-readonly/documents'), content = 'SYNTHETIC_FISH_MEMORY_ONLY'
  writeFileSync(join(store, 'active/synthetic.md'), content)
  writeFileSync(join(store, 'index.json'), JSON.stringify({ version: 1, documents: [{
    id: 'synthetic', title: 'Synthetic memory', description: '', status: 'active', filename: 'synthetic.md',
    relativePath: 'documents/active/synthetic.md', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    lastAccessedAt: '2026-01-01T00:00:00Z', revision: 1, contentHash: createHash('sha256').update(content).digest('hex'),
    sizeBytes: content.length, sourcePaths: [], sessionIds: [], memoryBodyIds: [],
  }] }))
  const plugin = (id, file, config) => ({ id, name: pathToFileURL(join(packageRoot, file)).href, config })
  const unregisterStandard = await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  const unregisterFish = await ctx.agentPresets.register({ id: 'fish', plugins: [
    plugin('self', 'packages/dsh-memory-shipei/lib/index.js', { selfPath: self, statePath: join(temp, 'self-state.json'), includeSubagents: false, doorSign: false }),
    plugin('memory', 'packages/fish-memory-readonly-tools/lib/index.js', { dataDir: join(paths.脑区运行状态, '记忆/documents-readonly') }),
    plugin('mood', 'packages/dsh-agent-mood/lib/index.js', { moodEnabled: true, stateDir: join(paths.脑区运行状态, '心情') }),
    plugin('thinking', 'packages/dsh-agent-thinking/lib/index.js', { thinkingEnabled: true, scopeOnly: true, stateDir: join(paths.脑区运行状态, '思考'), runtimeCardPath: join(paths.思考, '策略/思考运行卡.txt'), capabilityIndexPath: join(paths.思考, '能力索引.json') }),
    { id: 'worker', name: pathToFileURL(req.resolve('@deepseek-ai/dsh-tool-subagent')).href, config: { provider: 'spawn', toolName: 'worker', agentPreset: 'standard', maxDepth: 1, modelSelectionSettings: false } },
  ] })
  const unregisterOther = await ctx.agentPresets.register({ id: 'other', plugins: [] })
  try {
    const create = async (id, preset) => {
      const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: id, agentOptions: {},
        setup: async child => { await ctx.agentPresets.mount(child, preset) } }); handles.push(handle); return handle.agent
    }
    const fish = await create('synthetic-fish', 'standard'), standard = await create('synthetic-standard', 'standard'), other = await create('synthetic-other', 'other')
    await ctx.agentPresets.select(fish, 'fish')
    const assemble = agent => agent.ctx.systemPrompt.assemble(mod('dsh-agent').assembleContextFor(agent))
    const fishPrompt = JSON.stringify(await assemble(fish)); assert.match(fishPrompt, /SYNTHETIC_FISH_SELF_ONLY/)
    for (const agent of [standard, other]) {
      const prompt = JSON.stringify(await assemble(agent)); assert.doesNotMatch(prompt, /SYNTHETIC_FISH_SELF_ONLY|agent:mood|agent:thinking/)
      assert(!agent.ctx.tools.get('fish_memory_search', scopeOf(agent.ctx))); assert(!agent.ctx.tools.get('worker', scopeOf(agent.ctx)))
    }
    assert(fish.ctx.tools.get('fish_memory_search', scopeOf(fish.ctx))); assert(fish.ctx.tools.get('worker', scopeOf(fish.ctx)))
    const result = await fish.ctx.tools.get('fish_memory_search', scopeOf(fish.ctx)).execute({ query: 'SYNTHETIC_FISH_MEMORY_ONLY' })
    assert.equal(result.total, 1); assert.match(result.items[0].evidence, /SYNTHETIC_FISH_MEMORY_ONLY/)
    assert.equal(ctx.agentPresets.defaultId, 'standard')
    const routes = new Map()
    ctx.provide('connection', { fetch: { register(row) { routes.set(row.path, row); return () => routes.delete(row.path) } } })
    const gate = ctx.plugin(await load('packages/fish-agent-collab-gate/index.js'), { statePath: join(temp, 'collab.json') })
    await gate.await()
    const releaseTool = ctx.tools.register({ name: 'subagent', description: 'fixture native delegation',
      parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ native: true }) })
    const call = agent => ctx.tools.execute({ callId: 'check-' + agent.id, name: 'subagent', arguments: {}, agent, signal: new AbortController().signal })
    try {
      assert.equal((await call(standard)).isError, false)
      assert.match(JSON.stringify(await call(fish)), /已拒绝/)
      await gate.dispose(); await gate.await()
      assert.equal((await call(fish)).isError, false, 'unloading removes only our guard')
    } finally { releaseTool(); await gate.dispose(); await gate.await() }
    // Hold the actual in-process spawn before the model boundary.
    const stop = ctx.on('agent/pre-step', ({ signal }) => new Promise(resolve => {
      if (signal.aborted) return resolve({ kind: 'reject' })
      signal.addEventListener('abort', () => resolve({ kind: 'reject' }), { once: true })
    }))
    const activation = await ctx.subagents.startActivation({ provider: 'spawn', label: 'isolated worker', childId: 'clean-standard-worker',
      request: { parent: fish, agentPreset: 'standard', maxDepth: 1, prompt: [{ type: 'text', text: 'TASK_ONLY' }] },
      signal: new AbortController().signal, delivery: 'caller' })
    try {
      const worker = ctx.agents.get(activation.childId)
      assert.equal(ctx.agentPresets.composedPreset(worker.ctx), 'standard')
      assert.doesNotMatch(JSON.stringify(await assemble(worker)), /SYNTHETIC_FISH_SELF_ONLY|SYNTHETIC_FISH_MEMORY_ONLY|agent:mood|agent:thinking|fish_memory_search/)
      assert.doesNotMatch(JSON.stringify(worker.session.snapshotEvents()), /SYNTHETIC_FISH_SELF_ONLY/)
      assert(!worker.ctx.tools.get('fish_memory_search', scopeOf(worker.ctx)))
    } finally { await activation.dispose(); stop() }
    assert.equal(ctx.agentLoop.releaseExact, undefined, 'official npm host must remain unpatched')
    const installedPlugin = ctx.plugin(await load('index.js'), {})
    await installedPlugin.await()
    try {
      assert.equal(installedPlugin.state, 2, 'missing lifecycle extension must not break native DSH')
      const response = await routes.get('/api/fish-brain/data').fetch(new Request('http://local/api/fish-brain/data'))
      const state = await response.json()
      assert.equal(state.dependencies.status, 'host-blocked')
      assert.equal(state.dependencies.packages, 'ready')
      assert.equal(ctx.agents.get(standard.id), standard)
      assert.equal(ctx.agentPresets.defaultId, 'standard')
    } finally { await installedPlugin.dispose(); await installedPlugin.await() }
    assert(!routes.has('/api/fish-brain/data'))
    assert.deepEqual(errors, [])
  } finally {
    for (const handle of handles.reverse()) await handle.dispose()
    await unregisterOther(); await unregisterFish(); await unregisterStandard()
    for (const fiber of fibers.reverse()) { await fiber.dispose(); await fiber.await() }
  }
})
