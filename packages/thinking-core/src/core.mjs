const LEVEL_RANK = Object.freeze({ small: 0, medium: 1, large: 2 })
const VERDICTS = new Set(['pass', 'fail', 'unknown'])
const WORKER_STATUSES = new Set(['blocked', 'replan-request', 'ready-for-review'])
const FINAL_STATUSES = new Set(['complete', 'failed', 'partial', 'unknown', 'cancelled'])
const STOP_SIDE_EFFECTS = new Set(['external-send', 'delete', 'production-switch', 'permission-change', 'irreversible'])
const PARALLEL_LIMITS = Object.freeze({
  workerEfficiencyTokens: 12000,
  workerMaxTokens: 25000,
  workerMaxCost: 0.08,
  totalEfficiencyTokens: 24000,
  totalMaxTokens: 50000,
  totalMaxCost: 0.16,
  minimumOverlapMs: 1000,
})

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' must be an object')
}

function textList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []
}

function unique(values) { return [...new Set(values)] }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}
function equal(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)) }
function normPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase() : ''
}
function pathsOverlap(a, b) {
  const left = normPath(a), right = normPath(b)
  return Boolean(left && right && (left === right || left.startsWith(right + '/') || right.startsWith(left + '/')))
}
function addError(errors, code, message) { errors.push({ code, message }) }
function budgetForOutput(budget) {
  return { maxWallTimeMs: budget.maxWallTimeMs, maxTokens: budget.maxTokens, maxCost: budget.maxCost, maxSteps: budget.maxSteps }
}

export function classifyTask(input = {}) {
  requireObject(input, 'task')
  const reasons = []
  let level = 'small'
  const raise = (next, reason) => {
    if (LEVEL_RANK[next] > LEVEL_RANK[level]) level = next
    reasons.push(reason)
  }
  const sideEffects = unique(textList(input.sideEffects))
  const stepCount = Number.isInteger(input.stepCount) ? input.stepCount : 1
  if (stepCount > 1 || input.localWrite || input.hasDependencies || input.requiresRollback) raise('medium', '存在多步骤、本地修改、依赖或回退要求')
  if (input.crossRegion || input.crossSystem || input.productionData || input.multipleDeliverables || input.irreversible || sideEffects.some((item) => STOP_SIDE_EFFECTS.has(item))) raise('large', '涉及跨区域/系统、生产数据、多交付物或高副作用')
  return { level, reasons: unique(reasons), sideEffects }
}

export function reconcileTaskLevel({ previousLevel, proposedLevel, newEvidence = [] }) {
  if (!(previousLevel in LEVEL_RANK) || !(proposedLevel in LEVEL_RANK)) throw new TypeError('task level must be small, medium, or large')
  if (LEVEL_RANK[proposedLevel] >= LEVEL_RANK[previousLevel]) return { accepted: true, level: proposedLevel, direction: LEVEL_RANK[proposedLevel] === LEVEL_RANK[previousLevel] ? 'same' : 'upgrade' }
  if (textList(newEvidence).length > 0) return { accepted: true, level: proposedLevel, direction: 'evidenced-downgrade', evidence: textList(newEvidence) }
  return { accepted: false, level: previousLevel, direction: 'rejected-downgrade', reason: '禁止无证据降级' }
}

export function validateCriterionAuthorities(criteria = []) {
  if (!Array.isArray(criteria) || criteria.length === 0) return { valid: false, errors: ['至少需要一个验收判据'] }
  const errors = [], seen = new Set()
  for (const criterion of criteria) {
    if (!criterion?.id || !criterion?.authority) { errors.push('每个验收判据必须有 id 和 authority'); continue }
    if (seen.has(criterion.id)) errors.push('验收判据只能有一个权威实现：' + criterion.id)
    else seen.add(criterion.id)
  }
  return { valid: errors.length === 0, errors }
}

export function reviewEvidence({ criteria = [], observations = [] } = {}) {
  const authorityCheck = validateCriterionAuthorities(criteria)
  if (!authorityCheck.valid) return { verdict: 'fail', criteria: [], errors: authorityCheck.errors }
  const byCriterion = new Map()
  for (const observation of observations) {
    if (!observation?.criterionId) continue
    const list = byCriterion.get(observation.criterionId) ?? []
    list.push(observation); byCriterion.set(observation.criterionId, list)
  }
  const results = criteria.map((criterion) => {
    const matching = (byCriterion.get(criterion.id) ?? []).filter((item) => item.authority === criterion.authority)
    if (matching.length === 0) return { id: criterion.id, authority: criterion.authority, verdict: 'unknown', reason: '没有来自权威实现的验收证据', evidence: [] }
    if (matching.some((item) => !VERDICTS.has(item.verdict))) return { id: criterion.id, authority: criterion.authority, verdict: 'unknown', reason: '证据 verdict 无法识别', evidence: [] }
    const evidence = matching.flatMap((item) => textList(item.evidence))
    if (matching.some((item) => item.verdict === 'fail')) return { id: criterion.id, authority: criterion.authority, verdict: 'fail', reason: '权威证据判定失败', evidence }
    if (matching.some((item) => item.verdict === 'unknown') || evidence.length === 0) return { id: criterion.id, authority: criterion.authority, verdict: 'unknown', reason: '权威证据不足或无法判定', evidence }
    return { id: criterion.id, authority: criterion.authority, verdict: 'pass', reason: '权威证据通过', evidence }
  })
  const verdict = results.some((item) => item.verdict === 'fail') ? 'fail' : results.some((item) => item.verdict === 'unknown') ? 'unknown' : 'pass'
  return { verdict, criteria: results, errors: [] }
}

export function decideUnknownAction({ verdict, sideEffects = [], reversible = false, isolated = false } = {}) {
  if (!VERDICTS.has(verdict)) throw new TypeError('verdict must be pass, fail, or unknown')
  if (verdict !== 'unknown') return { action: verdict === 'pass' ? 'continue' : 'stop', unverified: false }
  const effects = unique(textList(sideEffects))
  if (effects.some((item) => STOP_SIDE_EFFECTS.has(item))) return { action: 'stop', unverified: true, reason: 'unknown 遇到高副作用必须停止' }
  if (reversible && isolated) return { action: 'continue-with-unverified', unverified: true, reason: '仅允许隔离且可回退的本地步骤继续' }
  return { action: 'stop', unverified: true, reason: '未满足隔离且可回退条件' }
}

export function validateExecutionPlan(plan) {
  requireObject(plan, 'plan')
  const errors = []
  if (plan.schema !== 'fish-execution-plan-v1') errors.push('计划 schema 必须是 fish-execution-plan-v1')
  if (!Number.isInteger(plan.planVersion) || plan.planVersion < 1) errors.push('计划必须包含正整数 planVersion')
  if (plan.sourceRegion !== '思考') errors.push('思考层必须是计划唯一来源')
  const workers = Array.isArray(plan.workers) ? plan.workers : []
  if (workers.length > 2) errors.push('第一版最多允许两个 Worker')
  const ids = new Set(), workspaces = [], targets = []
  for (const worker of workers) {
    if (!worker?.id || ids.has(worker.id)) errors.push('Worker id 缺失或重复'); else ids.add(worker.id)
    if (!worker?.workspace || workspaces.some((item) => pathsOverlap(item, worker.workspace))) errors.push('并行 Worker 必须使用独立且非嵌套工作目录'); else workspaces.push(worker.workspace)
    for (const target of textList(worker?.writeTargets)) {
      if (targets.some((item) => pathsOverlap(item, target))) errors.push('并行 Worker 禁止写共享或嵌套目标：' + target); else targets.push(target)
    }
  }
  if (workers.length > 1 && plan.parallelAllowed !== true) errors.push('多 Worker 计划必须显式声明 parallelAllowed=true')
  if (workers.length > 1 && plan.conflictCheckBeforeMerge !== true) errors.push('并行计划必须在汇总前检查冲突')
  return { valid: errors.length === 0, errors }
}

function validateBudget(budget, errors, owner) {
  if (!budget || typeof budget !== 'object') { addError(errors, 'parallel.budget.missing', owner + ' 缺少独立预算'); return }
  if (budget.efficiencyTokenTarget !== PARALLEL_LIMITS.workerEfficiencyTokens) addError(errors, 'parallel.budget.efficiency-target', owner + ' Token 效率目标必须为 12000')
  if (budget.maxTokens !== PARALLEL_LIMITS.workerMaxTokens) addError(errors, 'parallel.budget.token-limit', owner + ' Token 硬停止线必须为 25000')
  if (budget.maxCost !== PARALLEL_LIMITS.workerMaxCost) addError(errors, 'parallel.budget.cost-limit', owner + ' 费用上限必须为 0.08')
  if (!(budget.maxWallTimeMs > 0)) addError(errors, 'parallel.budget.wall-time', owner + ' 必须有最长运行时间')
  if (!Number.isInteger(budget.maxSteps) || budget.maxSteps < 1) addError(errors, 'parallel.budget.steps', owner + ' 必须有最大步骤数')
}

export function validateParallelCandidate(candidate) {
  const errors = []
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { valid: false, status: 'replan-required', errorCode: 'parallel.candidate.invalid', errors: [{ code: 'parallel.candidate.invalid', message: 'parallelCandidate 必须是结构化对象' }], unverified: ['parallel-candidate'] }
  for (const field of ['candidateId', 'goal', 'taskId', 'createdAt']) if (typeof candidate[field] !== 'string' || !candidate[field].trim()) addError(errors, 'parallel.field.' + field, '缺少字段：' + field)
  if (!Number.isInteger(candidate.planVersion) || candidate.planVersion < 1) addError(errors, 'parallel.field.plan-version', 'planVersion 必须为正整数')
  if (!['medium', 'large'].includes(candidate.taskLevel)) addError(errors, 'parallel.field.task-level', '并行任务等级只能为 medium 或 large')
  if (candidate.riskLevel !== 'local-reversible') addError(errors, 'parallel.risk.not-local-reversible', 'V1 并行只允许 local-reversible')
  if (candidate.conflictCheckBeforeMerge !== true) addError(errors, 'parallel.conflict-check.required', '必须启用汇总前冲突检查')
  if (candidate.sharedMutableState !== false || textList(candidate.sharedResources).length > 0) addError(errors, 'parallel.shared-state.forbidden', '禁止共享可变状态或共享资源')
  if (candidate.delegationAllowed !== false) addError(errors, 'parallel.delegation.forbidden', 'Worker 不得再委派')
  if (candidate.retryPolicy !== 'none') addError(errors, 'parallel.retry.forbidden', '首次并行计划禁止自动重试')
  if (candidate.integrationOrder !== 'plan-order') addError(errors, 'parallel.integration.order', '结果只能按计划顺序串行集成')
  if (candidate.parallelEvidence?.minimumOverlapMs !== PARALLEL_LIMITS.minimumOverlapMs) addError(errors, 'parallel.overlap.required', '必须要求至少 1000ms 活动重叠')
  const criteria = Array.isArray(candidate.acceptanceCriteria) ? candidate.acceptanceCriteria : []
  const authority = validateCriterionAuthorities(criteria)
  if (!authority.valid) for (const message of authority.errors) addError(errors, 'parallel.criteria.invalid', message)
  if (!criteria.some((item) => item.id === 'parallel-overlap' && item.authority === 'execution.parallel-coordinator')) addError(errors, 'parallel.overlap.criterion', '缺少 parallel-overlap 权威验收判据')
  if (!Array.isArray(candidate.finalSuccessCriteria) || candidate.finalSuccessCriteria.length === 0) addError(errors, 'parallel.final-criteria.missing', '缺少最终成功判据')

  const workers = Array.isArray(candidate.workers) ? candidate.workers : []
  const steps = Array.isArray(candidate.steps) ? candidate.steps : []
  if (workers.length !== 2) addError(errors, 'parallel.worker.count', '必须恰好两个 Worker')
  if (steps.length !== 2) addError(errors, 'parallel.step.count', '必须恰好两个原子步骤')
  const workerIds = new Set(), workspaces = [], writeTargets = []
  for (const worker of workers) {
    if (!worker?.id || workerIds.has(worker.id)) addError(errors, 'parallel.worker.id', 'Worker id 缺失或重复'); else workerIds.add(worker.id)
    if (!worker?.workspace || workspaces.some((item) => pathsOverlap(item, worker.workspace))) addError(errors, 'parallel.workspace.conflict', 'Worker 工作目录必须独立且非嵌套'); else workspaces.push(worker.workspace)
    const targets = textList(worker?.writeTargets)
    if (targets.length === 0) addError(errors, 'parallel.write-target.missing', '每个 Worker 必须声明写目标')
    for (const target of targets) {
      if (writeTargets.some((item) => pathsOverlap(item, target))) addError(errors, 'parallel.write-target.conflict', '写目标冲突或嵌套：' + target)
      else writeTargets.push(target)
    }
    if (textList(worker?.permissions).length === 0) addError(errors, 'parallel.permissions.missing', '每个 Worker 必须声明独立权限')
    if (worker?.delegationAllowed !== false) addError(errors, 'parallel.worker.delegation', 'Worker 不得再委派')
    validateBudget(worker?.budget, errors, worker?.id || 'worker')
  }
  const stepWorkers = new Map()
  for (const step of steps) {
    if (!step?.id || !step?.workerId) { addError(errors, 'parallel.step.identity', '步骤必须有 id 和 workerId'); continue }
    stepWorkers.set(step.workerId, (stepWorkers.get(step.workerId) ?? 0) + 1)
    if (!workerIds.has(step.workerId)) addError(errors, 'parallel.step.worker', '步骤引用未知 Worker：' + step.workerId)
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length !== 0) addError(errors, 'parallel.step.dependency', '并行步骤不得存在依赖')
    if (step.phase !== 'execute') addError(errors, 'parallel.phase.forbidden', 'V1 并行只允许 execute 阶段')
    if (textList(step.sideEffects).length > 0) addError(errors, 'parallel.side-effect.forbidden', '并行步骤不得包含外部副作用')
    if (textList(step.credentialRefs).length > 0) addError(errors, 'parallel.credentials.forbidden', '首次并行验收不得使用凭据')
    if (step.maxAttempts !== 1) addError(errors, 'parallel.retry.max-attempts', '并行步骤 maxAttempts 必须为 1')
    if (step.idempotent !== true || typeof step.recovery !== 'string' || !step.recovery.trim()) addError(errors, 'parallel.recovery.required', '步骤必须幂等并声明恢复方法')
    if (!step.inputHash || !step.sourceHash) addError(errors, 'parallel.hash.required', '步骤必须声明输入哈希和来源哈希')
    if (textList(step.permissions).length === 0) addError(errors, 'parallel.step.permissions', '步骤必须声明权限')
    if (!Array.isArray(step.acceptanceCriteriaIds) || step.acceptanceCriteriaIds.length === 0) addError(errors, 'parallel.step.criteria', '步骤必须绑定验收判据')
    validateBudget(step.budget, errors, step.id || 'step')
    const worker = workers.find((item) => item.id === step.workerId)
    if (worker && (!equal(worker.permissions, step.permissions) || !equal(worker.budget, step.budget))) addError(errors, 'parallel.borrowing.forbidden', '步骤必须使用所属 Worker 的权限与预算，禁止借用')
  }
  for (const worker of workers) if (stepWorkers.get(worker.id) !== 1) addError(errors, 'parallel.worker.step-count', '每个 Worker 必须恰好拥有一个步骤')
  const totalTokens = workers.reduce((sum, item) => sum + Number(item?.budget?.maxTokens || 0), 0)
  const totalEfficiency = workers.reduce((sum, item) => sum + Number(item?.budget?.efficiencyTokenTarget || 0), 0)
  const totalCost = workers.reduce((sum, item) => sum + Number(item?.budget?.maxCost || 0), 0)
  if (totalTokens !== PARALLEL_LIMITS.totalMaxTokens) addError(errors, 'parallel.total.token-limit', '双 Worker Token 硬停止线合计必须为 50000')
  if (totalEfficiency !== PARALLEL_LIMITS.totalEfficiencyTokens) addError(errors, 'parallel.total.efficiency-target', '双 Worker Token 效率目标合计必须为 24000')
  if (Math.abs(totalCost - PARALLEL_LIMITS.totalMaxCost) > 1e-9) addError(errors, 'parallel.total.cost-limit', '双 Worker 费用上限合计必须为 0.16')
  const first = errors[0]
  return { valid: errors.length === 0, status: errors.length === 0 ? 'accepted' : 'replan-required', errorCode: first?.code ?? null, errors, unverified: errors.length === 0 ? [] : errors.map((item) => item.code) }
}

export function validateCarryForward(reference, current) {
  if (!reference) return { valid: true, reused: false, errors: [] }
  const errors = []
  if (!Number.isInteger(reference.fromPlanVersion) || reference.fromPlanVersion >= current.planVersion) errors.push('carryForward 必须引用更早的 planVersion')
  const checks = ['taskId', 'stepId', 'capability', 'action', 'target', 'inputHash', 'sourceHash']
  for (const field of checks) if (reference[field] !== current[field]) errors.push('carryForward 字段变化：' + field)
  for (const field of ['permissions', 'budget', 'acceptanceCriteriaIds']) if (!equal(reference[field], current[field])) errors.push('carryForward 字段变化：' + field)
  if (!Array.isArray(reference.evidenceRefs) || reference.evidenceRefs.length === 0) errors.push('carryForward 缺少权威证据引用')
  if (!['none', 'known-none'].includes(reference.sideEffectState)) errors.push('carryForward 副作用状态必须确定为无副作用')
  return { valid: errors.length === 0, reused: errors.length === 0, errors, status: errors.length === 0 ? 'accepted' : 'replan-required' }
}

export function buildParallelExecutionPlan(candidate) {
  const checked = validateParallelCandidate(candidate)
  if (!checked.valid) return checked
  const carryErrors = []
  for (const step of candidate.steps) {
    const result = validateCarryForward(step.carryForward, { taskId: candidate.taskId, planVersion: candidate.planVersion, stepId: step.id, capability: step.capability, action: step.action, target: step.target, inputHash: step.inputHash, sourceHash: step.sourceHash, permissions: step.permissions, budget: step.budget, acceptanceCriteriaIds: step.acceptanceCriteriaIds })
    if (!result.valid) for (const error of result.errors) carryErrors.push({ code: 'parallel.carry-forward.invalid', message: step.id + ': ' + error })
  }
  if (carryErrors.length) return { valid: false, status: 'replan-required', errorCode: carryErrors[0].code, errors: carryErrors, unverified: ['carry-forward'] }
  const workers = candidate.workers.map((worker) => ({ id: worker.id, workspace: worker.workspace, writeTargets: clone(worker.writeTargets) }))
  const steps = candidate.steps.map((step) => ({
    id: step.id,
    workerId: step.workerId,
    dependsOn: [],
    capability: step.capability,
    action: step.action,
    target: step.target,
    inputs: { ...clone(step.inputs ?? {}), permissions: clone(step.permissions), inputHash: step.inputHash, sourceHash: step.sourceHash, efficiencyTokenTarget: step.budget.efficiencyTokenTarget, carryForward: step.carryForward ? clone(step.carryForward) : null },
    phase: 'execute',
    acceptanceCriteriaIds: clone(step.acceptanceCriteriaIds),
    budget: budgetForOutput(step.budget),
    maxAttempts: 1,
    idempotent: true,
    recovery: step.recovery,
    credentialRefs: [],
  }))
  const plan = {
    schema: 'fish-execution-plan-v1',
    dispatchMode: candidate.dispatchMode === 'mock' ? 'mock' : 'real',
    taskId: candidate.taskId,
    planVersion: candidate.planVersion,
    createdAt: candidate.createdAt,
    sourceRegion: '思考',
    taskLevel: candidate.taskLevel,
    goal: candidate.goal,
    riskLevel: 'local-reversible',
    approval: { required: false, status: 'not-required', basis: '结构化本地隔离可回退双 Worker 计划' },
    acceptanceCriteria: clone(candidate.acceptanceCriteria),
    workers,
    steps,
    parallelAllowed: true,
    conflictCheckBeforeMerge: true,
    finalSuccessCriteria: clone(candidate.finalSuccessCriteria),
    notes: 'parallelCandidate=' + candidate.candidateId + '; minimumOverlapMs=1000; integrationOrder=plan-order; retryPolicy=none',
  }
  const planCheck = validateExecutionPlan(plan)
  if (!planCheck.valid) return { valid: false, status: 'replan-required', errorCode: 'parallel.plan.invalid', errors: planCheck.errors.map((message) => ({ code: 'parallel.plan.invalid', message })), unverified: ['execution-plan'] }
  return { valid: true, status: 'planned', mode: 'parallel', plan, limits: clone(PARALLEL_LIMITS), unverified: [] }
}

export function planExecution(input) {
  requireObject(input, 'plan input')
  if ('parallelCandidate' in input) return buildParallelExecutionPlan(input.parallelCandidate)
  return validateExecutionPlan(input)
}

export function evaluateParallelOutcome({ plan, results = [] } = {}) {
  requireObject(plan, 'plan')
  const byWorker = new Map(results.map((item) => [item.workerId, item]))
  const ordered = (plan.workers ?? []).map((worker) => byWorker.get(worker.id)).filter(Boolean)
  const unknown = ordered.some((item) => ['timeout', 'lost', 'unknown'].includes(item.condition) || item.sideEffectState === 'unknown')
  const ready = ordered.filter((item) => item.status === 'ready-for-review' && textList(item.evidenceRefs).length > 0)
  const failed = ordered.filter((item) => item.status === 'blocked' || item.status === 'replan-request' || ['timeout', 'lost', 'unknown'].includes(item.condition))
  if (ordered.length !== 2 || unknown) return { verdict: 'unknown', state: 'replan-required', integrationAllowed: false, cancelOther: ordered.some((item) => item.sideEffectState === 'unknown' || textList(item.sideEffects).some((effect) => STOP_SIDE_EFFECTS.has(effect))), reusableWorkerIds: ready.map((item) => item.workerId), integrationOrder: [] }
  if (failed.length > 0 || ready.length !== 2) return { verdict: failed.length > 0 ? 'fail' : 'unknown', state: 'replan-required', integrationAllowed: false, cancelOther: ordered.some((item) => textList(item.sideEffects).some((effect) => STOP_SIDE_EFFECTS.has(effect))), reusableWorkerIds: ready.map((item) => item.workerId), integrationOrder: [] }
  return { verdict: 'pass', state: 'ready-for-review', integrationAllowed: true, cancelOther: false, reusableWorkerIds: ready.map((item) => item.workerId), integrationOrder: plan.steps.map((step) => step.id) }
}

export function validateWorkerReport(report, plan) {
  requireObject(report, 'worker report'); requireObject(plan, 'plan')
  const errors = []
  if (!WORKER_STATUSES.has(report.status)) errors.push('Worker 状态只能是 blocked、replan-request 或 ready-for-review')
  if (report.taskId !== plan.taskId) errors.push('Worker taskId 与计划不一致')
  if (report.planVersion !== plan.planVersion) errors.push('Worker 不得改写计划版本')
  if ('goal' in report || 'steps' in report || 'scope' in report || 'permissions' in report || 'budget' in report || 'acceptanceCriteria' in report) errors.push('Worker 不得修改目标、范围、权限、预算、验收判据或计划步骤')
  return { valid: errors.length === 0, errors }
}

export function nextRetryState({ samePathFailureCount = 0 } = {}) {
  if (!Number.isInteger(samePathFailureCount) || samePathFailureCount < 0) throw new TypeError('samePathFailureCount must be a non-negative integer')
  return samePathFailureCount >= 2 ? { state: 'replan-required', allowSamePathRetry: false } : { state: 'retry-eligible', allowSamePathRetry: true }
}

export function decideFinalStatus({ cancelled = false, review, executionStatus } = {}) {
  if (cancelled) return { status: 'cancelled', mayClaimComplete: false }
  if (!review || !VERDICTS.has(review.verdict)) return { status: 'unknown', mayClaimComplete: false }
  if (review.verdict === 'unknown') return { status: executionStatus === 'partial' ? 'partial' : 'unknown', mayClaimComplete: false }
  if (review.verdict === 'fail') return { status: 'failed', mayClaimComplete: false }
  if (executionStatus && !['ready-for-review', 'succeeded'].includes(executionStatus)) return { status: executionStatus === 'partial' ? 'partial' : 'failed', mayClaimComplete: false }
  const hasEvidence = review.criteria?.length > 0 && review.criteria.every((item) => item.verdict === 'pass' && item.evidence?.length > 0)
  return hasEvidence ? { status: 'complete', mayClaimComplete: true } : { status: 'unknown', mayClaimComplete: false }
}

export function isFinalStatus(value) { return FINAL_STATUSES.has(value) }
export { PARALLEL_LIMITS }
