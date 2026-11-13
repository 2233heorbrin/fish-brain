import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { EOL } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

/* superagent 执行内核不随本仓库分发：默认 <repo>/vendor/superagent-engine-adapter，
   也可用 FISH_SUPERAGENT_ROOT 指向你的安装目录。 */
const SUPERAGENT_ROOT = (process.env.FISH_SUPERAGENT_ROOT
  || fileURLToPath(new URL('../../vendor/superagent-engine-adapter', import.meta.url))).replace(/[\\/]+$/, '')
const {
  AtomicTicketStore,
  buildResultPackage,
  createTickets,
  enforceBudget,
  runMockWorker,
  validateRuntimeDriver,
  validateWorkerReport,
} = await import('file://' + SUPERAGENT_ROOT.replace(/\\/g, '/') + '/src/index.mjs')
import {
  decideFinalStatus,
  reviewEvidence,
} from '../../thinking-core/src/index.mjs'
import { DshRuntimeDriverRc2 } from './dsh-runtime-driver-rc2.js'
import {
  detectResultConflicts,
  runParallelSessions,
  validateParallelPlan,
  writeIntegrationManifest,
} from './parallel-coordinator.js'

export const name = 'dsh-agent-execution'
export const inject = ['agents', 'sessionController', 'workspaceRegistry', 'tools', 'systemPrompt', 'sessionProjections']

export const CORE = Object.freeze({
  root: SUPERAGENT_ROOT,
  version: '1.0.0-fish.1',
  sha256: 'A3454A8B566FBBAF4B216E52D638948267AEC8D23884126D2734E2FB2CD1728A',
})

export const DEFAULTS = Object.freeze({
  executionEnabled: false,
  realWorkerEnabled: false,
  parallelWorkersEnabled: false,
  parallelMinOverlapMs: 1000,
  stateDir: process.env.FISH_EXECUTION_STATE_DIR || 'brain/脑区运行状态/执行',
  includeSubagents: false,
  maximumWorkers: 1,
  dshVersion: '0.2.1-rc.2',
  nodePath: process.env.FISH_NODE_PATH || process.execPath,
  dshLlmModulePath: process.env.FISH_DSH_LLM_MODULE || '',
})

const FORBIDDEN_STATE_KEYS = /^(?:originalMessage|rawMessage|conversation|fullConversation|personality|moodState|memoryContent|relationshipData|credential|apiKey|token|secret|password|cookie)$/i
const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase()
const safeId = value => String(value).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120)
const sessionIdOf = session => String(session?.id || session?.header?.id || '')
const isChildSession = session => Boolean(session?.header?.parentSession || session?.parentSession || session?.parent || sessionIdOf(session).startsWith('fish-exec-worker-'))
const REAL_ACCEPTANCE_SEQUENCE = Object.freeze(['worker.workspace.generate', 'worker.data.transform', 'worker.node.repair-test'])
const EFFICIENCY_TOKEN_TARGET = 12000
const SOFT_STOP_TOKENS = 10500
const HARD_STOP_TOKENS = 25000
const PARALLEL_EFFICIENCY_TOKEN_TARGET = 24000
const PARALLEL_HARD_STOP_TOKENS = 50000
const PARALLEL_MIN_OVERLAP_MS = 1000

function provesIsolatedLocalWrite(planInput, tickets) {
  const localReversible = planInput.riskLevel === 'local-reversible' && planInput.approval?.required === false
  const legacyApproved = planInput.riskLevel === 'external-write' && planInput.approval?.status === 'approved'
  if (!localReversible && !legacyApproved) return false
  if (tickets.some(ticket => ticket.phase === 'commit')) return false
  if (tickets.some(ticket => !REAL_ACCEPTANCE_SEQUENCE.includes(ticket.capability))) return false
  const allowedPrefix = 'workspaces/workers/'
  return tickets.every(ticket => {
    const worker = planInput.workers.find(item => item.id === ticket.workerId)
    const paths = [worker?.workspace, ...(worker?.writeTargets || [])].map(value => String(value || '').replace(/\\/g, '/'))
    return paths.length >= 2 && paths.every(value => value.startsWith(allowedPrefix) && !value.includes('..'))
  })
}

const budgetFile = (stateDir, acceptanceRunId) => path.join(stateDir, 'budget', safeId(acceptanceRunId) + '.jsonl')
function budgetEntries(stateDir, acceptanceRunId) {
  const file = budgetFile(stateDir, acceptanceRunId)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}
function appendBudgetEntry(stateDir, entry) {
  assertStateSafe(entry)
  const file = budgetFile(stateDir, entry.acceptanceRunId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + EOL, 'utf8')
}

function normalizedUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {}
  const read = (key, fallback = null) => {
    if (!Object.prototype.hasOwnProperty.call(usage, key)) return fallback
    const value = Number(usage[key])
    return Number.isFinite(value) && value >= 0 ? value : NaN
  }
  const inputTokens = read('inputTokens', 0)
  const outputTokens = read('outputTokens', 0)
  const cacheReadTokens = read('cacheReadTokens', 0)
  const cacheWriteTokens = read('cacheWriteTokens', 0)
  const otherBillableTokens = read('otherBillableTokens', 0)
  const components = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, otherBillableTokens]
  const componentTotal = components.reduce((sum, value) => sum + value, 0)
  const hasTotal = Object.prototype.hasOwnProperty.call(usage, 'totalTokens')
  const totalTokens = hasTotal ? read('totalTokens') : componentTotal
  const hasTokenEvidence = hasTotal || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'otherBillableTokens'].some(key => Object.prototype.hasOwnProperty.call(usage, key))
  const tokenKnown = usage.tokenStatus !== 'unknown' && hasTokenEvidence && components.every(Number.isFinite) && Number.isFinite(totalTokens) && totalTokens >= componentTotal
  const estimatedCostStatus = usage.estimatedCostStatus === 'known' || usage.costStatus === 'known' ? 'known' : 'unknown'
  const estimatedCostValue = Number(usage.estimatedCost ?? usage.cost)
  const estimatedCost = estimatedCostStatus === 'known' && Number.isFinite(estimatedCostValue) && estimatedCostValue >= 0 ? estimatedCostValue : null
  return {
    tokenStatus: tokenKnown ? 'known' : 'unknown',
    inputTokens: tokenKnown ? inputTokens : null,
    outputTokens: tokenKnown ? outputTokens : null,
    cacheReadTokens: tokenKnown ? cacheReadTokens : null,
    cacheWriteTokens: tokenKnown ? cacheWriteTokens : null,
    otherBillableTokens: tokenKnown ? otherBillableTokens : null,
    totalTokens: tokenKnown ? totalTokens : null,
    estimatedCostStatus: estimatedCost === null ? 'unknown' : 'known',
    estimatedCost,
    estimatedCostSource: estimatedCost === null ? null : String(usage.estimatedCostSource || 'legacy-cacheBilling'),
    estimatedCostVersion: estimatedCost === null ? null : String(usage.estimatedCostVersion || 'legacy-unknown'),
    costSemantics: 'estimated-non-authoritative',
    aggregateBillStatus: usage.aggregateBillStatus || 'unknown',
  }
}
export function inspectBudget(stateDir, filters = {}) {
  const root = path.join(path.resolve(stateDir), 'budget')
  if (!fs.existsSync(root)) return { schema: 'fish-execution-budget-summary-v1', runs: [] }
  const files = filters.acceptanceRunId ? [budgetFile(path.resolve(stateDir), filters.acceptanceRunId)] : fs.readdirSync(root).filter(name => name.endsWith('.jsonl')).map(name => path.join(root, name))
  const rows = files.filter(file => fs.existsSync(file)).flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)))
    .filter(row => !filters.ticketId || row.ticketId === filters.ticketId).filter(row => !filters.sessionId || row.workerSessionId === filters.sessionId)
  const byRun = new Map()
  for (const row of rows) {
    const run = byRun.get(row.acceptanceRunId) || { acceptanceRunId: row.acceptanceRunId, tickets: new Map() }
    run.tickets.set(row.ticketId, row)
    byRun.set(row.acceptanceRunId, run)
  }
  return { schema: 'fish-execution-budget-summary-v1', runs: [...byRun.values()].map(run => ({ acceptanceRunId: run.acceptanceRunId, tickets: [...run.tickets.values()] })) }
}

function diagnosticFor(error) {
  const reasonCode = safeId(error?.code || error?.name || 'REAL_DISPATCH_ERROR').toUpperCase() || 'REAL_DISPATCH_ERROR'
  const reasonDetail = String(error?.message || error || 'Unknown real dispatch error')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/(?:api[-_ ]?key|authorization|bearer|password|cookie|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted-value]')
    .slice(0, 500)
  return { reasonCode, reasonDetail }
}

function assertStateSafe(value, current = '$') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) return value.forEach((child, index) => assertStateSafe(child, current + '[' + index + ']'))
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_STATE_KEYS.test(key)) throw new Error('execution state forbids field ' + current + '.' + key)
    assertStateSafe(child, current + '.' + key)
  }
}

export function verifyCore() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORE.root, 'build-manifest.json'), 'utf8'))
  const lines = manifest.files.map(item => {
    const actual = sha256(fs.readFileSync(path.join(CORE.root, item.path)))
    if (actual !== item.sha256) throw new Error('execution core file hash mismatch: ' + item.path)
    return item.path + ' ' + actual
  })
  const treeHash = sha256(lines.join(EOL))
  if (treeHash !== manifest.treeSha256 || treeHash !== CORE.sha256) throw new Error('execution core tree SHA-256 mismatch: ' + treeHash)
  return treeHash
}

function reportFor(ticket, status, message) {
  return {
    schema: 'fish-worker-report-v1',
    ticketId: ticket.ticketId,
    taskId: ticket.taskId,
    planVersion: ticket.planVersion,
    workerId: ticket.workerId,
    status,
    evidenceRefs: [],
    evidenceByCriterion: {},
    message,
  }
}

function compactTicket(ticket) {
  return {
    ticketId: ticket.ticketId,
    stepId: ticket.stepId,
    workerId: ticket.workerId,
    phase: ticket.phase,
    capability: ticket.capability,
    budget: ticket.budget,
  }
}

function compactPackage(pkg) {
  return {
    resultPackageId: pkg.resultPackageId,
    ticketId: pkg.ticketId,
    stepId: pkg.stepId,
    status: pkg.status,
    artifactHashes: pkg.artifacts,
    evidenceRefs: pkg.evidenceRefs,
    unverified: pkg.unverified,
    sideEffectState: pkg.sideEffectState,
  }
}

function scenarioMode(input, stepId) {
  const perStep = input?.perStep?.[stepId]
  return typeof perStep === 'string' ? perStep : String(input?.mode || 'success')
}

export class ExecutionRuntime {
  constructor(config = {}, options = {}) {
    this.config = {...DEFAULTS, ...config}
    this.stateDir = path.resolve(this.config.stateDir)
    this.config.workerWorkspaceRoot = path.resolve(this.config.workerWorkspaceRoot || path.join(this.stateDir, 'worker-workspaces'))
    this.store = new AtomicTicketStore(path.join(this.stateDir, 'runtime.json'))
    this.coreHash = verifyCore()
    this.driver = options.driver ? validateRuntimeDriver(options.driver) : null
  }

  async submit(planInput, scenario = {}, parentAgent = null) {
    const dispatchMode = planInput?.dispatchMode === 'real' ? 'real' : 'mock'
    const parallel = planInput?.parallelAllowed === true
    if (parallel && dispatchMode === 'real') return this.submitParallelReal(planInput, parentAgent)
    if (parallel) return this.submitParallelMock(planInput, scenario)
    if (dispatchMode === 'real') return this.submitReal(planInput, parentAgent)
    return this.submitMock(planInput, scenario)
  }

  async submitMock(planInput, scenario = {}) {
    assertStateSafe(planInput)
    assertStateSafe(scenario)
    const tickets = createTickets(planInput)
    if (planInput.workers.length > this.config.maximumWorkers) throw new Error('Mock Canary currently allows one Worker only')
    const state = await this.store.load()
    const taskKey = planInput.taskId + ':v' + planInput.planVersion
    const existing = state.tasks?.[taskKey]
    if (existing) {
      return {
        schema: 'fish-execution-mock-submit-result-v1',
        restored: true,
        taskId: planInput.taskId,
        planVersion: planInput.planVersion,
        tickets: existing.tickets.map(compactTicket),
        resultPackageIds: [...existing.resultPackageIds],
        evidenceRefs: [...existing.evidenceRefs],
        reviewVerdict: existing.reviewVerdict,
        finalStatus: existing.finalStatus,
        mayClaimComplete: existing.mayClaimComplete,
      }
    }

    const transitions = [{state:'accepted', at:new Date().toISOString()}]
    const packages = []
    const observations = []
    const budgetUsage = {}

    if (scenario.mode === 'cancelled') {
      const review = reviewEvidence({criteria:planInput.acceptanceCriteria, observations:[]})
      const final = decideFinalStatus({cancelled:true, review, executionStatus:'cancelled'})
      const task = {plan:planInput,tickets,budgetUsage,transitions:[...transitions,{state:'cancelled',at:new Date().toISOString()}],resultPackageIds:[],evidenceRefs:[],artifactHashes:[],reviewVerdict:review.verdict,finalStatus:final.status,mayClaimComplete:final.mayClaimComplete}
      state.tasks ??= {}; state.tasks[taskKey] = task; await this.store.save(state)
      return {schema:'fish-execution-mock-submit-result-v1',restored:false,taskId:planInput.taskId,planVersion:planInput.planVersion,tickets:tickets.map(compactTicket),resultPackages:[],review,final}
    }

    for (const ticket of tickets) {
      const mode = scenarioMode(scenario, ticket.stepId)
      transitions.push({state:'ticket-dispatched',ticketId:ticket.ticketId,at:new Date().toISOString()})
      if (mode === 'plan-mutation') {
        const mutated = {...reportFor(ticket,'ready-for-review','Rejected mutated Worker report.'),planVersion:ticket.planVersion + 1}
        let code = 'worker-plan-mutation'
        try { validateWorkerReport(ticket, mutated) } catch (error) { code = error.code || code }
        transitions.push({state:'rejected',ticketId:ticket.ticketId,reason:code,at:new Date().toISOString()})
        continue
      }
      if (ticket.phase === 'commit') {
        const report = reportFor(ticket, 'blocked', 'Mock commit is unavailable.')
        const pkg = buildResultPackage(ticket, report, {unverified:['commit-unavailable'],sideEffectState:'not-started'})
        packages.push(pkg); transitions.push({state:'blocked',ticketId:ticket.ticketId,reason:'mock-commit-unavailable',at:new Date().toISOString()})
        continue
      }
      if (mode === 'budget-overrun') {
        const usage = {wallTimeMs:ticket.budget.maxWallTimeMs + 1,tokens:ticket.budget.maxTokens,cost:ticket.budget.maxCost,steps:ticket.budget.maxSteps}
        budgetUsage[ticket.ticketId] = usage
        const budget = enforceBudget(ticket, usage)
        const report = reportFor(ticket, budget.status, 'Mock budget exceeded: ' + budget.exceeded.join(','))
        const pkg = buildResultPackage(ticket, report, {unverified:budget.exceeded.map(item=>'budget:'+item),sideEffectState:'none'})
        packages.push(pkg); transitions.push({state:'replan-request',ticketId:ticket.ticketId,reason:'budget-exceeded',at:new Date().toISOString()})
        continue
      }
      if (mode === 'missing-evidence' || mode === 'blocked' || mode === 'unknown-side-effect') {
        const status = mode === 'blocked' ? 'blocked' : 'replan-request'
        const report = reportFor(ticket, status, mode === 'unknown-side-effect' ? 'Mock side effect is unknown.' : 'Mock evidence is unavailable.')
        const pkg = buildResultPackage(ticket, report, {unverified:[mode],sideEffectState:mode === 'unknown-side-effect' ? 'unknown' : 'none'})
        packages.push(pkg); transitions.push({state:status,ticketId:ticket.ticketId,reason:mode,at:new Date().toISOString()})
        continue
      }

      const worker = await runMockWorker(ticket, {status:'ready-for-review'})
      budgetUsage[ticket.ticketId] = worker.usage
      const budget = enforceBudget(ticket, worker.usage)
      if (!budget.allowed) throw new Error('unexpected Mock Worker budget overflow')
      const workspace = path.join(this.stateDir, 'workspaces', safeId(ticket.taskId), safeId(ticket.stepId))
      fs.mkdirSync(workspace, {recursive:true})
      const artifactPath = path.join(workspace, 'mock-result.json')
      const artifactContent = JSON.stringify({schema:'fish-mock-artifact-v1',taskId:ticket.taskId,planVersion:ticket.planVersion,stepId:ticket.stepId}) + '\n'
      fs.writeFileSync(artifactPath, artifactContent, 'utf8')
      const sideEffectState = mode === 'fail-evidence' ? 'known-none' : 'none'
      const pkg = buildResultPackage(ticket, worker.report, {artifacts:[{path:artifactPath,sha256:sha256(Buffer.from(artifactContent,'utf8'))}],commands:[{command:'mock-only',exitCode:mode === 'fail-evidence' ? 1 : 0}],tests:['isolated-mock'],sideEffectState})
      packages.push(pkg)
      for (const criterion of planInput.acceptanceCriteria) {
        const ref = pkg.evidenceByCriterion[criterion.id]
        if (ref) observations.push({criterionId:criterion.id,authority:criterion.authority,verdict:mode === 'fail-evidence' ? 'fail' : 'pass',evidence:[ref]})
      }
      transitions.push({state:'ready-for-review',ticketId:ticket.ticketId,at:new Date().toISOString()})
    }

    const review = reviewEvidence({criteria:planInput.acceptanceCriteria, observations})
    const executionStatus = packages.length === tickets.length && packages.every(item=>item.status === 'ready-for-review') ? 'ready-for-review' : 'partial'
    const final = decideFinalStatus({review, executionStatus})
    transitions.push({state:'thinking-reviewed',verdict:review.verdict,finalStatus:final.status,at:new Date().toISOString()})
    const evidenceRefs = [...new Set(packages.flatMap(item=>item.evidenceRefs))]
    const task = {
      plan: planInput,
      tickets,
      budgetUsage,
      transitions,
      resultPackageIds: packages.map(item=>item.resultPackageId),
      evidenceRefs,
      artifactHashes: packages.flatMap(item=>item.artifacts),
      reviewVerdict: review.verdict,
      finalStatus: final.status,
      mayClaimComplete: final.mayClaimComplete,
    }
    assertStateSafe(task)
    state.tasks ??= {}
    state.tasks[taskKey] = task
    await this.store.save(state)
    return {
      schema:'fish-execution-mock-submit-result-v1',
      restored:false,
      taskId:planInput.taskId,
      planVersion:planInput.planVersion,
      tickets:tickets.map(compactTicket),
      resultPackages:packages.map(compactPackage),
      review,
      final,
    }
  }

  async submitParallelMock(planInput, scenario = {}) {
    assertStateSafe(planInput)
    assertStateSafe(scenario)
    const tickets = createTickets(planInput)
    validateParallelPlan(planInput, tickets, this.config)
    const state = await this.store.load()
    const taskKey = planInput.taskId + ':v' + planInput.planVersion
    const existing = state.tasks?.[taskKey]
    if (existing) {
      return {
        schema: 'fish-execution-parallel-submit-result-v1', dispatchMode: 'mock', restored: true,
        taskId: planInput.taskId, planVersion: planInput.planVersion,
        tickets: existing.tickets.map(compactTicket), resultPackageIds: [...existing.resultPackageIds],
        evidenceRefs: [...existing.evidenceRefs], integrationManifest: existing.integrationManifest || null,
        reviewVerdict: existing.reviewVerdict, finalStatus: existing.finalStatus, mayClaimComplete: existing.mayClaimComplete,
      }
    }

    if (scenario.mode === 'cancelled') {
      const review = reviewEvidence({ criteria: planInput.acceptanceCriteria, observations: [] })
      const final = decideFinalStatus({ cancelled: true, review, executionStatus: 'cancelled' })
      const task = { plan: planInput, dispatchMode: 'mock', tickets, budgetUsage: {}, transitions: [{ state: 'accepted', dispatchMode: 'mock-parallel', at: new Date().toISOString() }, { state: 'cancelled', at: new Date().toISOString() }], parallelBatch: { readyBarrierPassed: false, overlapMs: 0, conflicts: [] }, sessionAudits: [], resultPackageIds: [], evidenceRefs: [], artifactHashes: [], integrationManifest: null, reviewVerdict: review.verdict, finalStatus: final.status, mayClaimComplete: final.mayClaimComplete }
      assertStateSafe(task); state.tasks ??= {}; state.tasks[taskKey] = task; await this.store.save(state)
      return { schema: 'fish-execution-parallel-submit-result-v1', dispatchMode: 'mock', restored: false, taskId: planInput.taskId, planVersion: planInput.planVersion, tickets: tickets.map(compactTicket), resultPackages: [], parallel: task.parallelBatch, review, final }
    }

    const transitions = [{ state: 'accepted', dispatchMode: 'mock-parallel', at: new Date().toISOString() }]
    const started = performance.now()
    const results = await Promise.all(tickets.map((ticket, index) => new Promise(resolve => {
      const start = performance.now()
      const delay = Number(scenario?.delays?.[ticket.stepId] || 30 + index * 10)
      setTimeout(async () => {
        const mode = scenarioMode(scenario, ticket.stepId)
        if (mode === 'blocked' || mode === 'missing-evidence' || mode === 'unknown-side-effect') {
          const status = mode === 'blocked' ? 'blocked' : 'replan-request'
          const report = reportFor(ticket, status, 'Parallel Mock injected ' + mode + '.')
          const pkg = buildResultPackage(ticket, report, { unverified: [mode], sideEffectState: mode === 'unknown-side-effect' ? 'unknown' : 'none' })
          return resolve({ ticket, pkg, start, finish: performance.now(), usage: { wallTimeMs: delay, tokens: 0, cost: 0, steps: 1 } })
        }
        const worker = await runMockWorker(ticket, { status: 'ready-for-review' })
        const workspace = path.join(this.stateDir, 'workspaces', safeId(ticket.taskId), safeId(ticket.stepId))
        fs.mkdirSync(workspace, { recursive: true })
        const artifactPath = mode === 'result-conflict'
          ? path.join(this.stateDir, 'workspaces', safeId(ticket.taskId), 'shared-result.json')
          : path.join(workspace, 'mock-result.json')
        const artifactContent = JSON.stringify({ schema: 'fish-parallel-mock-artifact-v1', taskId: ticket.taskId, stepId: ticket.stepId }) + '\n'
        fs.writeFileSync(artifactPath, artifactContent, 'utf8')
        const pkg = buildResultPackage(ticket, worker.report, {
          artifacts: [{ path: artifactPath, sha256: sha256(Buffer.from(artifactContent, 'utf8')) }],
          commands: [{ command: 'parallel-mock-only', exitCode: 0 }], tests: ['parallel-isolated-mock'], sideEffectState: 'none',
        })
        resolve({ ticket, pkg, start, finish: performance.now(), usage: worker.usage })
      }, delay)
    })))

    const packages = results.map(item => item.pkg)
    const conflicts = detectResultConflicts(packages)
    const observations = []
    for (const item of results) {
      if (item.pkg.status !== 'ready-for-review') continue
      for (const criterionId of item.ticket.acceptanceCriteriaIds) {
        const criterion = planInput.acceptanceCriteria.find(entry => entry.id === criterionId)
        const ref = item.pkg.evidenceByCriterion[criterionId]
        if (criterion && ref) observations.push({ criterionId, authority: criterion.authority, verdict: 'pass', evidence: [ref] })
      }
    }
    const overlapMs = Math.max(0, Math.min(...results.map(item => item.finish)) - Math.max(...results.map(item => item.start)))
    const allReady = packages.every(item => item.status === 'ready-for-review')
    const review = reviewEvidence({ criteria: planInput.acceptanceCriteria, observations })
    const executionStatus = allReady && conflicts.length === 0 ? 'ready-for-review' : 'partial'
    const final = decideFinalStatus({ review, executionStatus })
    if (!allReady || conflicts.length) transitions.push({ state: 'replan-required', reason: conflicts.length ? 'result-conflict' : 'parallel-worker-incomplete', at: new Date().toISOString() })
    transitions.push({ state: 'thinking-reviewed', verdict: review.verdict, finalStatus: final.status, at: new Date().toISOString() })
    const sessionAudits = results.map(item => ({
      sessionId: 'mock-parallel-' + safeId(item.ticket.ticketId), ticketId: item.ticket.ticketId,
      timeline: { firstExecutionEvent: item.start, finished: item.finish }, usage: item.usage,
    }))
    const integrationManifest = allReady && conflicts.length === 0
      ? writeIntegrationManifest({ stateDir: this.stateDir, plan: planInput, tickets, packages, sessionAudits, timeline: { overlapMs, batchDurationMs: performance.now() - started } })
      : null
    const evidenceRefs = [...new Set(packages.flatMap(item => item.evidenceRefs))]
    const budgetUsage = Object.fromEntries(results.map(item => [item.ticket.ticketId, item.usage]))
    const task = {
      plan: planInput, dispatchMode: 'mock', tickets, budgetUsage, transitions, parallelBatch: { readyBarrierPassed: true, overlapMs, conflicts }, sessionAudits,
      resultPackageIds: packages.map(item => item.resultPackageId), evidenceRefs, artifactHashes: packages.flatMap(item => item.artifacts),
      integrationManifest: integrationManifest && { id: integrationManifest.id, path: integrationManifest.path, sha256: integrationManifest.sha256 },
      reviewVerdict: review.verdict, finalStatus: final.status, mayClaimComplete: final.mayClaimComplete,
    }
    assertStateSafe(task)
    state.tasks ??= {}; state.tasks[taskKey] = task; await this.store.save(state)
    return {
      schema: 'fish-execution-parallel-submit-result-v1', dispatchMode: 'mock', restored: false,
      taskId: planInput.taskId, planVersion: planInput.planVersion, tickets: tickets.map(compactTicket),
      resultPackages: packages.map(compactPackage), parallel: { overlapMs, conflicts, integrationManifest: task.integrationManifest }, review, final,
    }
  }

  async submitParallelReal(planInput, parentAgent) {
    assertStateSafe(planInput)
    if (this.config.realWorkerEnabled !== true) throw new Error('real Worker dispatch is disabled')
    if (this.config.parallelWorkersEnabled !== true) throw new Error('parallel Worker dispatch is disabled')
    if (!this.driver) throw new Error('real Worker Runtime Driver is unavailable')
    if (!/^[a-z0-9][a-z0-9._-]{5,80}$/i.test(String(planInput.acceptanceRunId || ''))) throw new Error('parallel real dispatch requires a new acceptanceRunId')
    if (planInput.taskLevel === 'large' && planInput.approval?.status !== 'approved') throw new Error('large parallel real dispatch requires approved plan')
    const tickets = createTickets(planInput)
    validateParallelPlan(planInput, tickets, this.config)
    const allowedCapabilities = new Set(['worker.workspace.generate', 'worker.data.transform'])
    if (tickets.some(ticket => !allowedCapabilities.has(ticket.capability))) throw new Error('parallel real acceptance only permits file generation and JSON transform')
    if (tickets.some(ticket => ticket.phase === 'commit' || ticket.maxAttempts !== 1)) throw new Error('parallel real acceptance forbids commit and retry')
    if (tickets.some(ticket => ticket.budget.maxWallTimeMs > 120000 || ticket.budget.maxTokens > HARD_STOP_TOKENS)) throw new Error('parallel Ticket exceeds isolated budget ceiling')
    if (!provesIsolatedLocalWrite(planInput, tickets)) throw new Error('parallel real acceptance requires proven isolated Worker writes')
    const probe = await this.driver.probeCapabilities()
    if (!probe.realDispatch) throw new Error('Runtime Driver capability probe is unavailable')

    const state = await this.store.load()
    const taskKey = planInput.taskId + ':v' + planInput.planVersion
    const existing = state.tasks?.[taskKey]
    if (existing) {
      return {
        schema: 'fish-execution-parallel-submit-result-v1', dispatchMode: 'real', restored: true,
        taskId: planInput.taskId, planVersion: planInput.planVersion, tickets: existing.tickets.map(compactTicket),
        resultPackageIds: [...existing.resultPackageIds], evidenceRefs: [...existing.evidenceRefs],
        integrationManifest: existing.integrationManifest || null, reviewVerdict: existing.reviewVerdict,
        finalStatus: existing.finalStatus, mayClaimComplete: existing.mayClaimComplete,
      }
    }
    const priorRows = budgetEntries(this.stateDir, planInput.acceptanceRunId)
    if (priorRows.length) throw new Error('parallel acceptanceRunId must be unused')

    const transitions = [{ state: 'accepted', dispatchMode: 'real-parallel', acceptanceRunId: planInput.acceptanceRunId, at: new Date().toISOString() }]
    let batch
    try {
      batch = await runParallelSessions({ tickets, parentAgent, driver: this.driver, batchTimeoutMs: 150000 })
    } catch (error) {
      const diagnostic = diagnosticFor(error)
      const packages = tickets.map(ticket => buildResultPackage(ticket, reportFor(ticket, 'replan-request', 'Parallel ready barrier failed: ' + diagnostic.reasonCode), { unverified: ['parallel-barrier:' + diagnostic.reasonCode], sideEffectState: 'not-started' }))
      const review = reviewEvidence({ criteria: planInput.acceptanceCriteria, observations: [] })
      const final = decideFinalStatus({ review, executionStatus: 'partial' })
      transitions.push({ state: 'replan-required', reasonCode: diagnostic.reasonCode, reasonDetail: diagnostic.reasonDetail, createdSessions: error.createdSessions || [], at: new Date().toISOString() })
      const task = { plan: planInput, dispatchMode: 'real-parallel', tickets, budgetUsage: {}, transitions, parallelBatch: { readyBarrierPassed: false, overlapMs: 0 }, sessionAudits: [], resultPackageIds: packages.map(item => item.resultPackageId), evidenceRefs: [], artifactHashes: [], integrationManifest: null, reviewVerdict: review.verdict, finalStatus: final.status, mayClaimComplete: final.mayClaimComplete }
      assertStateSafe(task); state.tasks ??= {}; state.tasks[taskKey] = task; await this.store.save(state)
      return { schema: 'fish-execution-parallel-submit-result-v1', dispatchMode: 'real', restored: false, taskId: planInput.taskId, planVersion: planInput.planVersion, tickets: tickets.map(compactTicket), resultPackages: packages.map(compactPackage), parallel: task.parallelBatch, review, final }
    }

    const packages = [], observations = [], sessionAudits = [], budgetUsage = {}
    for (const item of batch.items) {
      const { ticket, session, delivered, status, error, timeline, closed } = item
      appendBudgetEntry(this.stateDir, {
        event: 'session-created', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId,
        taskId: ticket.taskId, ticketId: ticket.ticketId, stepId: ticket.stepId, capability: ticket.capability,
        workerSessionId: session.sessionId, triggerWork: ticket.capability, model: String(parentAgent?.options?.model || 'unknown'),
        provider: String(parentAgent?.options?.provider || 'unknown'), reasoningEffort: session.reasoningEffort, sessionCreated: true,
        monotonicReadyMs: timeline.ready,
      })
      if (error || !status) {
        const diagnostic = diagnosticFor(error || new Error('parallel Worker status unavailable'))
        const report = reportFor(ticket, 'replan-request', 'Parallel Worker requires replanning: ' + diagnostic.reasonCode)
        const pkg = buildResultPackage(ticket, report, { unverified: ['parallel-worker:' + diagnostic.reasonCode], sideEffectState: 'unknown' })
        packages.push(pkg)
        transitions.push({ state: 'replan-request', ticketId: ticket.ticketId, reasonCode: diagnostic.reasonCode, at: new Date().toISOString() })
        appendBudgetEntry(this.stateDir, { event: 'ticket-final', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId, taskId: ticket.taskId, ticketId: ticket.ticketId, stepId: ticket.stepId, capability: ticket.capability, workerSessionId: session.sessionId, triggerWork: ticket.capability, tokenStatus: 'unknown', totalTokens: null, estimatedCostStatus: 'unknown', estimatedCost: null, costSemantics: 'estimated-non-authoritative', aggregateBillStatus: 'unknown', workerStatus: 'replan-request', gateStatus: 'fail', stopReason: diagnostic.reasonCode, resultRef: pkg.resultPackageId })
        sessionAudits.push({ sessionId: session.sessionId, ticketId: ticket.ticketId, workspace: path.relative(this.stateDir, session.workspace).replace(/\\/g, '/'), timeline, usage: {}, toolCalls: [], transcriptDeletion: closed?.transcriptDeletion || 'unknown' })
        continue
      }
      const normalized = normalizedUsage(status.usage)
      const usage = { wallTimeMs: Number(delivered?.wallTimeMs || Math.max(0, timeline.finished - timeline.firstExecutionEvent)), ...normalized, tokens: normalized.totalTokens, steps: Number(status.toolCalls?.length || 0) }
      budgetUsage[ticket.ticketId] = usage
      const refs = [...new Set(status.evidenceRefs || [])]
      const bundleHash = sha256(JSON.stringify({ ticketId: ticket.ticketId, artifacts: status.artifacts, commands: status.commands, tests: status.tests, refs }))
      const bundleRef = 'evidence:' + ticket.ticketId + ':bundle:' + bundleHash.slice(0, 16)
      if (refs.length) refs.push(bundleRef)
      const allowedSet = new Set(status.allowedTools || [])
      const promptTools = status.promptAudit?.toolNames || []
      const promptIsolated = status.promptAudit && status.promptAudit.forbiddenMarkerDetected === false && promptTools.length === allowedSet.size && promptTools.every(name => allowedSet.has(name))
      let workerStatus = delivered?.status || 'replan-request'
      let message = delivered?.message || 'Parallel Worker did not submit a final report.'
      const unverified = []
      if (usage.tokenStatus !== 'known') { workerStatus = 'replan-request'; message = 'Provider Token usage is unknown or invalid.'; unverified.push('budget:token-unknown') }
      if (usage.tokenStatus === 'known' && usage.tokens > EFFICIENCY_TOKEN_TARGET && usage.tokens <= HARD_STOP_TOKENS) { workerStatus = 'replan-request'; message = 'Worker exceeded the 12000 Token efficiency target.'; unverified.push('budget:efficiency-budget-exceeded') }
      if (usage.tokenStatus === 'known' && usage.tokens > HARD_STOP_TOKENS) { workerStatus = 'replan-request'; message = 'Worker hard Token stop reached.'; unverified.push('budget:hard-token-stop') }
      if (!promptIsolated) { workerStatus = 'replan-request'; message = 'Worker Prompt Scope isolation was not proven.'; unverified.push('prompt-scope-unverified') }
      if (status.authority?.verdict !== 'pass') { workerStatus = 'replan-request'; message = 'Frozen execution authority did not pass.'; unverified.push('authority:' + String(status.authority?.reason || 'unknown')) }
      if (workerStatus === 'ready-for-review' && refs.length === 0) { workerStatus = 'replan-request'; message = 'Independent execution evidence is missing.'; unverified.push('missing-authoritative-evidence') }
      const evidenceByCriterion = workerStatus === 'ready-for-review' ? Object.fromEntries(ticket.acceptanceCriteriaIds.map(id => [id, bundleRef])) : {}
      const report = { schema: 'fish-worker-report-v1', ticketId: ticket.ticketId, taskId: ticket.taskId, planVersion: ticket.planVersion, workerId: ticket.workerId, status: workerStatus, evidenceRefs: refs, evidenceByCriterion, message }
      validateWorkerReport(ticket, report)
      const pkg = buildResultPackage(ticket, report, { artifacts: status.artifacts || [], commands: status.commands || [], tests: status.tests || [], unverified, sideEffectState: 'known-none' })
      packages.push(pkg)
      if (workerStatus === 'ready-for-review') for (const criterionId of ticket.acceptanceCriteriaIds) {
        const criterion = planInput.acceptanceCriteria.find(entry => entry.id === criterionId)
        observations.push({ criterionId, authority: criterion.authority, verdict: 'pass', evidence: [bundleRef] })
      }
      transitions.push({ state: workerStatus, ticketId: ticket.ticketId, sessionId: session.sessionId, at: new Date().toISOString() })
      const gateStatus = workerStatus === 'ready-for-review' ? 'pass' : 'partial'
      appendBudgetEntry(this.stateDir, { event: 'ticket-final', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId, taskId: ticket.taskId, ticketId: ticket.ticketId, stepId: ticket.stepId, capability: ticket.capability, workerSessionId: session.sessionId, triggerWork: ticket.capability, model: String(parentAgent?.options?.model || 'unknown'), provider: String(parentAgent?.options?.provider || 'unknown'), reasoningEffort: session.reasoningEffort, systemPromptChars: Number(status.promptAudit?.systemPromptChars || 0), toolDefinitionChars: Number(status.promptAudit?.toolDefinitionChars || 0), tokenStatus: usage.tokenStatus, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, otherBillableTokens: usage.otherBillableTokens, totalTokens: usage.tokens, estimatedCostStatus: usage.estimatedCostStatus, estimatedCost: usage.estimatedCost, estimatedCostSource: usage.estimatedCostSource, estimatedCostVersion: usage.estimatedCostVersion, costSemantics: usage.costSemantics, aggregateBillStatus: usage.aggregateBillStatus, toolCallCount: usage.steps, wallTimeMs: usage.wallTimeMs, warnings: [], stopReason: unverified[0] || null, workerStatus, gateStatus, resultRef: pkg.resultPackageId, promptIsolated, authorityVerdict: status.authority?.verdict || 'unknown', monotonicFirstExecutionMs: timeline.firstExecutionEvent, monotonicFinishedMs: timeline.finished })
      sessionAudits.push({ sessionId: session.sessionId, ticketId: ticket.ticketId, parentSessionRef: sha256(String(session.parentSessionId)).slice(0, 16), workspace: path.relative(this.stateDir, session.workspace).replace(/\\/g, '/'), timeline, usage, toolCalls: (status.toolCalls || []).map(call => ({ at: call.at, tool: call.tool, inputHash: call.inputHash, output: call.output })), promptAudit: status.promptAudit, allowedTools: status.allowedTools, authority: status.authority, transcriptDeletion: closed?.transcriptDeletion || 'unknown', closedAt: closed?.closedAt || new Date().toISOString() })
    }

    const totals = {
      tokens: Object.values(budgetUsage).reduce((sum, usage) => sum + Number(usage.tokens || 0), 0),
      tokenKnown: Object.values(budgetUsage).length === 2 && Object.values(budgetUsage).every(usage => usage.tokenStatus === 'known'),
      estimatedCostKnown: Object.values(budgetUsage).length === 2 && Object.values(budgetUsage).every(usage => usage.estimatedCostStatus === 'known'),
      estimatedCost: Object.values(budgetUsage).reduce((sum, usage) => sum + Number(usage.estimatedCost || 0), 0),
    }
    const conflicts = detectResultConflicts(packages)
    const overlapPassed = batch.overlapMs >= Number(this.config.parallelMinOverlapMs || PARALLEL_MIN_OVERLAP_MS)
    const overlapCriterion = planInput.acceptanceCriteria.find(entry => entry.id === 'parallel-overlap')
    const overlapRef = overlapCriterion ? 'evidence:' + planInput.taskId + ':parallel-overlap:' + sha256(JSON.stringify({ overlapMs: batch.overlapMs, minimumOverlapMs: Number(this.config.parallelMinOverlapMs || PARALLEL_MIN_OVERLAP_MS) })).slice(0, 16) : null
    if (overlapCriterion) observations.push({ criterionId: overlapCriterion.id, authority: overlapCriterion.authority, verdict: overlapPassed ? 'pass' : 'fail', evidence: overlapRef ? [overlapRef] : [] })
    const aggregatePassed = totals.tokenKnown && totals.tokens <= PARALLEL_EFFICIENCY_TOKEN_TARGET && totals.tokens <= PARALLEL_HARD_STOP_TOKENS
    const allReady = packages.length === 2 && packages.every(item => item.status === 'ready-for-review')
    const canIntegrate = allReady && overlapPassed && aggregatePassed && conflicts.length === 0
    if (!canIntegrate) transitions.push({ state: 'replan-required', reason: conflicts.length ? 'result-conflict' : !overlapPassed ? 'parallel-overlap' : !aggregatePassed ? 'parallel-budget' : 'parallel-worker-incomplete', at: new Date().toISOString() })
    const review = reviewEvidence({ criteria: planInput.acceptanceCriteria, observations })
    const final = decideFinalStatus({ review, executionStatus: canIntegrate ? 'ready-for-review' : 'partial' })
    transitions.push({ state: 'thinking-reviewed', verdict: review.verdict, finalStatus: final.status, at: new Date().toISOString() })
    const integration = canIntegrate ? writeIntegrationManifest({ stateDir: this.stateDir, plan: planInput, tickets, packages, sessionAudits, timeline: { overlapMs: batch.overlapMs, batchDurationMs: batch.batchFinished - batch.batchStarted } }) : null
    const evidenceRefs = [...new Set([...packages.flatMap(item => item.evidenceRefs), ...(overlapRef ? [overlapRef] : [])])]
    const task = { plan: planInput, dispatchMode: 'real-parallel', tickets, budgetUsage, transitions, parallelBatch: { readyBarrierPassed: batch.readyBarrierPassed, overlapMs: batch.overlapMs, overlapPassed, aggregateBudget: totals, conflicts }, sessionAudits, resultPackageIds: packages.map(item => item.resultPackageId), evidenceRefs, artifactHashes: packages.flatMap(item => item.artifacts), integrationManifest: integration && { id: integration.id, path: integration.path, sha256: integration.sha256 }, reviewVerdict: review.verdict, finalStatus: final.status, mayClaimComplete: final.mayClaimComplete }
    assertStateSafe(task); state.tasks ??= {}; state.tasks[taskKey] = task; await this.store.save(state)
    appendBudgetEntry(this.stateDir, { event: 'parallel-batch-final', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId, taskId: planInput.taskId, ticketId: 'parallel-batch', tokenStatus: totals.tokenKnown ? 'known' : 'unknown', totalTokens: totals.tokens, estimatedCostStatus: totals.estimatedCostKnown ? 'known' : 'unknown', estimatedCost: totals.estimatedCostKnown ? totals.estimatedCost : null, costSemantics: 'estimated-non-authoritative', aggregateBillStatus: 'unknown', overlapMs: batch.overlapMs, gateStatus: canIntegrate ? 'pass' : 'partial', stopReason: canIntegrate ? null : transitions.at(-2)?.reason || 'parallel-unverified', integrationManifestId: task.integrationManifest?.id || null })
    return { schema: 'fish-execution-parallel-submit-result-v1', dispatchMode: 'real', restored: false, taskId: planInput.taskId, planVersion: planInput.planVersion, tickets: tickets.map(compactTicket), resultPackages: packages.map(compactPackage), workerSessions: sessionAudits.map(item => ({ sessionId: item.sessionId, ticketId: item.ticketId, usage: item.usage, timeline: item.timeline })), parallel: task.parallelBatch, integrationManifest: task.integrationManifest, review, final }
  }

  async submitReal(planInput, parentAgent) {
    assertStateSafe(planInput)
    if (this.config.realWorkerEnabled !== true) throw new Error('real Worker dispatch is disabled')
    if (!this.driver) throw new Error('real Worker Runtime Driver is unavailable')
    if (planInput.dispatchMode !== 'real') throw new Error('real dispatch requires explicit plan.dispatchMode=real')
    if (!/^[a-z0-9][a-z0-9._-]{5,80}$/i.test(String(planInput.acceptanceRunId || ''))) throw new Error('real dispatch requires a new acceptanceRunId')
    if (planInput.taskLevel === 'large' && planInput.approval?.status !== 'approved') throw new Error('large real dispatch requires approved plan')
    if (planInput.workers?.length !== 1) throw new Error('real Canary permits exactly one declared Worker')
    const probe = await this.driver.probeCapabilities()
    if (!probe.realDispatch) throw new Error('Runtime Driver capability probe is unavailable')
    const tickets = createTickets(planInput)
    const isolatedRiskProof = provesIsolatedLocalWrite(planInput, tickets)
    if (!['observe', 'local-reversible'].includes(planInput.riskLevel) && !isolatedRiskProof) throw new Error('real Canary only permits observe, local-reversible, or proven isolated Worker writes')
    if (tickets.length !== 1) throw new Error('real acceptance requires exactly one atomic Ticket per plan')
    const state = await this.store.load()
    const taskKey = planInput.taskId + ':v' + planInput.planVersion
    const existing = state.tasks?.[taskKey]
    if (existing) {
      return {
        schema: 'fish-execution-submit-result-v1', dispatchMode: 'real', restored: true,
        taskId: planInput.taskId, planVersion: planInput.planVersion,
        tickets: existing.tickets.map(compactTicket), resultPackageIds: [...existing.resultPackageIds],
        evidenceRefs: [...existing.evidenceRefs], reviewVerdict: existing.reviewVerdict,
        finalStatus: existing.finalStatus, mayClaimComplete: existing.mayClaimComplete,
      }
    }
    const priorRows = budgetEntries(this.stateDir, planInput.acceptanceRunId)
    const createdTickets = [...new Set(priorRows.filter(row => row.event === 'session-created').map(row => row.ticketId))]
    const priorFinals = priorRows.filter(row => row.event === 'ticket-final')
    if (createdTickets.length >= REAL_ACCEPTANCE_SEQUENCE.length) throw new Error('acceptanceRunId has exhausted its three real Ticket allowance')
    if (priorFinals.length > 0 && priorFinals.at(-1).gateStatus !== 'pass') throw new Error('stop-on-first-failure: previous Ticket did not pass')
    if (tickets[0].capability !== REAL_ACCEPTANCE_SEQUENCE[createdTickets.length]) throw new Error('real acceptance capability order mismatch')
    const transitions = [{ state: 'accepted', dispatchMode: 'real', acceptanceRunId: planInput.acceptanceRunId, effectiveRisk: isolatedRiskProof ? 'local-reversible' : planInput.riskLevel, riskProof: isolatedRiskProof ? 'isolated-worker-paths-and-capability' : 'declared-risk', at: new Date().toISOString() }]
    const packages = [], observations = [], sessionAudits = [], budgetUsage = {}, workspaces = []
    for (const ticket of tickets) {
      if (ticket.phase === 'commit') {
        const report = reportFor(ticket, 'blocked', 'Real commit is unavailable in isolated single-Worker Canary.')
        const pkg = buildResultPackage(ticket, report, { unverified: ['commit-unavailable'], sideEffectState: 'not-started' })
        packages.push(pkg)
        transitions.push({ state: 'blocked', ticketId: ticket.ticketId, reason: 'commit-unavailable', at: new Date().toISOString() })
        continue
      }
      if (ticket.budget.maxWallTimeMs > 120000 || ticket.budget.maxTokens > HARD_STOP_TOKENS || ticket.maxAttempts > 2) {
        const report = reportFor(ticket, 'replan-request', 'Ticket exceeds isolated real Worker budget ceiling.')
        const pkg = buildResultPackage(ticket, report, { unverified: ['budget-ceiling'], sideEffectState: 'none' })
        packages.push(pkg)
        transitions.push({ state: 'replan-request', ticketId: ticket.ticketId, reason: 'budget-ceiling', at: new Date().toISOString() })
        continue
      }

      let session = null
      try {
        transitions.push({ state: 'ticket-dispatched', ticketId: ticket.ticketId, at: new Date().toISOString() })
        session = await this.driver.createSession(ticket, parentAgent)
        workspaces.push(session.workspace)
        appendBudgetEntry(this.stateDir, {
          event: 'session-created', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId,
          taskId: ticket.taskId, ticketId: ticket.ticketId, stepId: ticket.stepId, capability: ticket.capability,
          workerSessionId: session.sessionId, triggerWork: ticket.capability, model: String(parentAgent?.options?.model || 'unknown'),
          provider: String(parentAgent?.options?.provider || 'unknown'), reasoningEffort: session.reasoningEffort, sessionCreated: true,
        })
        const delivered = await this.driver.deliverInput(session.sessionId)
        const status = await this.driver.readStatus(session.sessionId)
        const normalized = normalizedUsage(status.usage)
        const usage = { wallTimeMs: Number(delivered.wallTimeMs || 0), ...normalized, tokens: normalized.totalTokens, steps: Number(status.toolCalls?.length || 0) }
        budgetUsage[ticket.ticketId] = usage
        const refs = [...new Set(status.evidenceRefs || [])]
        const bundleHash = sha256(JSON.stringify({ ticketId: ticket.ticketId, artifacts: status.artifacts, commands: status.commands, tests: status.tests, refs }))
        const bundleRef = 'evidence:' + ticket.ticketId + ':bundle:' + bundleHash.slice(0, 16)
        if (refs.length) refs.push(bundleRef)
        let workerStatus = delivered.status
        let message = delivered.message || 'Worker did not submit a final report.'
        const unverified = []
        const warnings = []
        const initialTokenEstimate = Math.ceil((Number(status.promptAudit?.systemPromptChars || 0) + Number(status.promptAudit?.toolDefinitionChars || 0) + JSON.stringify(compactTicket(ticket)).length) / 4)
        if (initialTokenEstimate > 6000) warnings.push({ code: 'initial-token-estimate', threshold: 6000, actual: initialTokenEstimate, action: 'continue-with-warning' })
        if (usage.tokenStatus === 'known' && usage.tokens >= SOFT_STOP_TOKENS) warnings.push({ code: 'soft-token-stop', threshold: SOFT_STOP_TOKENS, actual: usage.tokens, action: 'no-new-tools-final-report' })
        const allowedSet = new Set(status.allowedTools || [])
        const promptTools = status.promptAudit?.toolNames || []
        const promptIsolated = status.promptAudit && status.promptAudit.forbiddenMarkerDetected === false && promptTools.length === allowedSet.size && promptTools.every(name => allowedSet.has(name))
        if (usage.tokenStatus !== 'known') { workerStatus = 'replan-request'; message = 'Provider Token usage is unknown or invalid.'; unverified.push('budget:token-unknown') }
        if (usage.tokenStatus === 'known' && usage.tokens > HARD_STOP_TOKENS) { workerStatus = 'replan-request'; message = 'Worker hard Token stop reached.'; unverified.push('budget:hard-token-stop') }
        if (!promptIsolated) { workerStatus = 'replan-request'; message = 'Worker Prompt Scope isolation was not proven.'; unverified.push('prompt-scope-unverified') }
        if (status.authority?.verdict !== 'pass') { workerStatus = 'replan-request'; message = 'Frozen execution authority did not pass.'; unverified.push('authority:' + String(status.authority?.reason || 'unknown')) }
        if (usage.tokenStatus === 'known' && usage.tokens > EFFICIENCY_TOKEN_TARGET && usage.tokens <= HARD_STOP_TOKENS) { workerStatus = 'replan-request'; message = 'Functional result exceeded the 12000 Token efficiency target.'; unverified.push('budget:efficiency-budget-exceeded') }
        if (workerStatus === 'ready-for-review' && refs.length === 0) { workerStatus = 'replan-request'; message = 'Independent execution evidence is missing.'; unverified.push('missing-authoritative-evidence') }
        const evidenceByCriterion = workerStatus === 'ready-for-review'
          ? Object.fromEntries(ticket.acceptanceCriteriaIds.map(id => [id, bundleRef])) : {}
        const report = {
          schema: 'fish-worker-report-v1', ticketId: ticket.ticketId, taskId: ticket.taskId,
          planVersion: ticket.planVersion, workerId: ticket.workerId, status: workerStatus,
          evidenceRefs: refs, evidenceByCriterion, message,
        }
        validateWorkerReport(ticket, report)
        const pkg = buildResultPackage(ticket, report, {
          artifacts: status.artifacts || [], commands: status.commands || [], tests: status.tests || [],
          unverified, sideEffectState: 'known-none',
        })
        packages.push(pkg)
        if (workerStatus === 'ready-for-review') {
          for (const criterionId of ticket.acceptanceCriteriaIds) {
            const criterion = planInput.acceptanceCriteria.find(item => item.id === criterionId)
            observations.push({ criterionId, authority: criterion.authority, verdict: 'pass', evidence: [bundleRef] })
          }
        }
        transitions.push({ state: workerStatus, ticketId: ticket.ticketId, sessionId: session.sessionId, at: new Date().toISOString() })
        const gateStatus = workerStatus === 'ready-for-review' && usage.tokenStatus === 'known' && usage.tokens <= EFFICIENCY_TOKEN_TARGET && promptIsolated && status.authority?.verdict === 'pass' ? 'pass' : 'partial'
        appendBudgetEntry(this.stateDir, {
          event: 'ticket-final', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId,
          taskId: ticket.taskId, ticketId: ticket.ticketId, stepId: ticket.stepId, capability: ticket.capability,
          workerSessionId: session.sessionId, triggerWork: ticket.capability, model: String(parentAgent?.options?.model || 'unknown'),
          provider: String(parentAgent?.options?.provider || 'unknown'), reasoningEffort: session.reasoningEffort,
          systemPromptChars: Number(status.promptAudit?.systemPromptChars || 0), toolDefinitionChars: Number(status.promptAudit?.toolDefinitionChars || 0),
          tokenStatus: usage.tokenStatus, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens, otherBillableTokens: usage.otherBillableTokens, totalTokens: usage.tokens,
          estimatedCostStatus: usage.estimatedCostStatus, estimatedCost: usage.estimatedCost, estimatedCostSource: usage.estimatedCostSource,
          estimatedCostVersion: usage.estimatedCostVersion, costSemantics: usage.costSemantics, aggregateBillStatus: usage.aggregateBillStatus,
          toolCallCount: usage.steps, wallTimeMs: usage.wallTimeMs, warnings,
          stopReason: unverified[0] || null, workerStatus, gateStatus, resultRef: pkg.resultPackageId, promptIsolated, authorityVerdict: status.authority?.verdict || 'unknown',
        })
        const closed = await this.driver.close(session.sessionId)
        sessionAudits.push({
          sessionId: session.sessionId, ticketId: ticket.ticketId, parentSessionRef: sha256(String(session.parentSessionId)).slice(0, 16),
          workspace: path.relative(this.stateDir, session.workspace).replace(/\\/g, '/'), usage,
          toolCalls: (status.toolCalls || []).map(item => ({ at: item.at, tool: item.tool, inputHash: item.inputHash, output: item.output })),
          promptAudit: status.promptAudit, allowedTools: status.allowedTools, authority: status.authority,
          transcriptDeletion: closed.transcriptDeletion, closedAt: closed.closedAt,
        })
        session = null
      } catch (error) {
        const { reasonCode, reasonDetail } = diagnosticFor(error)
        if (session?.sessionId) {
          await this.driver.cancel(session.sessionId).catch(() => {})
          const status = await this.driver.readStatus(session.sessionId).catch(() => ({ status: 'unknown' }))
          const closed = await this.driver.close(session.sessionId).catch(() => ({ status: 'unknown', transcriptDeletion: 'unknown' }))
          sessionAudits.push({ sessionId: session.sessionId, ticketId: ticket.ticketId, workspace: path.relative(this.stateDir, session.workspace).replace(/\\/g, '/'), usage: status.usage || {}, toolCalls: status.toolCalls || [], transcriptDeletion: closed.transcriptDeletion })
        }
        const report = reportFor(ticket, 'replan-request', 'Real Worker dispatch requires replanning: ' + reasonCode + ': ' + reasonDetail)
        const pkg = buildResultPackage(ticket, report, { unverified: ['real-dispatch-error:' + sha256(reasonCode + ':' + reasonDetail).slice(0, 16)], sideEffectState: 'unknown' })
        packages.push(pkg)
        transitions.push({ state: 'replan-request', ticketId: ticket.ticketId, reasonCode, reasonDetail, reasonHash: sha256(reasonCode + ':' + reasonDetail), at: new Date().toISOString() })
        if (session?.sessionId) appendBudgetEntry(this.stateDir, { event: 'ticket-final', timestamp: new Date().toISOString(), acceptanceRunId: planInput.acceptanceRunId, taskId: ticket.taskId, ticketId: ticket.ticketId, stepId: ticket.stepId, capability: ticket.capability, workerSessionId: session.sessionId, triggerWork: ticket.capability, tokenStatus: 'unknown', totalTokens: null, estimatedCostStatus: 'unknown', estimatedCost: null, costSemantics: 'estimated-non-authoritative', aggregateBillStatus: 'unknown', workerStatus: 'replan-request', gateStatus: 'fail', stopReason: reasonCode, resultRef: pkg.resultPackageId })
        break
      }
    }

    const review = reviewEvidence({ criteria: planInput.acceptanceCriteria, observations })
    const executionStatus = packages.length === tickets.length && packages.every(item => item.status === 'ready-for-review') ? 'ready-for-review' : 'partial'
    const final = decideFinalStatus({ review, executionStatus })
    transitions.push({ state: 'thinking-reviewed', verdict: review.verdict, finalStatus: final.status, at: new Date().toISOString() })
    const evidenceRefs = [...new Set(packages.flatMap(item => item.evidenceRefs))]
    const task = {
      plan: planInput, dispatchMode: 'real', tickets, budgetUsage, transitions, sessionAudits,
      resultPackageIds: packages.map(item => item.resultPackageId), evidenceRefs,
      artifactHashes: packages.flatMap(item => item.artifacts), reviewVerdict: review.verdict,
      finalStatus: final.status, mayClaimComplete: final.mayClaimComplete,
    }
    assertStateSafe(task)
    state.tasks ??= {}
    state.tasks[taskKey] = task
    await this.store.save(state)
    if (final.status === 'complete') for (const workspace of workspaces) this.driver.cleanupWorkspace(workspace)
    return {
      schema: 'fish-execution-submit-result-v1', dispatchMode: 'real', restored: false,
      taskId: planInput.taskId, planVersion: planInput.planVersion, tickets: tickets.map(compactTicket),
      resultPackages: packages.map(compactPackage), workerSessions: sessionAudits.map(item => ({ sessionId: item.sessionId, ticketId: item.ticketId, usage: item.usage, transcriptDeletion: item.transcriptDeletion })),
      review, final,
    }
  }
}

export const TOOL_NAME = 'execution_submit_plan'
export function toolDefinition(runtime) {
  return {
    name: TOOL_NAME,
    description: 'Submit the exact fish-execution-plan-v1 already published in agent:thinking. Copy plan unchanged. For real acceptance, also provide the execution-owned acceptanceRunId; it is metadata and is not written back into the thinking plan. Real mode permits one isolated DSH Worker, or exactly two independent Workers when the separate parallel switch is enabled; it never permits commit, production, network, arbitrary shell, or shared files.',
    parameters: {
      type:'object',
      additionalProperties:false,
      required:['plan'],
      properties:{
        plan:{type:'object',description:'Exact fish-execution-plan-v1 published by the thinking layer.'},
        scenario:{type:'object',description:'Optional isolated acceptance scenario.',additionalProperties:true},
        acceptanceRunId:{type:'string',description:'Execution-owned second-run identifier. Required only when plan.dispatchMode is real.',minLength:6,maxLength:81},
      },
    },
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:async(args,execution)=>{
      if (isChildSession(execution?.agent?.session)) throw new Error('execution_submit_plan is restricted to the main session')
      const submittedPlan = args.plan?.dispatchMode === 'real' ? { ...args.plan, acceptanceRunId: args.acceptanceRunId } : args.plan
      return runtime.submit(submittedPlan,args.scenario ?? {},execution?.agent)
    },
    presentCall:()=>({card:'generic',title:'Submit isolated Fish execution plan',kind:'edit'}),
    presentResult:()=>({card:'generic',title:'Execution evidence ready'}),
  }
}

export function apply(ctx, config = {}) {
  const cfg = {...DEFAULTS,...config}
  if (cfg.executionEnabled !== true) return
  const driver = new DshRuntimeDriverRc2(ctx, cfg)
  const runtime = new ExecutionRuntime(cfg, {driver})
  const installed = new Map()
  const install = agent => {
    if (!agent?.ctx?.tools || installed.has(agent) || (!cfg.includeSubagents && isChildSession(agent.session))) return
    const dispose = agent.ctx.tools.register(toolDefinition(runtime))
    installed.set(agent, typeof dispose === 'function' ? dispose : ()=>{})
  }
  const uninstall = agent => { const dispose=installed.get(agent); if(!dispose)return; installed.delete(agent); dispose() }
  for (const agent of ctx.agents.list() || []) install(agent)
  const stopCreated = ctx.on('agent/created',({agent})=>install(agent))
  const stopDisposed = ctx.on('agent/disposed',({agent})=>uninstall(agent))
  return ()=>{ stopDisposed?.(); stopCreated?.(); for(const agent of [...installed.keys()])uninstall(agent) }
}

export default {name,inject,apply}
