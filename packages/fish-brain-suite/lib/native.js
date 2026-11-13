import { createRequire } from 'node:module'

// Use the running DSH installation's dependencies, not another Loader/runtime copy.
export function nativeModules(ctx) {
  const anchor = ctx.get('profileContext')?.installAnchor
  if (!anchor) throw new Error('fish-brain: DSH installation anchor is unavailable')
  const require = createRequire(anchor)
  return {
    ...require('@deepseek-ai/dsh-scope'),
    appendPluginRecord: require('@deepseek-ai/dsh-session').appendPluginRecord,
    loadYaml: require('js-yaml').load,
    entryListSchema: require('@deepseek-ai/cordis-plugin-include').entryListSchema,
  }
}

export function watchRelease(ctx, roots, { unloadingOnly = false } = {}) {
  const failures = []
  // ctx.plugin() may return a thenable view whose prototype is the Fiber.
  const raw = value => value?.ctx?.fiber || value
  const exactRoots = Array.isArray(roots) ? roots.map(raw) : null
  // Cordis contains disposer exceptions. Observe only the exact owned fibers,
  // including nested native groups, while joining their teardown.
  const owns = fiber => {
    const seen = new Set()
    while (fiber && !seen.has(fiber)) {
      fiber = raw(fiber)
      if (typeof roots === 'function' ? roots(fiber) : exactRoots.includes(fiber)) return true
      seen.add(fiber)
      fiber = fiber.parent?.fiber
    }
    return false
  }
  const undo = ctx.root.logger.exporter({ levels: { default: 0 }, export(message) {
    const fiber = message.fiber?.deref()
    if (message.type === 'error' && (!unloadingOnly || fiber?.state === 5 || fiber?.uid === null) && owns(fiber))
      failures.push(...message.args.map(value => value instanceof Error ? value : new Error(String(value))))
  } })
  return { failures, close: undo }
}

export async function observeRelease(ctx, roots, operation) {
  const { failures, close } = watchRelease(ctx, roots)
  try {
    try { await operation() } catch (error) { failures.push(error) }
  } finally { await close() }
  if (failures.length) throw new AggregateError(failures, failures.map(e => e.message).join('; '))
}

export async function settleFiber(fiber) {
  await fiber.dispose()
  await fiber.await()
}
