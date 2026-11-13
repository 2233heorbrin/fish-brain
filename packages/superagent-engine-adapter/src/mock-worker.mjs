import { ExecutionContractError, deepFreeze } from './contracts.mjs'
export function minimalWorkerContext(ticket, input = {}) {
  return deepFreeze({ ticket, capabilityContract: input.capabilityContract ?? null, authorizedFiles: Array.isArray(input.authorizedFiles) ? [...input.authorizedFiles] : [], summary: typeof input.summary === 'string' ? input.summary : '' })
}
export async function runMockWorker(ticket, scenario = {}) {
  if (ticket.phase === 'commit') throw new ExecutionContractError('mock-commit-unavailable', 'Mock Worker cannot execute commit tickets')
  const context = minimalWorkerContext(ticket, scenario.context)
  const status = scenario.status ?? 'ready-for-review'
  const evidenceByCriterion = Object.fromEntries(ticket.acceptanceCriteriaIds.map(id => [id, 'evidence:mock:' + ticket.ticketId + ':' + id]))
  const report = {
    schema: 'fish-worker-report-v1', ticketId: ticket.ticketId, taskId: ticket.taskId, planVersion: ticket.planVersion, workerId: ticket.workerId, status,
    evidenceRefs: status === 'ready-for-review' ? Object.values(evidenceByCriterion) : [], evidenceByCriterion: status === 'ready-for-review' ? evidenceByCriterion : {},
    message: scenario.message ?? 'Mock Worker completed the authorized offline fixture.',
  }
  return { context, report, usage: scenario.usage ?? { wallTimeMs: 1, tokens: 0, cost: 0, steps: 1 } }
}
