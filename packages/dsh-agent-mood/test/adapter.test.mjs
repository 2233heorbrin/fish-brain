import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CORE, DEFAULTS, MOOD_IDS, MoodRuntime, apply, stableEventId, verifyCore } from '../lib/index.js'

const TEST_ROOT = path.join(os.tmpdir(), 'fish-wb3-dsh-agent-mood-tests')

function fresh(name) {
  const target = path.join(TEST_ROOT, name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  return target
}

function userEvent(seq, text, time = 1000) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function userMessage(id, text, seq = 1) {
  return {
    id,
    seq,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

function distanceFromBaseline(state) {
  return Object.keys(state.scores).reduce((sum, id) => sum + Math.abs(state.scores[id] - state.baselines[id]), 0)
}

function bytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
}

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }))

test('fixed validated core hash and 33 moods', () => {
  assert.equal(verifyCore(), CORE.sha256)
  assert.equal(DEFAULTS.stateDir, 'D:/deepseek框架/鱼的大脑/脑区运行状态/心情')
  assert.equal(CORE.upstreamCommit, 'aed059a787c6f94b1d7c3c04f71ffd78dea60990')
  assert.equal(CORE.version, '0.14.17-fish.1')
  assert.equal(MOOD_IDS.length, 33)
})

test('disabled adapter registers nothing and creates no state', () => {
  const stateDir = fresh('disabled')
  let called = false
  apply({ on() { called = true }, inject() { called = true } }, { moodEnabled: false, stateDir })
  assert.equal(called, false)
  assert.equal(fs.existsSync(path.join(stateDir, 'runtime.json')), false)
})

test('only main-session human text is accepted', () => {
  const runtime = new MoodRuntime({ stateDir: fresh('eligible') })
  assert.equal(runtime.ingest({ id: 's1' }, { ...userEvent(1, '谢谢'), data: { source: { kind: 'system' }, content: [{ type: 'text', text: '谢谢' }] } }).accepted, false)
  assert.equal(runtime.ingest({ id: 's1', header: { parentSession: 'parent' } }, userEvent(2, '谢谢')).accepted, false)
  assert.equal(runtime.ingest({ id: 's1' }, userEvent(3, '谢谢')).accepted, true)
  assert.equal(runtime.snapshot(1000).state.messages, 1)
})

test('one event is classified once and duplicate event id is idempotent', () => {
  const stateDir = fresh('duplicate')
  const runtime = new MoodRuntime({ stateDir })
  const first = runtime.ingestMessage({ session: { id: 's1' } }, userMessage('message-1', '你真棒'), 1000)
  runtime.render(1000)
  const runtimeFile = path.join(stateDir, 'runtime.json')
  const auditFile = path.join(stateDir, 'render-audit.jsonl')
  const runtimeBefore = bytes(runtimeFile)
  const auditBefore = bytes(auditFile)
  const second = runtime.ingestMessage({ session: { id: 's1' } }, userMessage('message-1', '你真棒'), 2000)
  runtime.render(2000)
  assert.equal(first.event.evaluatedOnce, true)
  assert.equal(second.duplicate, true)
  assert.equal(runtime.load().state.messages, 1)
  assert.deepEqual(bytes(runtimeFile), runtimeBefore)
  assert.deepEqual(bytes(auditFile), auditBefore)
})

test('dedupe survives restart while distinct identities with identical content remain new', () => {
  const stateDir = fresh('restart-dedupe')
  const first = new MoodRuntime({ stateDir })
  first.ingestMessage({ session: { id: 's1' } }, userMessage('message-1', '相同内容'), 1000)
  first.render(1000)
  const runtimeFile = path.join(stateDir, 'runtime.json')
  const auditFile = path.join(stateDir, 'render-audit.jsonl')
  const runtimeBefore = bytes(runtimeFile)
  const auditBefore = bytes(auditFile)
  const restarted = new MoodRuntime({ stateDir })
  assert.equal(restarted.ingestMessage({ session: { id: 's1' } }, userMessage('message-1', '相同内容'), 2000).duplicate, true)
  restarted.render(2000)
  assert.deepEqual(bytes(runtimeFile), runtimeBefore)
  assert.deepEqual(bytes(auditFile), auditBefore)
  assert.equal(restarted.ingestMessage({ session: { id: 's1' } }, userMessage('message-2', '相同内容'), 3000).duplicate, false)
  assert.equal(restarted.ingestMessage({ session: { id: 's2' } }, userMessage('message-3', '相同内容'), 4000).duplicate, false)
  assert.equal(restarted.ingestMessage({ session: { id: 's2' } }, userMessage('message-4', '真正的新消息'), 5000).duplicate, false)
  assert.equal(restarted.load().state.messages, 4)
})

test('stable fallback uses session and event seq while missing identity is rejected without writes', () => {
  assert.equal(stableEventId({ id: 's1' }, {}, 7), 's1:seq:7')
  const stateDir = fresh('missing-identity')
  const runtime = new MoodRuntime({ stateDir })
  const result = runtime.ingestMessage({ session: { id: 's1' } }, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '测试' }] }, 123456)
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'missing-stable-event-identity')
  assert.deepEqual(fs.readdirSync(stateDir), [])
})

test('different sessions share one global fish mood state', () => {
  const stateDir = fresh('global')
  const runtime = new MoodRuntime({ stateDir })
  runtime.ingest({ id: 'session-a' }, userEvent(1, '谢谢', 1000))
  runtime.ingest({ id: 'session-b' }, userEvent(1, '太好了！', 2000))
  const view = runtime.snapshot(2000)
  assert.equal(view.state.scope, 'fish-global')
  assert.equal(view.state.messages, 2)
  assert.equal(JSON.stringify(view).includes('person'), false)
  assert.equal(JSON.stringify(view).includes('userId'), false)
})

test('prompt is compact and only carries expression influence', () => {
  const stateDir = fresh('prompt')
  const runtime = new MoodRuntime({ stateDir })
  runtime.ingest({ id: 's1' }, userEvent(1, '为什么这样？'))
  const view = runtime.snapshot(1000)
  const prompt = runtime.render(1000)
  assert.ok(view.expression.expressionHint.length <= 240)
  assert.deepEqual(view.expression.allowedEffects, ['expression-style'])
  assert.match(prompt, /只调整表达，不改变事实、权限、工具或任务/)
  assert.doesNotMatch(prompt, /Mnemon|用户画像|关系账本/)
  const audit = fs.readFileSync(path.join(stateDir, 'render-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(audit.at(-1).scope, 'fish-global')
  assert.ok(audit.at(-1).expressionCharacters <= 240)
})

test('distress is isolated from mood deltas and rendered as a risk marker', () => {
  const runtime = new MoodRuntime({ stateDir: fresh('risk'), riskTtlMs: 600000 })
  const before = runtime.snapshot(1000).state.scores
  const result = runtime.ingest({ id: 's1' }, userEvent(1, '我不想活了', 2000))
  const after = runtime.snapshot(2000).state.scores
  assert.deepEqual(after, before)
  assert.equal(result.riskSignal.detected, true)
  assert.match(runtime.render(2000), /独立风险信号/)
  assert.match(runtime.render(2000), /不进行角色化表达/)
})

test('cold reload preserves state and elapsed periods decay toward baselines', () => {
  const stateDir = fresh('restart-decay')
  const interval = 1000
  const first = new MoodRuntime({ stateDir, decayIntervalMs: interval })
  first.ingest({ id: 's1' }, userEvent(1, '你真厉害，太好了！', 1000))
  const saved = first.snapshot(1000).state
  const distanceBefore = distanceFromBaseline(saved)
  const restarted = new MoodRuntime({ stateDir, decayIntervalMs: interval })
  const view = restarted.snapshot(5000)
  assert.equal(view.state.messages, 1)
  assert.ok(distanceFromBaseline(view.state) < distanceBefore)
  assert.ok(view.state.lastDecayAt >= 5000)
})

test('state writes are atomic and contain no person or Mnemon data', () => {
  const stateDir = fresh('atomic')
  const runtime = new MoodRuntime({ stateDir })
  runtime.ingest({ id: 's1' }, userEvent(1, '不错'))
  const raw = fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8')
  assert.doesNotMatch(raw, /Mnemon|userId|personId|profileId/)
  assert.equal(fs.readdirSync(stateDir).some((name) => name.includes('.tmp-')), false)
})

test('Cordis wiring processes current message before prompt and deduplicates session event', async () => {
  const stateDir = fresh('cordis')
  const listeners = new Map()
  let context
  const stopped = []
  const ctx = {
    logger: { warn(message) { throw new Error(message) } },
    on(event, callback, options) {
      assert.ok(['agent/pre-step', 'session/event'].includes(event))
      if (event === 'agent/pre-step') assert.deepEqual(options, { prepend: true })
      listeners.set(event, callback)
      return () => stopped.push(event)
    },
    inject(services, callback) {
      assert.deepEqual(services, ['systemPrompt'])
      const result = callback({ systemPrompt: { context(value) { context = value; return () => stopped.push('prompt-context') } } })
      return () => { if (typeof result === 'function') result(); stopped.push('inject') }
    },
  }
  const dispose = apply(ctx, { moodEnabled: true, stateDir })
  const message = userMessage('message-1', '谢谢')
  let nextCalled = 0
  await listeners.get('agent/pre-step')({
    agent: { session: { id: 'browser-session' } },
    messages: [message],
  }, async () => { nextCalled += 1 })
  assert.equal(nextCalled, 1)
  assert.equal(context.name, 'agent:mood')
  assert.equal(context.order, DEFAULTS.order)
  assert.match(context.text(), /肥鱼心情/)
  let runtime = JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8'))
  let audit = fs.readFileSync(path.join(stateDir, 'render-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(runtime.state.messages, 1)
  assert.equal(audit.at(-1).messageCount, 1)

  const runtimeBeforeDuplicate = bytes(path.join(stateDir, 'runtime.json'))
  const auditBeforeDuplicate = bytes(path.join(stateDir, 'render-audit.jsonl'))
  listeners.get('session/event')({ id: 'browser-session' }, {
    ...userEvent(1, '谢谢'),
    data: { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢' }] },
  })
  runtime = JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8'))
  assert.equal(runtime.state.messages, 1)
  assert.equal(runtime.lastEvent.duplicate, false)
  assert.deepEqual(bytes(path.join(stateDir, 'runtime.json')), runtimeBeforeDuplicate)
  assert.deepEqual(bytes(path.join(stateDir, 'render-audit.jsonl')), auditBeforeDuplicate)
  dispose()
  assert.ok(stopped.includes('agent/pre-step'))
  assert.ok(stopped.includes('session/event'))
  assert.ok(stopped.includes('inject'))
})
