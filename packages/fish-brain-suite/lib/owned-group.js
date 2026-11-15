import { settleFiber } from './native.js'

// The tree survives module replacement. Keep the in-flight Suite ownership on
// that tree so a successor module can join the exact predecessor's release.
const ownersKey = Symbol.for('fish-brain-suite.group-owners')

export function ownedGroup(ctx, config) {
  const Group = ctx.loader?.builtins?.group
  if (typeof Group !== 'function') throw new Error('fish-brain-suite requires the DSH Loader cordis:group builtin')
  const group = new Group(ctx, structuredClone(config))
  const owners = group.tree[ownersKey] ??= new Map()
  let complete
  const owner = { fiber: ctx.fiber, done: new Promise(resolve => { complete = resolve }), stopping: false }
  const entries = new Set(), fibers = new Set(), pending = new Set(), errors = new Map()
  const create = group.create.bind(group), remove = group.remove.bind(group), update = group.update.bind(group)

  group.create = options => {
    const task = (async () => {
      const id = group.tree.ensureId(options)
      try {
        const previous = owners.get(id)
        if (previous && previous !== owner) {
          if (!previous.stopping && previous.fiber.uid !== null && previous.fiber.state !== 5)
            throw new Error('fish-brain suite active entry conflict: ' + id)
          const failure = await previous.done
          if (failure) throw failure
        }
        if (owner.stopping) throw new Error('fish-brain suite is unloading: ' + id)
        if (owners.has(id) && owners.get(id) !== owner)
          throw new Error('fish-brain suite active entry conflict: ' + id)
        const entry = group.tree.store[id]
        if (entry && entry.parent !== group)
          throw new Error('fish-brain suite foreign entry conflict: ' + id)
        owners.set(id, owner)
        // Entry.init otherwise replaces a disposed Fiber before it has joined
        // its disposers, leaving that old Fiber attached to the reused Entry.
        if (entry?.fiber?.uid === null) await entry.fiber.await()
        if (owner.stopping) throw new Error('fish-brain suite is unloading: ' + id)
        try { return await create(options) }
        finally {
          const current = group.tree.store[id]
          if (current?.parent === group) {
            entries.add(current)
            if (current.fiber) fibers.add(current.fiber)
          }
        }
      } catch (error) { errors.set(id, error); throw error }
    })()
    pending.add(task)
    task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  group.remove = (id, isDispose) => {
    const entry = group.tree.store[id]
    if (entry?.parent !== group || !entries.has(entry)) return
    if (entry.fiber) fibers.add(entry.fiber)
    return remove(id, isDispose)
  }
  // Native Group's update listener also uses this method. Every generation
  // gets detached nested options, including config and disabled expressions.
  group.update = config => update(structuredClone(config))

  return {
    group,
    beginRelease() { owner.stopping = true },
    async stop() {
      owner.stopping = true
      await Promise.allSettled([...pending])
      group.stop()
      const results = await Promise.allSettled([...fibers].reverse().map(settleFiber))
      return results.filter(result => result.status === 'rejected').map(result => result.reason)
    },
    finishRelease(error) {
      // Cordis may refresh a failed dependent again. A failed release is not a
      // free slot: retain that result on the tree rather than hide it on refresh.
      if (!error) for (const [id, current] of owners) if (current === owner) owners.delete(id)
      complete(error)
    },
    async start() {
      await group.update(config)
      for (const row of group.data) {
        if (errors.has(row.id)) throw errors.get(row.id)
        const entry = group.tree.store[row.id]
        if (entry?.parent !== group || !entries.has(entry))
          throw new Error('fish-brain suite child ownership lost: ' + row.id)
        if (entry.disabled) throw new Error('fish-brain suite required child disabled: ' + row.id)
        const fiber = entry.fiber
        if (!fiber) throw new Error('fish-brain suite child failed to start: ' + row.id)
        await fiber.await()
        const missing = Object.keys(fiber.inject).filter(key => fiber.ctx.get(key) === undefined)
        if (missing.length) throw new Error('fish-brain suite child waiting for ' + missing.join(', '))
        if (group.tree.store[row.id] !== entry || entry.parent !== group || entry.fiber !== fiber || fiber.uid === null || fiber.state !== 2)
          throw new Error('fish-brain suite child not active or ownership lost: ' + row.id)
      }
    },
  }
}
