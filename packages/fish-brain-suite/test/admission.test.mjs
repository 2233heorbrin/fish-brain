import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runtime, mod } from './native-harness.mjs'
import * as control from '../lib/control.js'
import { BINDING, HISTORY_QUESTION, CONTINUE_HISTORY, NEW_CONVERSATION } from '../lib/lifecycle.js'

const fixture = new URL('./fixtures.mjs', import.meta.url).href
const fish = [{ id: 'fish', name: fixture, config: { context: 'agent:self', tool: 'fish_memory_search' } }]
const standard = [{ id: 'standard', name: fixture, config: { tool: 'native_engineering' } }]
const { createUserMessage } = mod('dsh-llm')
const input = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const bindings = agent => agent.session.snapshotEvents().filter(e => e.type === BINDING)

function noModelProbe(r) {
  const admitted = []
  const stop = r.ctx.on('agent/pre-step', ({ agent }) => {
    admitted.push(agent.id)
    return { kind: 'reject' } // actual driver entered our hook; no step/model/tool runs
  })
  return { admitted, stop, async run(agent) {
    agent.followup(input('isolated admission check'))
    await agent.whenIdle()
  } }
}

async function controller(r) {
  r.unhook()
  r.ctx.provide('connection', { fetch: { register() { return () => {} } } })
  const path = join(r.directory, 'plugins.json')
  await writeFile(path, JSON.stringify(fish))
  const fiber = r.ctx.plugin(control, { fishPluginsPath: path, epochPath: join(r.directory, 'controller-epoch.json') })
  await fiber.await()
  await new Promise(resolve => setImmediate(resolve))
  const life = r.ctx.get('fishBrainLifecycle')
  await life.chain
  return { life, fiber }
}

for (const mode of ['enabled', 'disabled']) test(`production hooks: native standard → select fish → first input passes while ${mode}`, async () => {
  const r = await runtime(fish, standard)
  const { life, fiber } = await controller(r)
  const probe = noModelProbe(r)
  try {
    if (mode === 'enabled') await life.enable()
    const a = (await r.create('native-selection-' + mode, 'standard')).agent
    a.session.append('permission/preset', { preset: 'workspace-write' })
    a.session.append('sandbox/mode', { mode: 'off' })
    a.session.append('approval/policy', { policy: 'ask' })
    assert.equal(r.ctx.agentPresets.composedPreset(a.ctx), 'standard')
    assert.equal(await r.ctx.agentPresets.select(a, 'fish'), 'fish')
    assert.equal(bindings(a).length, 0, 'selection event must not append binding')
    await probe.run(a)
    assert.deepEqual(probe.admitted, [a.id], JSON.stringify(a.session.snapshotEvents().at(-1)))
    assert.equal(bindings(a).length, 1)
    assert.equal(bindings(a)[0].data.admission, 'fresh')
    await probe.run(a)
    assert.equal(probe.admitted.length, 2)
    assert.equal(bindings(a).length, 1)
    assert.equal(a.session.snapshotEvents().filter(e => e.type === 'step/start').length, 0)
    assert.equal(life.mode, mode)
    assert(!r.logs.some(log => log.args.some(arg => /nested|publishing|reentrant/i.test(String(arg)))))
  } finally {
    probe.stop(); await fiber.dispose(); await fiber.await(); await r.cleanup()
  }
})

test('real native failed pre-step turns retry after actual history inspection, regardless of error text', async () => {
  const r = await runtime(fish, standard)
  try {
    await r.lifecycle.enable()
    const a = (await r.create('retry-without-model', 'standard')).agent
    await r.ctx.agentPresets.select(a, 'fish')
    r.unhook()
    const broken = r.ctx.on('agent/pre-step', () => { throw new Error('original admission defect') })
    a.followup(input('first pending input')); await a.whenIdle()
    a.followup(input('second pending input')); await a.whenIdle()
    broken()
    assert.equal(a.session.deriveMessages().length, 0)
    assert.equal(r.ctx.sessionProjections.stateOf(a.session, 'turnBoundary').lastStepStartSeq, null)
    const hooks = control.installAdmissionHooks(r.ctx, r.lifecycle)
    const probe = noModelProbe(r)
    await probe.run(a)
    assert.deepEqual(probe.admitted, [a.id])
    assert.equal(bindings(a).length, 1)
    assert.equal(bindings(a)[0].data.admission, 'unexecuted-retry')
    assert.equal(a.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 3)
    probe.stop(); hooks.forEach(stop => stop())
  } finally { await r.cleanup() }
})

// Native seed history with a genuinely entered step and admitted user content.
// The content, boundaries and message identities are validated by Session.
function history() {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 3, data: input('existing historical conversation'), surfaceOp: 'append' },
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('unbound real history waits for native human choice; one explicit grant persists and never claims fresh', async () => {
  const r = await runtime(fish, standard)
  const { life, fiber } = await controller(r)
  const probe = noModelProbe(r)
  try {
    await life.enable()
    const a = (await r.create('history-human-continue', 'fish', { seed: history() })).agent
    const original = a.session.snapshotEvents()
    let answer, asks = 0
    const shown = Promise.withResolvers()
    const stop = r.ctx.on('user-questions/request', request => {
      asks++
      assert.equal(request.agent, a)
      assert.match(request.questions[0].question, /旧上下文可能残留/)
      assert.deepEqual(request.questions[0].options.map(o => o.label), [NEW_CONVERSATION, CONTINUE_HISTORY])
      shown.resolve()
      return new Promise(resolve => { answer = resolve })
    })
    a.followup(input('continue existing'))
    await shown.promise
    assert.equal(probe.admitted.length, 0)
    assert.equal(bindings(a).length, 0)
    answer({ answers: [{ id: HISTORY_QUESTION, selected: [CONTINUE_HISTORY] }] })
    await a.whenIdle()
    assert.deepEqual(probe.admitted, [a.id])
    assert.deepEqual(bindings(a)[0].data, { epoch: life.epoch, admission: 'history-confirmed', confirmedBy: 'user' })
    await probe.run(a)
    assert.equal(asks, 1)
    assert.equal(bindings(a).length, 1)
    assert.deepEqual(a.session.snapshotEvents().slice(0, original.length), original)
    const stored = a.session.snapshotEvents()
    await r.ctx.agentLoop.releaseExact(a)
    const resumed = (await r.create('history-confirmation-resumed', 'fish', { seed: stored })).agent
    await probe.run(resumed)
    assert.equal(asks, 1, 'persisted same-epoch human grant survives resume')
    stop()
  } finally { probe.stop(); await fiber.dispose(); await fiber.await(); await r.cleanup() }
})

test('new conversation choice leaves old content intact; known crossed binding never prompts; standard unaffected', async () => {
  const r = await runtime(fish, standard)
  const probe = noModelProbe(r)
  try {
    await r.lifecycle.enable()
    const a = (await r.create('history-new-choice', 'fish', { seed: history() })).agent
    let asks = 0
    const stop = r.ctx.on('user-questions/request', async () => {
      asks++; return { answers: [{ id: HISTORY_QUESTION, selected: [NEW_CONVERSATION] }] }
    })
    const oldMessages = a.session.deriveMessages()
    await probe.run(a)
    assert.equal(probe.admitted.length, 0)
    assert.equal(bindings(a).length, 0)
    assert.deepEqual(a.session.deriveMessages(), oldMessages)
    assert.equal(r.lifecycle.mode, 'enabled')
    const fresh = (await r.create('user-new-empty', 'standard')).agent
    await r.ctx.agentPresets.select(fresh, 'fish')
    assert.equal(fresh.session.deriveMessages().length, 0)
    await probe.run(fresh)
    const oldBinding = fresh.session.snapshotEvents()
    await r.lifecycle.switchTo('disabled')
    const crossed = (await r.create('known-crossed', 'fish', { seed: oldBinding })).agent
    await probe.run(crossed)
    assert.equal(asks, 1)
    assert(!probe.admitted.includes(crossed.id))
    assert.equal(r.lifecycle.mode, 'disabled')
    const s = (await r.create('independent-standard', 'standard')).agent
    await probe.run(s)
    assert(probe.admitted.includes(s.id))
    assert.equal(bindings(s).length, 0)
    stop()
  } finally { probe.stop(); await r.cleanup() }
})

test('no native answerer grants nothing; single-session failure never faults the suite', async () => {
  const r = await runtime(fish, standard)
  try {
    await r.lifecycle.enable()
    const a = (await r.create('history-without-human', 'fish', { seed: history() })).agent
    await assert.rejects(r.lifecycle.mayRun(a), /HISTORY_CHOICE_REQUIRED.*旧上下文可能残留/)
    assert.equal(bindings(a).length, 0)
    assert.equal(r.lifecycle.mode, 'enabled')
    assert.deepEqual(r.lifecycle.failures, [])
  } finally { await r.cleanup() }
})

test('entered step and summary-only history require a choice, even with no derived chat messages', async () => {
  const r = await runtime(fish, standard)
  try {
    await r.lifecycle.enable()
    const summary = [{ type: 'compaction/summary', seq: 0, time: 1, data: {
      compactionId: 'fixture-summary', summary: 'prior compacted context',
      shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokenCount: 0,
      provider: 'fixture', model: 'not-called',
    } }]
    const entered = history().filter(e => e.type !== 'user/message').map((e, seq) => ({ ...e, seq }))
    let asks = 0
    const stop = r.ctx.on('user-questions/request', async () => {
      asks++; return { answers: [{ id: HISTORY_QUESTION, selected: [NEW_CONVERSATION] }] }
    })
    for (const [id, seed] of [['summary-only', summary], ['entered-step', entered]]) {
      const a = (await r.create(id, 'fish', { seed })).agent
      assert.equal(a.session.deriveMessages().length, 0)
      await assert.rejects(r.lifecycle.mayRun(a), /NEW_CONVERSATION_REQUIRED/)
      assert.equal(bindings(a).length, 0)
    }
    assert.equal(asks, 2)
    assert.equal(r.lifecycle.mode, 'enabled')
    stop()
  } finally { await r.cleanup() }
})

test('native disable cancels a pending history question and cannot carry its grant across the switch', async () => {
  const r = await runtime(fish, standard)
  const probe = noModelProbe(r)
  try {
    const disable = await r.lifecycle.enable()
    const a = (await r.create('history-cancel-on-disable', 'fish', { seed: history() })).agent
    const shown = Promise.withResolvers()
    const stop = r.ctx.on('user-questions/request', request => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('fixture UI question aborted')), { once: true })
      shown.resolve()
    }))
    a.followup(input('pending human choice'))
    await shown.promise
    await disable(); r.lifecycle.finishDisabled()
    assert.equal(r.ctx.agents.get(a.id), undefined)
    assert.equal(bindings(a).length, 0)
    assert.equal(probe.admitted.length, 0)
    assert.equal(r.lifecycle.state().fullyDisabled, true)
    stop()
  } finally { probe.stop(); await r.cleanup() }
})
