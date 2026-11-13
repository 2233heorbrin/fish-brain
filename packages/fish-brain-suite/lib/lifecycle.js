import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { observeRelease } from './native.js'

export const BINDING = 'plugin:fish-brain/binding'
export const HISTORY_QUESTION = 'fish-brain-history'
export const CONTINUE_HISTORY = '明确沿用历史'
export const NEW_CONVERSATION = '新建对话'
const describe = error => String(error?.message || error)

// Native registry owns composition; AgentLoop owns teardown; Loader owns the
// switch. This bridge owns only exact fish identities and conversation epochs.
export class BrainLifecycle {
  constructor(ctx, config, native) {
    Object.assign(this, { ctx, config, native, mode: 'starting', epoch: null,
      entries: new Map(), failures: [], chain: Promise.resolve(), lease: null,
      suiteResources: false, definition: null, unregister: null, generationKey: null,
      admissions: new WeakMap() })
  }

  state() {
    return { mode: this.mode,
      fullyDisabled: this.mode === 'disabled' && !this.suiteResources && !this.failures.length,
      activeBrainAgents: [...this.entries.values()].filter(e => e.mode === 'enabled').length,
      nativeFishAgents: [...this.entries.values()].filter(e => e.mode === 'disabled').length,
      failures: [...this.failures],
      notice: this.mode === 'disabled' ? '鱼脑已关闭。历史记录保留；请用原生新会话继续。重新开启请使用 DSH 插件管理器。' :
        this.mode === 'enabled' ? '鱼脑已开启。跨启停边界后请使用原生新会话。' : '鱼脑切换未完成，请查看释放错误并使用原生新会话。' }
  }

  enqueue(operation) {
    const next = this.chain.then(operation)
    this.chain = next.catch(() => {})
    return next
  }

  fault(error) {
    this.mode = 'fault'
    this.failures.push(describe(error))
    if (this.definition) this.definition.name = 'fish · 鱼脑切换失败'
    this.ctx.emit('fish-brain/state', this.state())
  }

  checkpoint(mode) {
    let previous
    if (existsSync(this.config.epochPath)) previous = JSON.parse(readFileSync(this.config.epochPath, 'utf8'))
    const epoch = previous?.observedMode === mode && typeof previous?.epoch === 'string' ? previous.epoch : randomUUID()
    mkdirSync(dirname(this.config.epochPath), { recursive: true })
    const tmp = `${this.config.epochPath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ epoch, observedMode: mode }) + '\n')
    renameSync(tmp, this.config.epochPath)
    this.epoch = epoch
  }

  async removeDefinition() {
    if (!this.unregister) return
    const key = this.generationKey
    await observeRelease(this.ctx, fiber => this.native.scopeChainOf(this.native.scopeOf(fiber.ctx)).includes(key), this.unregister)
    const retained = this.ctx.agentPresets.inspectCompositions().filter(item => item.id === 'fish')
    if (retained.length) throw new Error('fish preset revision still retained by an in-flight Agent')
    this.unregister = null
    this.generationKey = null
  }

  async installDefinition(mode) {
    const standard = mode === 'disabled' ? await this.ctx.agentPresets.readDocument('standard') : null
    const plugins = mode === 'enabled' ? structuredClone(this.config.fishPlugins) :
      this.native.loadYaml(standard.content, { schema: this.native.entryListSchema })
    this.definition = { id: 'fish', order: 2,
      name: mode === 'enabled' ? 'fish' : 'fish · 鱼脑已关闭',
      description: mode === 'enabled' ? '鱼脑人格、只读记忆、心情与受控委派。' : '鱼脑已关闭；使用原生能力与独立插件。历史保留，请新建对话。', plugins }
    this.unregister = await this.ctx.agentPresets.register(this.definition)
    const scope = await this.ctx.agentPresets.acquireScope('fish')
    this.generationKey = scope.key
    await scope[Symbol.asyncDispose]()
  }

  async switchTo(mode, deferCompletion = false, shuttingDown = false) {
    if (this.mode === mode && this.entries.size === 0) return
    this.mode = 'switching'
    this.failures = []
    try {
      const owned = [...new Set([...this.entries.keys(), ...this.ctx.agents.list().filter(agent =>
        this.ctx.agentPresets.composedPreset(agent.ctx) === 'fish')])]
      for (const agent of owned) agent.cancel({ kind: 'hook', reason: 'fish-brain lifecycle boundary' })
      const settled = await Promise.allSettled(owned.map(async agent => {
        await this.ctx.subagents.drainDescendants([agent])
        await agent.whenIdle()
        await observeRelease(this.ctx, [agent.ctx.fiber], () => this.ctx.agentLoop.releaseExact(agent))
        if (this.ctx.agents.get(agent.id) === agent) throw new Error('fish-brain Agent remained resident')
        this.entries.delete(agent)
      }))
      const errors = settled.filter(r => r.status === 'rejected').map(r => r.reason)
      if (errors.length) throw new AggregateError(errors, errors.map(describe).join('; '))
      await this.removeDefinition()
      this.checkpoint(mode)
      if (!shuttingDown) await this.installDefinition(mode)
      this.mode = deferCompletion ? 'switching' : mode
      this.ctx.emit('fish-brain/state', this.state())
    } catch (error) { this.fault(error); throw error }
  }

  async enable() {
    const lease = {}
    if (this.lease) throw new Error('fish-brain suite already owns a live lease')
    this.lease = lease
    this.suiteResources = true
    try { await this.enqueue(() => this.switchTo('enabled')) }
    catch (error) { this.lease = null; throw error }
    return async () => {
      if (this.lease !== lease) return
      this.lease = null
      await this.enqueue(() => this.switchTo('disabled', true))
    }
  }

  finishDisabled() {
    this.suiteResources = false
    if (this.mode === 'switching' && !this.failures.length) this.mode = 'disabled'
    this.ctx.emit('fish-brain/state', this.state())
  }

  attach(agent) {
    if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'fish') {
      this.entries.delete(agent)
      return
    }
    // Track ownership for teardown, including histories waiting for a choice.
    // Neither creation nor selection admits execution or writes the session.
    if (!this.entries.has(agent)) this.entries.set(agent, { epoch: null, mode: this.mode })
  }

  async mayRun(agent, { signal } = {}) {
    if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'fish') {
      this.entries.delete(agent)
      return true
    }
    const pending = this.admissions.get(agent)
    if (pending) return pending
    const admission = this.admit(agent, signal)
    this.admissions.set(agent, admission)
    try { return await admission }
    finally { if (this.admissions.get(agent) === admission) this.admissions.delete(agent) }
  }

  async admit(agent, signal) {
    signal?.throwIfAborted()
    if (!['enabled', 'disabled'].includes(this.mode))
      throw new Error('FISH_BRAIN_SWITCH_IN_PROGRESS: 请等待鱼脑切换完成后重试')
    const epoch = this.epoch, mode = this.mode
    this.attach(agent)
    const session = agent.session
    const events = session.snapshotEvents()
    const binding = events.findLast(event => event.type === BINDING)?.data
    if (typeof binding?.epoch === 'string' && binding.epoch !== epoch)
      throw new Error('FISH_BRAIN_NEW_CONVERSATION_REQUIRED: 已确认跨越鱼脑启停边界；历史记录保留，请使用原生新会话。')
    let admission = binding?.admission || 'existing-binding'
    if (binding?.epoch !== epoch) {
      const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
      // Use the native model-visible history and step boundary, not turn or
      // settings events. A rejected pre-step has neither an entered step nor
      // admitted messages; pending/claimed inbox input is not old context.
      const uncertain = session.deriveMessages().length > 0 || boundary?.lastStepStartSeq != null ||
        session.header.isSeeded === true || binding !== undefined || events.some(event => event.type === 'compaction/summary')
      admission = boundary?.lastTurn > 1 ? 'unexecuted-retry' : 'fresh'
      if (uncertain) {
        const questions = this.ctx.get('userQuestions')
        if (!questions) throw new Error('FISH_BRAIN_HISTORY_CHOICE_REQUIRED: 旧上下文可能残留；请新建对话，或连接原生确认界面后明确选择沿用历史。')
        let answer
        try { answer = await questions.ask({ agent, signal, questions: [{
          id: HISTORY_QUESTION, header: '历史上下文',
          question: '旧上下文可能残留。请选择新建对话，或明确沿用这份历史。',
          detail: '此会话缺少可确认代际的鱼脑绑定。沿用会保留旧消息与摘要，不能视为干净新会话；确认仅对本会话当前鱼脑代际有效。',
          options: [
            { label: NEW_CONVERSATION, description: '请使用 DSH 原生新建会话；不复制旧消息或摘要。' },
            { label: CONTINUE_HISTORY, description: '接受旧上下文可能残留，并在当前代际继续本会话。' },
          ],
        }] }) } catch (error) {
          signal?.throwIfAborted()
          throw new Error('FISH_BRAIN_HISTORY_CHOICE_REQUIRED: 旧上下文可能残留；原生确认未完成，请新建对话或重新明确选择沿用历史。', { cause: error })
        }
        signal?.throwIfAborted()
        const choice = answer.answers?.find(item => item.id === HISTORY_QUESTION)
        if (choice?.selected?.length !== 1 || choice.selected[0] !== CONTINUE_HISTORY)
          throw new Error('FISH_BRAIN_NEW_CONVERSATION_REQUIRED: 未确认沿用历史；请使用 DSH 原生新建对话，不复制旧消息或摘要。')
        admission = 'history-confirmed'
      }
      // A human wait may span a switch. Its answer must never bind a new epoch.
      signal?.throwIfAborted()
      if (this.epoch !== epoch || this.mode !== mode || this.ctx.agentPresets.composedPreset(agent.ctx) !== 'fish')
        throw new Error('FISH_BRAIN_SWITCH_IN_PROGRESS: 确认期间鱼脑状态已变化，请重新检查当前会话边界')
      this.native.appendPluginRecord(session, BINDING, { epoch, admission,
        ...(admission === 'history-confirmed' ? { confirmedBy: 'user' } : {}) })
    }
    this.entries.set(agent, { epoch, mode, admission })
    return true
  }

  async shutdown() {
    await this.switchTo('disabled', false, true)
    await this.removeDefinition()
  }
}
