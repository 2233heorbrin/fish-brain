const groupKey = Symbol.for('cordis.group')
const init = Symbol.for('cordis.init')
import { watchRelease, settleFiber } from './native.js'

export const name = 'fish-brain-suite'

export default class FishBrainSuite {
  static inject = ['loader', 'fishBrainLifecycle']
  static [groupKey] = true

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = Array.isArray(config) ? config : []
  }

  async *[init]() {
    const Group = this.ctx.loader?.builtins?.group
    if (typeof Group !== 'function') {
      throw new Error('fish-brain-suite requires the DSH Loader cordis:group builtin')
    }
    const group = new Group(this.ctx, this.config)
    let disable
    const lifecycle = this.ctx.fishBrainLifecycle
    // Native Fiber unloads children concurrently with parent cleanup. Start
    // observing ownership before mounting, not after cancellation has settled.
    const release = watchRelease(lifecycle.ctx, [this.ctx.fiber], { unloadingOnly: true })
    const suiteFiber = this.ctx.fiber
    const stopNotice = lifecycle.ctx.on('internal/plugin', fiber => {
      if (fiber.uid !== null || fiber.ctx !== suiteFiber.ctx || !disable) return
      // Native Fiber announces disposal before starting concurrent child cleanup.
      lifecycle.mode = 'switching'
      for (const agent of lifecycle.entries.keys()) agent.cancel({ kind: 'hook', reason: 'fish-brain suite unloading' })
    })
    yield async () => {
      const failures = []
      try {
        if (disable) await disable()
      } catch (error) { failures.push(error) }
      // Native groups share the Host EntryTree; ownership is the exact parent
      // chain, never every entry in that tree (which includes this suite).
      const ownsEntry = entry => {
        const seen = new Set()
        for (let parent = entry.parent; parent && !seen.has(parent); parent = parent.ctx?.fiber?.entry?.parent) {
          if (parent === group || parent.ctx?.fiber?.ctx === this.ctx.fiber.ctx) return true
          seen.add(parent)
        }
        return false
      }
      const fibers = [...group.tree.entries()].filter(ownsEntry).map(entry => entry.fiber).filter(Boolean).reverse()
      try {
        for (const fiber of fibers) await settleFiber(fiber)
        group.stop()
      } catch (error) { failures.push(error) }
      await release.close()
      stopNotice()
      failures.push(...release.failures)
      if (failures.length) {
        const error = new AggregateError(failures, failures.map(e => e.message).join('; '))
        lifecycle.fault(error)
        throw error
      }
      lifecycle.finishDisabled()
    }
    await group.update(this.config)
    for (const row of this.config) {
      const fiber = group.tree.store[row.id]?.fiber
      if (!fiber) throw new Error('fish-brain suite child failed to start: ' + row.id)
      await fiber.await()
      const missing = Object.keys(fiber.inject).filter(key => fiber.ctx.get(key) === undefined)
      if (missing.length) throw new Error('fish-brain suite child waiting for ' + missing.join(', '))
    }
    disable = await lifecycle.enable()
  }
}
