const REPORT_STATUSES = new Set(['blocked', 'replan-request', 'ready-for-review'])
const PHASES = new Set(['execute', 'prepare', 'commit'])
const RISKS = new Set(['observe', 'local-reversible', 'external-write', 'sensitive', 'forbidden'])
const RAW_SECRET_KEYS = /^(?:api[-_]?key|token|secret|password|credential)$/i

export class ExecutionContractError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ExecutionContractError'; this.code = code; this.details = details }
}

export const clone = value => structuredClone(value)
export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
const requiredString = (value, path) => {
  if (typeof value !== 'string' || !value.trim()) throw new ExecutionContractError('invalid-field', path + ' must be a non-empty string')
  return value
}
const requiredPositive = (value, path, allowZero = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (allowZero ? 0 : 1)) throw new ExecutionContractError('invalid-budget', path + ' must be a finite positive number')
  return value
}
export function assertNoRawSecrets(value, path = '$') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoRawSecrets(item, path + '[' + index + ']'))
  for (const [key, child] of Object.entries(value)) {
    if (RAW_SECRET_KEYS.test(key)) throw new ExecutionContractError('raw-credential', 'raw credential field is forbidden at ' + path + '.' + key)
    assertNoRawSecrets(child, path + '.' + key)
  }
}
export function validateBudget(budget, path = 'budget') {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new ExecutionContractError('invalid-budget', path + ' is required')
  requiredPositive(budget.maxWallTimeMs, path + '.maxWallTimeMs')
  requiredPositive(budget.maxTokens, path + '.maxTokens', true)
  requiredPositive(budget.maxCost, path + '.maxCost', true)
  requiredPositive(budget.maxSteps, path + '.maxSteps')
  return clone(budget)
}
const normalizeTarget = target => String(target).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

export function validatePlan(input) {
  const plan = clone(input)
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new ExecutionContractError('invalid-plan', 'plan must be an object')
  if (plan.schema !== 'fish-execution-plan-v1') throw new ExecutionContractError('invalid-schema', 'only fish-execution-plan-v1 is accepted')
  requiredString(plan.taskId, 'taskId')
  if (!Number.isInteger(plan.planVersion) || plan.planVersion < 1) throw new ExecutionContractError('invalid-plan-version', 'planVersion must be a positive integer')
  if (plan.sourceRegion !== '思考') throw new ExecutionContractError('wrong-authority', 'sourceRegion must be 思考')
  if (!RISKS.has(plan.riskLevel)) throw new ExecutionContractError('invalid-risk', 'unknown riskLevel')
  if (plan.riskLevel === 'forbidden') throw new ExecutionContractError('forbidden-plan', 'forbidden plans cannot be dispatched')
  if (!Array.isArray(plan.acceptanceCriteria) || !plan.acceptanceCriteria.length) throw new ExecutionContractError('missing-criteria', 'acceptanceCriteria is required')
  const criteriaIds = new Set()
  for (const [index, criterion] of plan.acceptanceCriteria.entries()) {
    requiredString(criterion?.id, 'acceptanceCriteria[' + index + '].id'); requiredString(criterion?.authority, 'acceptanceCriteria[' + index + '].authority'); requiredString(criterion?.description, 'acceptanceCriteria[' + index + '].description')
    if (criteriaIds.has(criterion.id)) throw new ExecutionContractError('duplicate-criterion-authority', 'acceptance criterion id must have one authority: ' + criterion.id)
    criteriaIds.add(criterion.id)
  }
  if (!Array.isArray(plan.workers) || plan.workers.length < 1 || plan.workers.length > 2) throw new ExecutionContractError('worker-limit', 'plans require one or two declared workers')
  const workerIds = new Set(), workspaces = new Set(), claimed = []
  for (const [index, worker] of plan.workers.entries()) {
    requiredString(worker?.id, 'workers[' + index + '].id'); requiredString(worker?.workspace, 'workers[' + index + '].workspace')
    if (workerIds.has(worker.id)) throw new ExecutionContractError('duplicate-worker', 'worker ids must be unique')
    const workspace = normalizeTarget(worker.workspace)
    if (workspaces.has(workspace)) throw new ExecutionContractError('shared-workspace', 'workers must use independent workspaces')
    workerIds.add(worker.id); workspaces.add(workspace)
    if (!Array.isArray(worker.writeTargets)) throw new ExecutionContractError('invalid-write-targets', 'worker writeTargets must be an array')
    for (const raw of worker.writeTargets) {
      const target = normalizeTarget(requiredString(raw, 'worker.writeTargets'))
      if (claimed.some(item => overlaps(item.target, target))) throw new ExecutionContractError('shared-write-target', 'workers may not share write targets')
      claimed.push({ workerId: worker.id, target })
    }
  }
  if (!Array.isArray(plan.steps) || !plan.steps.length) throw new ExecutionContractError('missing-steps', 'steps are required')
  const stepIds = new Set()
  for (const [index, step] of plan.steps.entries()) {
    requiredString(step?.id, 'steps[' + index + '].id')
    if (stepIds.has(step.id)) throw new ExecutionContractError('duplicate-step', 'step ids must be unique')
    stepIds.add(step.id)
    requiredString(step.capability, 'steps[' + index + '].capability'); requiredString(step.action, 'steps[' + index + '].action'); requiredString(step.target, 'steps[' + index + '].target'); requiredString(step.workerId, 'steps[' + index + '].workerId')
    if (!workerIds.has(step.workerId)) throw new ExecutionContractError('unknown-worker', 'step workerId is not declared')
    if (!PHASES.has(step.phase)) throw new ExecutionContractError('invalid-phase', 'step phase must be execute, prepare or commit')
    if (!Array.isArray(step.dependsOn)) throw new ExecutionContractError('invalid-dependencies', 'dependsOn must be an array')
    if (!Array.isArray(step.acceptanceCriteriaIds) || !step.acceptanceCriteriaIds.length) throw new ExecutionContractError('missing-step-criteria', 'each step must reference acceptance criteria')
    for (const id of step.acceptanceCriteriaIds) if (!criteriaIds.has(id)) throw new ExecutionContractError('unknown-criterion', 'step references unknown criterion: ' + id)
    validateBudget(step.budget, 'steps[' + index + '].budget')
    if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 2) throw new ExecutionContractError('invalid-attempts', 'maxAttempts must be 1 or 2')
    if (!Array.isArray(step.credentialRefs)) throw new ExecutionContractError('invalid-credential-refs', 'credentialRefs must be an array')
    for (const ref of step.credentialRefs) if (!/^(?:cred|cap):[a-z0-9._:-]+$/i.test(ref)) throw new ExecutionContractError('invalid-credential-ref', 'credentials must use cred: or cap: references')
    assertNoRawSecrets(step.inputs ?? {}, 'steps[' + index + '].inputs')
    if (step.phase === 'commit') {
      if (plan.approval?.status !== 'approved') throw new ExecutionContractError('commit-not-approved', 'commit requires approved plan authorization')
      if (!step.dependsOn.length) throw new ExecutionContractError('commit-without-prepare', 'commit must depend on a prepare step')
    }
  }
  for (const step of plan.steps) for (const dependency of step.dependsOn) {
    if (!stepIds.has(dependency)) throw new ExecutionContractError('unknown-dependency', 'unknown dependency: ' + dependency)
    if (dependency === step.id) throw new ExecutionContractError('self-dependency', 'step cannot depend on itself')
  }
  const stepsById = new Map(plan.steps.map(step => [step.id, step]))
  for (const step of plan.steps.filter(item => item.phase === 'commit')) {
    if (!step.dependsOn.some(id => stepsById.get(id)?.phase === 'prepare')) {
      throw new ExecutionContractError('commit-without-prepare', 'commit must depend on a prepare step')
    }
  }
  return deepFreeze(plan)
}

export function validateWorkerReport(ticket, input) {
  const report = clone(input)
  if (!report || report.schema !== 'fish-worker-report-v1') throw new ExecutionContractError('invalid-worker-report', 'worker report schema is invalid')
  const allowed = new Set(['schema', 'ticketId', 'taskId', 'planVersion', 'workerId', 'status', 'evidenceRefs', 'evidenceByCriterion', 'suggestion', 'message'])
  for (const key of Object.keys(report)) if (!allowed.has(key)) throw new ExecutionContractError('unexpected-worker-field', 'worker report contains unsupported field ' + key)
  if (report.taskId !== ticket.taskId || report.planVersion !== ticket.planVersion || report.workerId !== ticket.workerId || report.ticketId !== ticket.ticketId) throw new ExecutionContractError('worker-plan-mutation', 'worker report changed task, plan, worker or ticket identity')
  if (!REPORT_STATUSES.has(report.status)) throw new ExecutionContractError('invalid-worker-status', 'worker status is not allowed')
  assertNoRawSecrets(report)
  if (!Array.isArray(report.evidenceRefs)) throw new ExecutionContractError('invalid-evidence', 'evidenceRefs must be an array')
  if (report.status === 'ready-for-review') {
    const mapped = report.evidenceByCriterion
    if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) throw new ExecutionContractError('missing-authoritative-evidence', 'ready-for-review requires evidenceByCriterion')
    for (const id of ticket.acceptanceCriteriaIds) if (typeof mapped[id] !== 'string' || !mapped[id].trim()) throw new ExecutionContractError('missing-authoritative-evidence', 'missing evidence for criterion ' + id)
  }
  return deepFreeze(report)
}
