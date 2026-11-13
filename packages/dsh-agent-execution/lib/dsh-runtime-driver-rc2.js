import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const EXPECTED_VERSION = '0.2.1-rc.2'
const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase()
const safeId = value => String(value).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120)
const now = () => new Date().toISOString()

export const WORKER_TOOL_NAMES = Object.freeze({
  read: 'fish_worker_workspace_read',
  write: 'fish_worker_workspace_write',
  list: 'fish_worker_workspace_list',
  hash: 'fish_worker_workspace_hash',
  nodeTest: 'fish_worker_node_test',
  submitReport: 'fish_worker_submit_report',
})

export const CAPABILITY_TOOL_MAP = Object.freeze({
  'worker.workspace.generate': Object.freeze(['write', 'read', 'hash', 'submitReport']),
  'worker.data.transform': Object.freeze(['read', 'write', 'hash', 'submitReport']),
  'worker.node.repair-test': Object.freeze(['read', 'write', 'nodeTest', 'hash', 'submitReport']),
})

const FORBIDDEN_PROMPT_MARKERS = /(?:mnemon|memory|mood|thinking|agents\.md|readme|relationship|persona)/i
const reasoningFor = _capability => 'low'

function relativePath(workspace, candidate = '.') {
  const raw = String(candidate || '.').replace(/\\/g, '/')
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw new Error('absolute paths are forbidden')
  const resolved = path.resolve(workspace, raw)
  const prefix = path.resolve(workspace) + path.sep
  if (resolved !== path.resolve(workspace) && !resolved.startsWith(prefix)) throw new Error('path escapes Worker workspace')
  return resolved
}

function listFiles(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) listFiles(root, full, output)
    else output.push(path.relative(root, full).replace(/\\/g, '/'))
  }
  return output.sort()
}

function runNodeTests(nodePath, workspace, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(nodePath, ['--test'], {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill()
      settled = true
      resolve({ command: 'node --test', exitCode: null, timedOut: true, wallTimeMs: Date.now() - started, stdout: stdout.slice(-12000), stderr: stderr.slice(-12000) })
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-24000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24000) })
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ command: 'node --test', exitCode: code, timedOut: false, wallTimeMs: Date.now() - started, stdout: stdout.slice(-12000), stderr: stderr.slice(-12000) })
    })
  })
}

export function summarizeProviderUsage(session) {
  const candidates = []
  const seen = new Set()
  const addUsage = usage => {
    if (!usage || typeof usage !== 'object' || seen.has(usage)) return
    seen.add(usage)
    const read = (...keys) => {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(usage, key)) continue
        const value = Number(usage[key])
        return Number.isFinite(value) && value >= 0 ? value : NaN
      }
      return 0
    }
    const inputTokens = read('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
    const outputTokens = read('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
    const cacheReadTokens = read('cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens')
    const cacheWriteTokens = read('cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens')
    const otherBillableTokens = read('otherBillableTokens', 'other_billable_tokens')
    const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + otherBillableTokens
    const hasTotal = ['totalTokens', 'total_tokens'].some(key => Object.prototype.hasOwnProperty.call(usage, key))
    const providerTotal = hasTotal ? read('totalTokens', 'total_tokens') : null
    const valid = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, otherBillableTokens].every(Number.isFinite)
      && (!hasTotal || (Number.isFinite(providerTotal) && providerTotal >= componentTotal))
    candidates.push({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, otherBillableTokens, componentTotal, providerTotal, hasTotal, valid })
  }
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.usage && typeof value.usage === 'object') addUsage(value.usage)
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child)
  }
  for (const event of session?.snapshotEvents?.() || []) {
    if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt' || event?.type === 'model/usage') visit(event.data)
  }
  const valid = candidates.filter(item => item.valid)
  if (valid.length === 0) return { tokenStatus: 'unknown', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, otherBillableTokens: null, totalTokens: null }
  const withProviderTotal = valid.filter(item => item.hasTotal)
  const selected = (withProviderTotal.length ? withProviderTotal : valid).at(-1)
  return {
    tokenStatus: 'known',
    inputTokens: selected.inputTokens, outputTokens: selected.outputTokens,
    cacheReadTokens: selected.cacheReadTokens, cacheWriteTokens: selected.cacheWriteTokens,
    otherBillableTokens: selected.otherBillableTokens,
    totalTokens: selected.hasTotal ? selected.providerTotal : selected.componentTotal,
  }
}

export function estimatedBillingSummary(ctx, session) {
  const state = ctx?.sessionProjections?.stateOf?.(session, 'cacheBilling')
  const totals = state?.totals
  const unknown = { estimatedCostStatus: 'unknown', estimatedCost: null, estimatedCostSource: null, estimatedCostVersion: null, costSemantics: 'estimated-non-authoritative', aggregateBillStatus: 'unknown' }
  if (!totals || !Array.isArray(state?.history) || state.history.length === 0) return unknown
  const values = [totals.cacheHitCost, totals.missCost, totals.outputCost].map(Number)
  if (!values.every(value => Number.isFinite(value) && value >= 0)) return unknown
  return { estimatedCostStatus: 'known', estimatedCost: values.reduce((sum, value) => sum + value, 0), estimatedCostSource: 'cacheBilling', estimatedCostVersion: String(state.version || 'legacy-unknown'), costSemantics: 'estimated-non-authoritative', aggregateBillStatus: 'unknown' }
}

function freezeAuthority(workspace, ticket) {
  if (ticket.capability === 'worker.workspace.generate') {
    const target = String(ticket.inputs?.targetPath || 'generated.txt')
    const content = String(ticket.inputs?.content || 'Fish isolated Worker acceptance fixture.\n')
    return { kind: 'file-hash', target, sha256: sha256(Buffer.from(content, 'utf8')) }
  }
  if (ticket.capability === 'worker.data.transform') {
    const input = JSON.parse(fs.readFileSync(path.join(workspace, 'input.json'), 'utf8'))
    const output = JSON.stringify([...input].sort((a, b) => a.id - b.id), null, 2) + '\n'
    return { kind: 'file-hash', target: String(ticket.inputs?.targetPath || 'output.json'), sha256: sha256(Buffer.from(output, 'utf8')) }
  }
  if (ticket.capability === 'worker.node.repair-test') {
    const content = 'export const sum = (a, b) => a + b\n'
    return { kind: 'node-test', target: 'src/sum.mjs', sha256: sha256(Buffer.from(content, 'utf8')) }
  }
  throw new Error('unsupported real Worker capability: ' + ticket.capability)
}

function evaluateAuthority(record) {
  const expected = record.authority
  const artifact = record.artifacts.get(expected.target)
  if (!artifact || artifact.sha256 !== expected.sha256) return { verdict: 'fail', reason: 'expected-artifact-hash-mismatch', evidenceRefs: [] }
  if (expected.kind === 'node-test') {
    const test = record.tests.at(-1)
    if (!test || test.exitCode !== 0 || test.timedOut) return { verdict: 'fail', reason: 'node-test-failed', evidenceRefs: [] }
  }
  return { verdict: 'pass', reason: 'frozen-authority-matched', evidenceRefs: [...record.evidenceRefs] }
}

function prepareFixture(workspace, ticket) {
  fs.mkdirSync(workspace, { recursive: true })
  if (ticket.capability === 'worker.data.transform') {
    const rows = [{ id: 3, name: 'gamma' }, { id: 1, name: 'alpha' }, { id: 2, name: 'beta' }]
    fs.writeFileSync(path.join(workspace, 'input.json'), JSON.stringify(rows, null, 2) + '\n', 'utf8')
  }
  if (ticket.capability === 'worker.node.repair-test') {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
    fs.mkdirSync(path.join(workspace, 'test'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fish-worker-toy', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(workspace, 'src', 'sum.mjs'), 'export const sum = (a, b) => a - b\n', 'utf8')
    fs.writeFileSync(path.join(workspace, 'test', 'sum.test.mjs'), "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { sum } from '../src/sum.mjs'\ntest('sum adds two numbers', () => assert.equal(sum(2, 3), 5))\n", 'utf8')
  }
}

function workerPrompt(ticket) {
  return JSON.stringify({
    schema: 'fish-real-worker-assignment-v2',
    ticket: {
      ticketId: ticket.ticketId, taskId: ticket.taskId, planVersion: ticket.planVersion, stepId: ticket.stepId,
      capability: ticket.capability, action: ticket.action, target: ticket.target, inputs: ticket.inputs,
      budget: ticket.budget, acceptanceCriteriaIds: ticket.acceptanceCriteriaIds,
      maxAttempts: ticket.maxAttempts, idempotent: ticket.idempotent,
    },
    allowedTools: CAPABILITY_TOOL_MAP[ticket.capability].map(key => WORKER_TOOL_NAMES[key]),
    rules: [
      'Use only the explicitly listed allowedTools.',
      'Operate only inside the assigned workspace.',
      'Do not delegate, access network, install packages, use git, or alter the Ticket.',
      'Do not infer or request persona, memory, mood, thinking, history, README, AGENTS, or the full plan.',
      'Call fish_worker_submit_report exactly once when finished or blocked.',
    ],
  })
}

export class DshRuntimeDriverRc2 {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    const stateDir = path.resolve(config.stateDir || 'D:/deepseek框架/鱼的大脑/脑区运行状态/执行')
    this.config = {
      ...config,
      stateDir,
      workerWorkspaceRoot: path.resolve(config.workerWorkspaceRoot || path.join(stateDir, 'worker-workspaces')),
    }
    this.id = 'dsh-runtime-driver-rc2'
    this.version = EXPECTED_VERSION
    this.active = new Map()
    this.messageModule = null
  }

  allowedToolsFor(ticket) {
    const keys = CAPABILITY_TOOL_MAP[ticket.capability]
    if (!keys) throw new Error('unsupported real Worker capability: ' + ticket.capability)
    const expanded = [...keys]
    if (ticket.inputs?.discoveryRequired === true && !expanded.includes('list')) expanded.splice(expanded.length - 1, 0, 'list')
    return expanded.map(key => WORKER_TOOL_NAMES[key])
  }

  assertToolBudget(record, toolName) {
    if (toolName === WORKER_TOOL_NAMES.submitReport) return
    const usage = summarizeProviderUsage(record.agent?.session)
    if (usage.tokenStatus === 'known' && usage.totalTokens > 25000) {
      if (!record.report) {
        record.report = { status: 'replan-request', message: 'Worker hard budget stop reached before ' + toolName }
        record.resolveReport(record.report)
      }
      throw new Error('Worker hard budget stop reached; no further tools are allowed')
    }
    if (usage.totalTokens >= 10500) throw new Error('Worker soft stop reached; submit the final report without another tool step')
  }

  async probeCapabilities() {
    const checks = {
      exactVersion: this.config.dshVersion === EXPECTED_VERSION,
      agentCreate: typeof this.ctx?.agents?.create === 'function',
      agentResolve: typeof this.ctx?.sessionController?.resolveAgent === 'function',
      sessionCreate: typeof this.ctx?.sessionController?.create === 'function',
      sessionCancel: typeof this.ctx?.sessionController?.cancel === 'function',
      workspaceCreate: typeof this.ctx?.workspaceRegistry?.create === 'function',
      events: typeof this.ctx?.on === 'function',
    }
    const available = Object.values(checks).every(Boolean)
    return {
      schema: 'fish-runtime-capability-report-v1', runtime: 'DSH', observedVersion: this.config.dshVersion,
      driverVersion: '1.0.0-fish.1', status: available ? 'available' : 'unavailable', realDispatch: available, checks,
      capabilities: ['probeCapabilities', 'createSession', 'deliverInput', 'cancel', 'readStatus', 'close'].map(id => ({ id, status: available ? 'available' : 'unavailable' })),
    }
  }

  async messageApi() {
    this.messageModule ??= import(this.config.dshLlmModulePath)
    return this.messageModule
  }

  registerWorkerTools(agentCtx, record) {
    const workspace = record.workspace
    const allowed = new Set(this.allowedToolsFor(record.ticket))
    record.allowedTools = [...allowed]
    record.toolDefinitionChars = 0
    const log = (tool, input, output) => {
      const item = { at: now(), tool, inputHash: sha256(JSON.stringify(input ?? {})), output }
      record.toolCalls.push(item)
      return item
    }
    const register = definition => {
      if (!allowed.has(definition.name)) return
      const execute = definition.execute
      const wrapped = { ...definition, execute: async args => { this.assertToolBudget(record, definition.name); return execute(args) } }
      record.toolDefinitionChars += JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length
      record.disposers.push(agentCtx.tools.register(wrapped))
    }
    const textOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

    register({
      name: 'fish_worker_workspace_read', description: 'Read one UTF-8 file inside the assigned Worker workspace.',
      parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } }, output: textOutput,
      execute: async args => {
        const file = relativePath(workspace, args.path)
        const value = fs.readFileSync(file, 'utf8')
        const output = { path: path.relative(workspace, file).replace(/\\/g, '/'), content: value, sha256: sha256(Buffer.from(value, 'utf8')) }
        log('read', { path: args.path }, { path: output.path, sha256: output.sha256 })
        return output
      },
    })
    register({
      name: 'fish_worker_workspace_write', description: 'Write one UTF-8 file inside the assigned Worker workspace.',
      parameters: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 20000 } } }, output: textOutput,
      execute: async args => {
        const file = relativePath(workspace, args.path)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, args.content, 'utf8')
        const digest = sha256(Buffer.from(args.content, 'utf8'))
        const relative = path.relative(workspace, file).replace(/\\/g, '/')
        const ref = 'evidence:' + record.ticket.ticketId + ':file:' + digest.slice(0, 16)
        record.evidenceRefs.add(ref)
        record.artifacts.set(relative, { path: relative, sha256: digest })
        log('write', { path: relative, contentHash: digest }, { path: relative, sha256: digest, evidenceRef: ref })
        return { path: relative, sha256: digest, evidenceRef: ref }
      },
    })
    register({
      name: 'fish_worker_workspace_list', description: 'List files inside the assigned Worker workspace.',
      parameters: { type: 'object', additionalProperties: false, properties: {} }, output: textOutput,
      execute: async args => { const files = listFiles(workspace); log('list', args, { count: files.length, files }); return { files } },
    })
    register({
      name: 'fish_worker_workspace_hash', description: 'Hash one file inside the assigned Worker workspace.',
      parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } }, output: textOutput,
      execute: async args => {
        const file = relativePath(workspace, args.path)
        const digest = sha256(fs.readFileSync(file))
        const relative = path.relative(workspace, file).replace(/\\/g, '/')
        const ref = 'evidence:' + record.ticket.ticketId + ':hash:' + digest.slice(0, 16)
        record.evidenceRefs.add(ref)
        record.artifacts.set(relative, { path: relative, sha256: digest })
        log('hash', { path: relative }, { sha256: digest, evidenceRef: ref })
        return { path: relative, sha256: digest, evidenceRef: ref }
      },
    })
    register({
      name: 'fish_worker_node_test', description: 'Run the fixed command node --test inside the assigned Worker workspace.',
      parameters: { type: 'object', additionalProperties: false, properties: {} }, output: textOutput,
      execute: async args => {
        const result = await runNodeTests(this.config.nodePath, workspace, Math.min(record.ticket.budget.maxWallTimeMs, 120000))
        const digest = sha256(JSON.stringify(result))
        const ref = 'evidence:' + record.ticket.ticketId + ':test:' + digest.slice(0, 16)
        record.evidenceRefs.add(ref)
        record.commands.push({ command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, wallTimeMs: result.wallTimeMs, outputHash: digest })
        record.tests.push({ name: 'node --test', exitCode: result.exitCode, timedOut: result.timedOut, outputHash: digest })
        log('node-test', args, { exitCode: result.exitCode, timedOut: result.timedOut, evidenceRef: ref, outputHash: digest })
        return { ...result, evidenceRef: ref, outputHash: digest }
      },
    })
    register({
      name: 'fish_worker_submit_report', description: 'Submit the final Worker status without changing the Ticket.',
      parameters: { type: 'object', additionalProperties: false, required: ['status', 'message'], properties: { status: { enum: ['blocked', 'replan-request', 'ready-for-review'] }, message: { type: 'string', maxLength: 1000 } } }, output: textOutput,
      execute: async args => {
        if (record.report) throw new Error('Worker report already submitted')
        if (args.status === 'ready-for-review' && record.evidenceRefs.size === 0) throw new Error('ready-for-review requires independently collected evidence')
        record.report = { status: args.status, message: args.message }
        log('submit-report', { status: args.status, messageHash: sha256(args.message) }, { accepted: true })
        record.resolveReport(record.report)
        return { accepted: true, status: args.status, concludesTurn: true }
      },
    })
  }

  async createSession(ticket, parentAgent) {
    const probe = await this.probeCapabilities()
    if (!probe.realDispatch) throw new Error('DSH rc.2 Runtime Driver capability probe failed')
    if (!parentAgent?.id) throw new Error('real dispatch requires a main-session parent Agent')
    const activeLimit = this.config.parallelWorkersEnabled === true ? Number(this.config.maximumWorkers || 2) : 1
    if (this.active.size >= activeLimit) throw new Error('real Worker active limit reached: ' + activeLimit)
    const sessionId = 'fish-exec-worker-' + safeId(ticket.ticketId)
    const workspace = path.resolve(this.config.workerWorkspaceRoot, safeId(ticket.ticketId))
    prepareFixture(workspace, ticket)
    const authority = freezeAuthority(workspace, ticket)
    await this.ctx.workspaceRegistry.create(workspace)
    let resolveReport
    const reportPromise = new Promise(resolve => { resolveReport = resolve })
    const record = {
      sessionId, ticket, workspace, createdAt: now(), parentSessionId: parentAgent.id,
      toolCalls: [], commands: [], tests: [], artifacts: new Map(), evidenceRefs: new Set(), disposers: [],
      report: null, resolveReport, reportPromise, handle: null, status: 'creating', transcriptDeletion: 'unsupported-rc2',
      authority, allowedTools: [], toolDefinitionChars: 0, promptAudit: null,
    }
    const parentOptions = parentAgent.options || {}
    const agentOptions = {
      ...(typeof parentOptions.provider === 'string' ? { provider: parentOptions.provider } : {}),
      ...(typeof parentOptions.model === 'string' ? { model: parentOptions.model } : {}),
      reasoningEffort: reasoningFor(ticket.capability),
      maxTokens: Math.min(25000, Math.max(1, Number(ticket.budget.maxTokens || 12000))),
    }
    const handle = await this.ctx.agents.create({
      sessionId, parentAgent,
      meta: { cwd: workspace, parentSession: parentAgent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions,
      setup: async agentCtx => {
        const inherited = agentCtx.tools?.schemas?.().map(item => item.name).filter(Boolean) || []
        if (inherited.length > 0) record.disposers.push(agentCtx.tools.restrict({ deny: inherited }))
        record.disposers.push(agentCtx.systemPrompt.suppressRuntimeContext())
        record.disposers.push(agentCtx.systemPrompt.section({
          name: 'deployment:persona-prefix',
          order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          complete: true, interpolate: false,
          text: 'Restricted Fish execution Worker. Execute exactly one immutable Ticket. Use only scoped fish_worker tools. Never plan, delegate, access network, address the user, or request broader context. Submit blocked, replan-request, or ready-for-review once.',
        }))
        this.registerWorkerTools(agentCtx, record)
        record.disposers.push(agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const assembled = await next()
          const tools = (assembled.tools || []).filter(item => record.allowedTools.includes(item.name))
          const sections = (assembled.sections || []).filter(item => item.name === 'deployment:persona-prefix')
          const contexts = (assembled.contexts || []).filter(item => item.required === true && item.name === 'fish:execution-worker-required')
          const promptText = [...sections, ...contexts].map(item => String(item.text || '')).join('\n')
          record.promptAudit = {
            systemPromptChars: promptText.length,
            systemPromptHash: sha256(promptText),
            toolDefinitionChars: JSON.stringify(tools).length,
            toolNames: tools.map(item => item.name),
            forbiddenMarkerDetected: FORBIDDEN_PROMPT_MARKERS.test(promptText),
          }
          return { ...assembled, sections, contexts, tools }
        }))
      },
    })
    record.handle = handle
    record.agent = handle.agent
    record.status = handle.agent.status
    this.active.set(sessionId, record)
    return { sessionId, workspace, parentSessionId: parentAgent.id, reasoningEffort: agentOptions.reasoningEffort }
  }

  async deliverInput(sessionId) {
    const record = this.active.get(sessionId)
    if (!record) throw new Error('unknown Worker session')
    const { createUserMessage } = await this.messageApi()
    const started = Date.now()
    record.status = 'running'
    record.agent.followup(createUserMessage({ content: [{ type: 'text', text: workerPrompt(record.ticket) }], source: { kind: 'user' } }))
    const timeout = new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), Math.min(record.ticket.budget.maxWallTimeMs, 120000)))
    const report = await Promise.race([record.reportPromise, timeout])
    if (report?.status === 'timeout') {
      record.agent.cancel({ kind: 'user' }, { keepInbox: false })
      record.status = 'timeout'
      return { status: 'replan-request', message: 'Worker exceeded maxWallTimeMs', timedOut: true, wallTimeMs: Date.now() - started }
    }
    await Promise.race([record.agent.whenIdle(), new Promise(resolve => setTimeout(resolve, 10000))])
    record.status = record.agent.status
    return { ...report, timedOut: false, wallTimeMs: Date.now() - started }
  }

  async cancel(sessionId) {
    const record = this.active.get(sessionId)
    if (!record) return { status: 'not-running' }
    record.agent.cancel({ kind: 'user' }, { keepInbox: false })
    record.status = 'cancelled'
    return { status: 'cancelled' }
  }

  async readStatus(sessionId) {
    const record = this.active.get(sessionId)
    if (!record) return { status: 'closed' }
    const usage = summarizeProviderUsage(record.agent.session)
    const billing = estimatedBillingSummary(this.ctx, record.agent.session)
    const authority = evaluateAuthority(record)
    return {
      status: record.agent.status, sessionId, workspace: record.workspace, usage: { ...usage, ...billing },
      toolCalls: record.toolCalls.map(item => ({ at: item.at, tool: item.tool, inputHash: item.inputHash, output: item.output })),
      commands: [...record.commands], tests: [...record.tests], artifacts: [...record.artifacts.values()], evidenceRefs: [...record.evidenceRefs],
      transcriptDeletion: record.transcriptDeletion, authority, promptAudit: record.promptAudit, allowedTools: [...record.allowedTools],
    }
  }

  async close(sessionId) {
    const record = this.active.get(sessionId)
    if (!record) return { status: 'closed', transcriptDeletion: 'not-applicable' }
    const status = await this.readStatus(sessionId)
    for (const dispose of record.disposers.reverse()) if (typeof dispose === 'function') dispose()
    await record.handle.dispose()
    this.active.delete(sessionId)
    return { ...status, status: 'closed', closedAt: now(), transcriptDeletion: 'unsupported-rc2-canary-only' }
  }

  cleanupWorkspace(workspace) { fs.rmSync(workspace, { recursive: true, force: true }) }
}

export const DRIVER_VERSION = '1.0.0-fish.1'
export const DSH_VERSION = EXPECTED_VERSION
