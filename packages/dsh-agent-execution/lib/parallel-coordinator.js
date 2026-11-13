import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase()
const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
const safeId = value => String(value).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120)

export function pathsConflict(left, right) {
  const a = normalize(left)
  const b = normalize(right)
  return Boolean(a && b && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')))
}

export function validateParallelPlan(plan, tickets, config = {}) {
  if (config.parallelWorkersEnabled !== true) throw new Error('parallel Worker dispatch is disabled')
  if (Number(config.maximumWorkers) !== 2) throw new Error('parallel Worker dispatch requires maximumWorkers=2')
  if (plan.parallelAllowed !== true) throw new Error('parallel plan requires parallelAllowed=true')
  if (plan.conflictCheckBeforeMerge !== true) throw new Error('parallel plan requires conflictCheckBeforeMerge=true')
  if (plan.workers?.length !== 2 || tickets.length !== 2 || plan.steps?.length !== 2) throw new Error('parallel plan requires exactly two Workers and two atomic steps')
  if (tickets.some(ticket => (ticket.dependsOn || []).length !== 0)) throw new Error('parallel first version forbids step dependencies')
  if (new Set(tickets.map(ticket => ticket.workerId)).size !== 2) throw new Error('parallel steps require distinct Workers')
  const criterionOwners = new Map()
  for (const ticket of tickets) {
    if (!(ticket.acceptanceCriteriaIds || []).length) throw new Error('parallel ticket requires an acceptance criterion')
    for (const criterionId of ticket.acceptanceCriteriaIds) {
      if (criterionOwners.has(criterionId)) throw new Error('parallel tickets require distinct authoritative criteria')
      criterionOwners.set(criterionId, ticket.ticketId)
    }
  }
  for (const ticket of tickets) {
    const worker = plan.workers.find(item => item.id === ticket.workerId)
    if (!worker) throw new Error('parallel ticket has no declared Worker: ' + ticket.ticketId)
    if (normalize(worker.workspace) !== normalize(ticket.workspace)) throw new Error('parallel ticket workspace differs from declared Worker')
  }
  for (let left = 0; left < plan.workers.length; left += 1) {
    for (let right = left + 1; right < plan.workers.length; right += 1) {
      const a = plan.workers[left]
      const b = plan.workers[right]
      const aPaths = [a.workspace, ...(a.writeTargets || [])]
      const bPaths = [b.workspace, ...(b.writeTargets || [])]
      if (aPaths.some(first => bPaths.some(second => pathsConflict(first, second)))) throw new Error('parallel Worker workspaces or write targets conflict')
    }
  }
  return true
}

async function closeCreated(driver, created, cancel = false) {
  await Promise.allSettled(created.map(async item => {
    if (cancel) await driver.cancel(item.session.sessionId).catch(() => {})
    item.closed = await driver.close(item.session.sessionId).catch(() => ({ status: 'unknown', transcriptDeletion: 'unknown', closedAt: new Date().toISOString() }))
    item.timeline.closed = performance.now()
  }))
}

export async function runParallelSessions({ tickets, parentAgent, driver, batchTimeoutMs = 150000 }) {
  const batchStarted = performance.now()
  const created = []
  try {
    for (const ticket of tickets) {
      const timeline = { createStarted: performance.now() }
      const session = await driver.createSession(ticket, parentAgent)
      timeline.ready = performance.now()
      created.push({ ticket, session, timeline })
    }
  } catch (error) {
    await closeCreated(driver, created, true)
    error.code ||= 'PARALLEL_SESSION_BARRIER_FAILED'
    error.createdSessions = created.map(item => item.session.sessionId)
    throw error
  }

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('parallel batch exceeded ' + batchTimeoutMs + 'ms')
      error.code = 'PARALLEL_BATCH_TIMEOUT'
      reject(error)
    }, batchTimeoutMs)
  })
  const work = Promise.allSettled(created.map(async item => {
    item.timeline.inputDelivered = performance.now()
    item.timeline.firstExecutionEvent = performance.now()
    try {
      item.delivered = await driver.deliverInput(item.session.sessionId)
      item.status = await driver.readStatus(item.session.sessionId)
      return item
    } finally {
      item.timeline.finished = performance.now()
    }
  }))

  let settled
  try {
    settled = await Promise.race([work, timeout])
  } catch (error) {
    await closeCreated(driver, created, true)
    throw error
  } finally {
    clearTimeout(timer)
  }
  await closeCreated(driver, created, false)
  for (let index = 0; index < settled.length; index += 1) {
    if (settled[index].status === 'rejected') created[index].error = settled[index].reason
  }
  const starts = created.map(item => item.timeline.firstExecutionEvent)
  const finishes = created.map(item => item.timeline.finished)
  const overlapMs = Math.max(0, Math.min(...finishes) - Math.max(...starts))
  return {
    schema: 'fish-parallel-batch-result-v1',
    batchStarted,
    batchFinished: performance.now(),
    overlapMs,
    readyBarrierPassed: created.length === 2,
    items: created,
  }
}

export function detectResultConflicts(packages) {
  const conflicts = []
  for (let left = 0; left < packages.length; left += 1) {
    for (let right = left + 1; right < packages.length; right += 1) {
      for (const a of packages[left].artifacts || []) {
        for (const b of packages[right].artifacts || []) {
          if (pathsConflict(a.path, b.path)) conflicts.push({ type: 'artifact-path', left: a.path, right: b.path })
          if (a.path === b.path && a.sha256 !== b.sha256) conflicts.push({ type: 'artifact-hash', path: a.path, left: a.sha256, right: b.sha256 })
        }
      }
    }
  }
  return conflicts
}

export function writeIntegrationManifest({ stateDir, plan, tickets, packages, sessionAudits, timeline }) {
  const ordered = tickets.map(ticket => {
    const pkg = packages.find(item => item.ticketId === ticket.ticketId)
    const session = sessionAudits.find(item => item.ticketId === ticket.ticketId)
    return {
      stepId: ticket.stepId,
      workerSessionId: session?.sessionId || null,
      resultPackageId: pkg?.resultPackageId || null,
      artifacts: (pkg?.artifacts || []).map(item => ({ path: normalize(path.relative(stateDir, item.path)), sha256: item.sha256 })),
      evidenceRefs: [...(pkg?.evidenceRefs || [])],
    }
  })
  const manifest = {
    schema: 'fish-parallel-integration-manifest-v1',
    acceptanceRunId: plan.acceptanceRunId,
    taskId: plan.taskId,
    planVersion: plan.planVersion,
    integrationOrder: ordered,
    timeline: {
      overlapMs: Number(timeline.overlapMs || 0),
      batchDurationMs: Number(timeline.batchDurationMs || 0),
    },
  }
  const serialized = JSON.stringify(manifest, null, 2) + '\n'
  const id = 'integration:' + safeId(plan.taskId) + ':v' + plan.planVersion + ':' + sha256(serialized).slice(0, 16)
  const target = path.join(stateDir, 'integrations', safeId(plan.acceptanceRunId), safeId(plan.taskId) + '-v' + plan.planVersion + '.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = target + '.tmp-' + process.pid
  fs.writeFileSync(temp, serialized, 'utf8')
  fs.renameSync(temp, target)
  return { id, path: target, sha256: sha256(serialized), manifest }
}
