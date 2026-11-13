import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isFishAgent } from '../../../internal/agent-scope.js'

import {
  CONFIG as CORE_CONFIG,
  MOOD_IDS,
  UPSTREAM,
  createExpression,
  createState,
  decayState,
  processMessage,
  summarizeState,
} from '../../dsh-mood-core/src/core.mjs'

const brainPath = (rel) => {
  const root = (process.env.FISH_BRAIN_ROOT || '').replace(/[\\/]+$/, '')
  return root ? root + '/' + rel : rel
}

export const name = 'dsh-agent-mood'

export const CORE = Object.freeze({
  path: fileURLToPath(new URL('../../dsh-mood-core/src/core.mjs', import.meta.url)),
  version: '0.14.17-fish.1',
  upstreamVersion: UPSTREAM.packageVersion,
  upstreamCommit: UPSTREAM.commit,
  sha256: 'F58649B10046CDBA59C569082159225526E69AA5CB419281A387AE030B54CF31',
})

export const DEFAULTS = Object.freeze({
  moodEnabled: false,
  stateDir: brainPath('脑区运行状态/心情'),
  order: 132,
  decayIntervalMs: 15 * 60 * 1000,
  riskTtlMs: 10 * 60 * 1000,
  includeSubagents: false,
  maximumDecaySteps: 96,
})

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
}

export function verifyCore() {
  const actual = sha256File(CORE.path)
  if (actual !== CORE.sha256) throw new Error('dsh-agent-mood core SHA-256 mismatch: ' + actual)
  return actual
}

function sessionIdOf(session) {
  return String(session?.id || session?.header?.id || 'unknown-session')
}

function isChildSession(session) {
  return Boolean(session?.header?.parentSession || session?.parentSession || session?.parent)
}

function userTextOf(event) {
  if (event?.type !== 'user/message' || event?.data?.source?.kind !== 'user') return ''
  const content = Array.isArray(event.data.content) ? event.data.content : []
  return content.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join('\n').trim()
}

function messageTextOf(message) {
  if (message?.role !== 'user' || message?.source?.kind !== 'user') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join('\n').trim()
}

export function stableEventId(session, message, seq = null) {
  if (message?.id != null && String(message.id)) return String(message.id)
  const numericSeq = Number(seq ?? message?.seq)
  const sessionId = sessionIdOf(session)
  if (sessionId !== 'unknown-session' && Number.isFinite(numericSeq)) return sessionId + ':seq:' + numericSeq
  return ''
}

function initialEnvelope(now) {
  return {
    schema: 'fish-mood-canary-runtime-v1',
    scope: 'fish-global',
    core: { ...CORE },
    state: createState({ now }),
    lastEvent: null,
    riskSignal: null,
    updatedAt: now,
  }
}

function normalizeEnvelope(value, now) {
  if (!value || value.schema !== 'fish-mood-canary-runtime-v1' || value.scope !== 'fish-global') return initialEnvelope(now)
  if (!value.state || value.state.schema !== 'fish-mood-state-v2' || value.state.scope !== 'fish-global') return initialEnvelope(now)
  return {
    schema: 'fish-mood-canary-runtime-v1',
    scope: 'fish-global',
    core: { ...CORE },
    state: value.state,
    lastEvent: value.lastEvent || null,
    riskSignal: value.riskSignal || null,
    updatedAt: Number(value.updatedAt || value.state.updatedAt || now),
  }
}

export class MoodRuntime {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config }
    this.stateDir = path.resolve(this.config.stateDir)
    this.stateFile = path.join(this.stateDir, 'runtime.json')
    this.envelope = null
    this.coreHash = verifyCore()
  }

  load(now = Date.now()) {
    if (this.envelope) return this.envelope
    try {
      this.envelope = normalizeEnvelope(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')), now)
    } catch {
      this.envelope = initialEnvelope(now)
    }
    return this.envelope
  }

  persist() {
    fs.mkdirSync(this.stateDir, { recursive: true })
    const temp = this.stateFile + '.tmp-' + process.pid
    fs.writeFileSync(temp, JSON.stringify(this.envelope, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, this.stateFile)
  }

  decayTo(now = Date.now(), persist = true) {
    const envelope = this.load(now)
    const last = Number(envelope.state.lastDecayAt || envelope.state.updatedAt || now)
    const interval = Math.max(1, Number(this.config.decayIntervalMs || DEFAULTS.decayIntervalMs))
    const due = Math.min(this.config.maximumDecaySteps, Math.max(0, Math.floor((now - last) / interval)))
    if (!due) return { envelope, steps: 0 }
    for (let index = 0; index < due; index += 1) {
      const at = last + interval * (index + 1)
      envelope.state = decayState(envelope.state, { now: at }).state
    }
    envelope.updatedAt = now
    if (persist) this.persist()
    return { envelope, steps: due }
  }

  ingestText({ session, text, eventId, seq = null, now }) {
    if (!text) return { accepted: false, reason: 'not-eligible-user-text' }
    if (!this.config.includeSubagents && isChildSession(session)) return { accepted: false, reason: 'child-session' }
    if (!eventId) return { accepted: false, reason: 'missing-stable-event-identity' }
    const sessionId = sessionIdOf(session)
    const envelope = this.load(now)
    if ((envelope.state.processedEventIds || []).includes(eventId)) {
      return { accepted: true, duplicate: true, eventId }
    }
    let state = envelope.state
    const last = Number(state.lastDecayAt || state.updatedAt || now)
    const interval = Math.max(1, Number(this.config.decayIntervalMs || DEFAULTS.decayIntervalMs))
    const due = Math.min(this.config.maximumDecaySteps, Math.max(0, Math.floor((now - last) / interval)))
    for (let index = 0; index < due; index += 1) {
      state = decayState(state, { now: last + interval * (index + 1) }).state
    }
    const result = processMessage(state, text, { at: now, eventId })
    if (result.duplicate === true) return { accepted: true, duplicate: true, eventId }
    this.envelope.state = result.state
    this.envelope.lastEvent = {
      eventId,
      sessionId,
      seq: Number.isFinite(Number(seq)) ? Number(seq) : null,
      at: now,
      kind: result.event.kind,
      summary: result.event.summary,
      evaluatedOnce: result.event.evaluatedOnce === true,
      duplicate: result.duplicate === true,
    }
    this.envelope.riskSignal = result.riskSignal
    this.envelope.updatedAt = now
    this.persist()
    return { accepted: true, eventId, ...result }
  }

  ingest(session, event, now = Number(event?.time || Date.now())) {
    const text = userTextOf(event)
    const eventId = stableEventId(session, event?.data, event?.seq)
    return this.ingestText({ session, text, eventId, seq: event?.seq, now })
  }

  ingestMessage(agent, message, now = Date.now()) {
    const session = agent?.session || agent
    const text = messageTextOf(message)
    const eventId = stableEventId(session, message, message?.seq)
    return this.ingestText({ session, text, eventId, seq: message?.seq, now })
  }

  snapshot(now = Date.now()) {
    this.decayTo(now)
    const envelope = this.load(now)
    return {
      coreHash: this.coreHash,
      state: structuredClone(envelope.state),
      summary: summarizeState(envelope.state),
      expression: createExpression(envelope.state),
      lastEvent: envelope.lastEvent ? { ...envelope.lastEvent } : null,
      riskSignal: envelope.riskSignal ? { ...envelope.riskSignal } : null,
    }
  }

  render(now = Date.now()) {
    const view = this.snapshot(now)
    const summary = view.summary
    const expression = view.expression
    const secondary = summary.secondary.length ? summary.secondary.map((item) => item.label).join('、') : '无'
    const drivers = summary.drivers.length ? summary.drivers.map((item) => item.summary).slice(0, 3).join('；') : '无明确事件'
    const lines = [
      '【肥鱼心情·模拟全局状态】',
      '主心情：' + summary.primary.label + '；次心情：' + secondary + '；强度：' + summary.strength + '；精力：' + summary.energy + '；压力：' + summary.stress,
      'drivers：' + drivers,
      '表达提示：' + expression.expressionHint,
    ]
    const risk = view.riskSignal
    if (risk?.detected && now - Number(risk.at || 0) <= this.config.riskTtlMs) {
      lines.push('【独立风险信号】检测到明确痛苦信号；这不是心情，不进行角色化表达，按安全响应处理。')
    }
    const eventId = view.lastEvent?.eventId || ''
    const auditFile = path.join(this.stateDir, 'render-audit.jsonl')
    let alreadyAudited = false
    if (eventId && view.lastEvent?.duplicate !== true) {
      try {
        alreadyAudited = fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).some((line) => {
          if (!line.trim()) return false
          try { return JSON.parse(line).eventId === eventId } catch { return false }
        })
      } catch {}
    }
    if (eventId && view.lastEvent?.duplicate !== true && !alreadyAudited) {
      fs.mkdirSync(this.stateDir, { recursive: true })
      fs.appendFileSync(auditFile, JSON.stringify({
      schema: 'fish-mood-render-audit-v1',
      at: now,
      eventId,
      scope: 'fish-global',
      primary: summary.primary.id,
      secondary: summary.secondary.map((item) => item.id),
      expressionCharacters: expression.expressionHint.length,
      messageCount: view.state.messages,
      riskDetected: Boolean(risk?.detected),
      }) + '\n', 'utf8')
    }
    return lines.join('\n')
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (cfg.moodEnabled !== true) return
  const runtime = new MoodRuntime(cfg)
  const stopPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    if (!isFishAgent(ctx, payload?.agent)) return next()
    try {
      for (const message of payload?.messages || []) runtime.ingestMessage(payload.agent, message)
    } catch (error) {
      ctx.logger?.warn?.('dsh-agent-mood pre-step failed: ' + String(error?.message || error))
    }
    return next()
  }, { prepend: true })
  const stopEvent = ctx.on('session/event', (session, event) => {
    if (!isFishAgent(ctx, ctx.agents?.get(session.id))) return
    try {
      runtime.ingest(session, event)
    } catch (error) {
      ctx.logger?.warn?.('dsh-agent-mood event failed: ' + String(error?.message || error))
    }
  })
  const stopPrompt = ctx.inject(['systemPrompt'], (scope) => scope.systemPrompt.context({
    name: 'agent:mood',
    order: cfg.order,
    text: context => {
      if (!isFishAgent(ctx, context?.agent)) return ''
      try {
        return runtime.render()
      } catch (error) {
        ctx.logger?.warn?.('dsh-agent-mood render failed: ' + String(error?.message || error))
        return ''
      }
    },
  }))
  return () => {
    if (typeof stopPrompt === 'function') stopPrompt()
    if (typeof stopEvent === 'function') stopEvent()
    if (typeof stopPreStep === 'function') stopPreStep()
  }
}

export { CORE_CONFIG, MOOD_IDS }

export default { name, apply }
