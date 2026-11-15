const groupKey = Symbol.for('cordis.group')
const init = Symbol.for('cordis.init')
import { watchRelease } from './native.js'
import { ownedGroup } from './owned-group.js'

export const name = 'fish-brain-suite'

export default class FishBrainSuite {
  static inject = ['loader', 'fishBrainLifecycle']
  static [groupKey] = true

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = Array.isArray(config) ? config : []
  }

  async *[init]() {
    const owned = ownedGroup(this.ctx, this.config)
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
      owned.beginRelease()
      const failures = []
      let failure
      try {
        try { if (disable) await disable() } catch (error) { failures.push(error) }
        try { failures.push(...await owned.stop()) } catch (error) { failures.push(error) }
        await release.close()
        stopNotice()
        failures.push(...release.failures)
        if (failures.length) throw new AggregateError(failures, failures.map(e => e.message).join('; '))
        if (disable) lifecycle.finishDisabled()
      } catch (error) {
        failure = error
        lifecycle.fault(error)
        throw error
      } finally {
        owned.finishRelease(failure)
      }
    }
    await owned.start()
    disable = await lifecycle.enable()
  }
}
