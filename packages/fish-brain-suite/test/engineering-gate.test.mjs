import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runtime } from './native-harness.mjs'
import * as gate from '../../fish-engineering-tools-gate/index.js'

test('engineering switch limits only fish across native preset selection and restores tools on enable/unload', async () => {
  const fixture = new URL('./fixtures.mjs', import.meta.url).href
  const plugins = ['write', 'worker', 'independent_plugin'].map(tool => ({ name: fixture, config: { tool } }))
  const r = await runtime(plugins, plugins)
  const routes = new Map()
  r.ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  const statePath = join(r.directory, 'engineering-fish-only.json')
  await writeFile(statePath, '{"enabled":false}\n')
  let fiber
  try {
    await r.lifecycle.enable()
    const standard = (await r.create('engineering-standard', 'standard')).agent
    const selected = (await r.create('engineering-select', 'standard')).agent
    const existingFish = (await r.create('engineering-existing-fish', 'fish')).agent
    fiber = r.ctx.plugin(gate, { statePath })
    await fiber.await()
    const names = async agent => (await r.assembly(agent)).tools.map(tool => tool.name)
    const call = (agent, name) => r.ctx.tools.execute({ callId: `check-${agent.id}-${name}`, name, arguments: {}, agent, signal: new AbortController().signal })
    assert((await names(standard)).includes('write'))
    assert(!JSON.stringify(await call(standard, 'write')).includes('已拒绝'))
    assert(!(await names(existingFish)).includes('write'))
    await r.ctx.agentPresets.select(selected, 'fish')
    assert(!(await names(selected)).includes('write'))
    assert(!(await names(selected)).includes('worker'))
    assert((await names(selected)).includes('independent_plugin'))
    assert(JSON.stringify(await call(selected, 'write')).includes('已拒绝'))
    const route = routes.get('/api/fish-eng-tools/state')
    const state = await (await route.fetch(new Request('http://fixture/api/fish-eng-tools/state'))).json()
    assert.equal(state.targetPreset, 'fish')
    const toggle = async enabled => {
      const response = await route.fetch(new Request('http://fixture/api/fish-eng-tools/state', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      }))
      assert.equal(response.status, 200)
      assert.equal((await response.json()).failed, 0)
    }
    await toggle(true)
    assert((await names(selected)).includes('write'))
    assert(!JSON.stringify(await call(selected, 'write')).includes('已拒绝'))
    await toggle(false)
    assert(!(await names(selected)).includes('write'))
    assert((await names(standard)).includes('write'))
    await r.ctx.agentPresets.select(selected, 'standard')
    assert((await names(selected)).includes('write'))
    assert(!JSON.stringify(await call(selected, 'write')).includes('已拒绝'))
    await fiber.dispose(); await fiber.await()
    assert((await names(existingFish)).includes('write'))
    assert(!JSON.stringify(await call(existingFish, 'write')).includes('已拒绝'))
  } finally {
    if (fiber) { await fiber.dispose(); await fiber.await() }
    await r.cleanup()
  }
})
