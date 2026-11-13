import { createHash } from 'node:crypto'
import { ExecutionContractError, assertNoRawSecrets, clone, deepFreeze, validatePlan, validateWorkerReport } from './contracts.mjs'
const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase()

export function createTickets(input) {
  const plan = validatePlan(input)
  const workers = new Map(plan.workers.map(worker => [worker.id, worker]))
  return plan.steps.map(step => {
    const worker = workers.get(step.workerId)
    return deepFreeze({
      schema: 'fish-execution-ticket-v1', ticketId: plan.taskId + ':' + step.id, taskId: plan.taskId, planVersion: plan.planVersion, stepId: step.id,
      workerId: step.workerId, workspace: worker.workspace, writeTargets: clone(worker.writeTargets), dependsOn: clone(step.dependsOn), capability: step.capability,
      action: step.action, target: step.target, inputs: clone(step.inputs ?? {}), phase: step.phase, riskLevel: plan.riskLevel, approval: clone(plan.approval),
      acceptanceCriteriaIds: clone(step.acceptanceCriteriaIds), budget: clone(step.budget), maxAttempts: step.maxAttempts, idempotent: Boolean(step.idempotent),
      recovery: typeof step.recovery === 'string' ? step.recovery : '', credentialRefs: clone(step.credentialRefs),
    })
  })
}

export function enforceBudget(ticket, usage) {
  const checks = [['wallTimeMs', 'maxWallTimeMs'], ['tokens', 'maxTokens'], ['cost', 'maxCost'], ['steps', 'maxSteps']]
  const exceeded = checks.filter(([used, max]) => Number(usage?.[used] ?? 0) > Number(ticket.budget[max])).map(([used]) => used)
  return exceeded.length ? { allowed: false, status: 'replan-request', exceeded } : { allowed: true, exceeded: [] }
}

export function buildResultPackage(ticket, reportInput, details = {}) {
  const report = validateWorkerReport(ticket, reportInput)
  const artifacts = (details.artifacts ?? []).map(item => {
    const path = String(item.path ?? '')
    if (!path) throw new ExecutionContractError('invalid-artifact', 'artifact path is required')
    const digest = item.sha256 || (typeof item.content === 'string' ? sha256(item.content) : '')
    if (!/^[A-F0-9]{64}$/i.test(digest)) throw new ExecutionContractError('invalid-artifact-hash', 'artifact sha256 is required')
    return { path, sha256: digest.toUpperCase() }
  })
  const result = {
    schema: 'fish-result-package-v1', resultPackageId: details.resultPackageId ?? 'result:' + ticket.ticketId + ':' + ticket.planVersion,
    taskId: ticket.taskId, planVersion: ticket.planVersion, ticketId: ticket.ticketId, stepId: ticket.stepId, workerId: ticket.workerId, status: report.status,
    artifacts, commands: clone(details.commands ?? []), tests: clone(details.tests ?? []), evidenceRefs: clone(report.evidenceRefs),
    evidenceByCriterion: clone(report.evidenceByCriterion ?? {}), unverified: clone(details.unverified ?? []), sideEffectState: details.sideEffectState ?? 'none', message: report.message,
  }
  assertNoRawSecrets(result)
  return deepFreeze(result)
}

export function collectResult(ticket, reportInput, details = {}) {
  const resultPackage = buildResultPackage(ticket, reportInput, details)
  return deepFreeze({
    schema: 'fish-execution-result-v1', taskId: ticket.taskId, planVersion: ticket.planVersion, status: resultPackage.status,
    startedAt: details.startedAt ?? new Date(0).toISOString(), finishedAt: details.finishedAt ?? new Date(1).toISOString(),
    stepResults: [{ stepId: ticket.stepId, status: resultPackage.status, attempts: details.attempts ?? 1, evidenceRefs: resultPackage.evidenceRefs, resultPackageId: resultPackage.resultPackageId, message: resultPackage.message }],
    evidenceRefs: resultPackage.evidenceRefs, resultPackageIds: [resultPackage.resultPackageId], summary: resultPackage.message, unverified: resultPackage.unverified,
    memoryCandidates: [], memoryWriteAuthorized: false,
  })
}

export function retryDecision(ticket, state) {
  const failures = Number(state.failures ?? 0)
  if (failures >= 2) return { action: 'replan-required', reason: 'same-path-failed-twice' }
  if (ticket.riskLevel === 'external-write' && state.sideEffectState === 'unknown') return { action: 'stop-unknown', reason: 'external-side-effect-unresolved' }
  const recoverable = ticket.idempotent || Boolean(ticket.recovery)
  if (!recoverable || ticket.maxAttempts < 2) return { action: 'replan-request', reason: 'retry-not-authorized' }
  return { action: 'retry-once', attempt: failures + 1 }
}
export function recoveryDecision(snapshot) {
  if (snapshot.sideEffectState === 'unknown') return { status: 'unknown', replay: false, reason: 'side-effect-unresolved' }
  if (snapshot.dispatched && !snapshot.finished && !snapshot.proofNotExecuted) return { status: 'unknown', replay: false, reason: 'dispatch-outcome-unresolved' }
  if (snapshot.proofNotExecuted && snapshot.localReversible) return { status: 'recoverable', replay: true }
  return { status: 'replan-required', replay: false }
}
export function failoverDecision(snapshot) {
  if (!snapshot.dispatched) return { allowed: true, reason: 'not-dispatched' }
  if (snapshot.sideEffectState === 'known-none') return { allowed: true, reason: 'proved-no-side-effect' }
  return { allowed: false, status: 'unknown', reason: 'must-reconcile-before-failover' }
}
export function cancelExecution(snapshot, evidenceRefs = []) { return deepFreeze({ ...clone(snapshot), status: 'cancelled', dispatchStopped: true, evidenceRefs: [...evidenceRefs] }) }

export function integrationOrder(tickets, packages) {
  const byTicket = new Map(packages.map(item => [item.ticketId, item]))
  const pending = new Map(tickets.map(item => [item.ticketId, item]))
  const ordered = [], written = []
  while (pending.size) {
    const ready = [...pending.values()].find(ticket => ticket.dependsOn.every(id => ordered.some(done => done.stepId === id)))
    if (!ready) throw new ExecutionContractError('dependency-cycle', 'tickets cannot be serially integrated')
    const result = byTicket.get(ready.ticketId)
    if (!result) throw new ExecutionContractError('missing-result-package', 'missing result package for ' + ready.ticketId)
    for (const target of ready.writeTargets) {
      const normalized = String(target).replace(/\\/g, '/').toLowerCase()
      if (written.some(item => item.workerId !== ready.workerId && (item.target === normalized || item.target.startsWith(normalized + '/') || normalized.startsWith(item.target + '/')))) throw new ExecutionContractError('integration-conflict', 'result packages from different workers share a write target')
      written.push({ target: normalized, workerId: ready.workerId })
    }
    ordered.push({ stepId: ready.stepId, ticketId: ready.ticketId, resultPackageId: result.resultPackageId })
    pending.delete(ready.ticketId)
  }
  return ordered
}
