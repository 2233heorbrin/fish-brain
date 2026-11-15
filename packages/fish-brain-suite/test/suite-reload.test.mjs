import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const anchor = process.env.FISH_DSH_TEST_ANCHOR || process.env.DSH_TEST_ANCHOR
if (!anchor) throw new Error('Set FISH_DSH_TEST_ANCHOR to an isolated rc.5 installation anchor')
const req = createRequire(anchor), { Context } = req('@deepseek-ai/cordis')
const { EntryTree } = req('@deepseek-ai/cordis-plugin-loader')
const suiteURL = process.env.FISH_TEST_INSTALL_ROOT
  ? pathToFileURL(join(process.env.FISH_TEST_INSTALL_ROOT, 'node_modules/fish-brain/packages/fish-brain-suite/lib/index.js'))
  : new URL('../lib/index.js', import.meta.url)
const Suite = (await import(suiteURL)).default
const INIT = Symbol.for('cordis.init')
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'suite-reload-'))
  const ctx = new Context().extend({ baseUrl: pathToFileURL(anchor).href })
  const logs = [], events = [], active = new Set(), all = new Set()
  ctx.logger.exporter({ levels: { default: 3 }, export: m => logs.push(...m.args.map(String)) })
  const loader = ctx.plugin(req('@deepseek-ai/cordis-plugin-loader').default, {}); await loader.await()
  ctx.loader.builtins.group = req('@deepseek-ai/cordis-plugin-group').default
  const lifecycle = { ctx, mode: 'disabled', entries: new Map(),
    async enable() { assert.equal(this.mode, 'disabled'); this.mode = 'enabled'; return async () => {
      this.mode = 'switching'; events.push('disable'); lifecycle.disableEntered?.resolve(); await lifecycle.holdDisable?.promise
    } },
    finishDisabled() { this.mode = 'disabled' }, fault(error) { this.mode = 'fault'; events.push('fault:' + error.message) },
  }
  ctx.provide('fishBrainLifecycle', lifecycle)
  let tree
  const owner = ctx.plugin(Object.assign(child => { tree = new EntryTree(child) }, { inject: ['loader'] })); await owner.await()
  tree.write = () => events.push('write')
  const nativeImport = tree.import.bind(tree), modules = new Map()
  tree.import = async (...args) => args[0] === 'suite' ? { default: Suite }
    : modules.has(args[0]) ? { default: modules.get(args[0]) } : nativeImport(...args)
  for (const id of ['a', 'b', 'c']) modules.set(id, class Child {
    constructor(ctx, config) { this.ctx = ctx; this.config = config }
    async *[INIT]() {
      if (this.config?.failStart) throw new Error('child-start:' + id)
      const fiber = this.ctx.fiber; all.add(fiber); active.add(fiber); events.push('start:' + id)
      yield async () => { active.delete(fiber); events.push('stop:' + id); if (this.config?.failRelease) throw new Error('child-release:' + id) }
      if (lifecycle.holdChild === id) { lifecycle.childEntered.resolve(); await lifecycle.childGate.promise }
    }
  })
  const rows = () => ['a', 'b', 'c'].map(id => ({ id, name: id, config: { nested: { values: [1, { kept: true }] } } }))
  const options = id => ({ id, name: 'suite', config: rows() })
  const mount = async row => { await tree.root.update([...tree.root.data, row]); const fiber = tree.store[row.id].fiber; await fiber.await(); return fiber }
  const assertOwned = id => {
    const suite = tree.store[id].fiber, group = tree.store[id].subgroup
    assert.equal(suite.state, 2)
    for (const child of ['a', 'b', 'c']) {
      const entry = tree.store[child]
      assert.equal(entry.parent, group); assert.equal(entry.fiber.parent.fiber, suite)
      assert.equal(entry.fiber.state, 2); assert.notEqual(entry.fiber.uid, null)
    }
    assert.equal(active.size, 3)
    for (const fiber of active) assert.equal(fiber.parent.fiber, suite)
  }
  t.after(async () => {
    lifecycle.holdDisable?.resolve(); lifecycle.childGate?.resolve()
    for (const entry of [...tree.entries()]) entry.fiber?.dispose()
    await tree.await(); tree.root.stop()
    await owner.dispose(); await owner.await(); await loader.dispose(); await loader.await()
    assert.equal(active.size, 0, 'no old-parent active Fiber remains')
  })
  return { ctx, root, tree, lifecycle, logs, events, active, all, rows, options, mount, assertOwned, modules }
}

test('same Suite restart preserves nested declarations and restores active owned children', async t => {
  const r = await fixture(t), row = r.options('one'), original = structuredClone(row)
  const fiber = await r.mount(row)
  r.tree.store.a.options.config.nested.values[1].kept = false
  await fiber.restart(); r.assertOwned('one')
  assert.deepEqual(row, original)
  assert.equal(r.tree.store.a.options.config.nested.values[1].kept, true)
  assert.deepEqual(r.logs, [])
})

test('successor joins an unloading Suite before same-ID creation; old stop cannot affect it', async t => {
  const r = await fixture(t), old = await r.mount(r.options('old'))
  r.lifecycle.holdDisable = defer(); r.lifecycle.disableEntered = defer()
  r.lifecycle.holdChild = 'a'; r.lifecycle.childEntered = defer(); r.lifecycle.childGate = defer()
  const replacement = r.tree.root.update([r.options('new')])
  await r.lifecycle.disableEntered.promise
  assert(!r.events.slice(r.events.indexOf('disable')).includes('start:a'), 'successor waits for release')
  r.lifecycle.holdDisable.resolve(); await old.await()
  await r.lifecycle.childEntered.promise
  const entries = ['a', 'b', 'c'].map(id => r.tree.store[id])
  old.entry.subgroup.stop()
  assert.deepEqual(['a', 'b', 'c'].map(id => r.tree.store[id]), entries)
  r.lifecycle.childGate.resolve(); await replacement; await r.tree.await()
  await r.tree.store.new.fiber.await(); r.assertOwned('new')
  assert.deepEqual(r.logs, [])
})

test('an actually active same-ID owner fails explicitly without disturbing its lease or children', async t => {
  const r = await fixture(t); await r.mount(r.options('active'))
  await assert.rejects(r.mount(r.options('conflict')), /active entry conflict/)
  r.assertOwned('active'); assert.equal(r.lifecycle.mode, 'enabled')
})

test('legal disabled values are preserved; a required disabled child fails truthfully', async t => {
  const r = await fixture(t), row = r.options('disabled'); row.config[2].disabled = true
  const original = structuredClone(row)
  await assert.rejects(r.mount(row), /required child disabled: c/)
  assert.deepEqual(row, original)
  assert(!r.events.includes('start:c'))
})

test('a false native disabled expression remains an expression and allows activation', async t => {
  const r = await fixture(t), row = r.options('expression')
  row.config[0].disabled = { __jsExpr: 'false' }
  const original = structuredClone(row)
  const fiber = await r.mount(row); await fiber.restart(); r.assertOwned('expression')
  assert.deepEqual(row, original)
})

test('a pending injected dependency is reported instead of marking the Suite active', async t => {
  const r = await fixture(t)
  r.modules.get('a').inject = ['suiteTestMissingService']
  await assert.rejects(r.mount(r.options('pending')), /waiting for suiteTestMissingService/)
  assert.notEqual(r.lifecycle.mode, 'enabled')
})

test('real native import failure remains observable and never enables the Suite', async t => {
  const r = await fixture(t), row = r.options('missing')
  row.config[0].name = pathToFileURL(join(r.root, 'absent.mjs')).href
  await assert.rejects(r.mount(row), /child failed to start: a/)
  assert(r.logs.some(s => /Cannot find module/.test(s)))
  assert.notEqual(r.lifecycle.mode, 'enabled')
})

test('child startup errors retain their cause', async t => {
  const r = await fixture(t), row = r.options('bad-start'); row.config[0].config.failStart = true
  await assert.rejects(r.mount(row), /child-start:a/)
  assert(r.logs.some(s => s.includes('child-start:a')))
})

test('child disposer errors remain a lifecycle fault and propagate to a waiting successor', async t => {
  const r = await fixture(t), row = r.options('bad-release'); row.config[0].config.failRelease = true
  const old = await r.mount(row)
  r.lifecycle.holdDisable = defer(); r.lifecycle.disableEntered = defer()
  const replacement = r.tree.root.update([r.options('next')])
  await r.lifecycle.disableEntered.promise; r.lifecycle.holdDisable.resolve()
  // Cordis contains disposer exceptions; Suite exposes them through lifecycle
  // fault/logger and the exact release result consumed by its successor.
  await old.await()
  assert(r.logs.some(message => message.includes('child-release:a')))
  await replacement; await r.tree.await()
  await assert.rejects(r.tree.store.next.fiber.await(), /child-release:a/)
  assert.equal(r.lifecycle.mode, 'fault')
  assert.equal(r.active.size, 0)
})
