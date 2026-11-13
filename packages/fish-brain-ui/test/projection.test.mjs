import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import apply, { buildEvidence, buildHistory, buildProjection } from '../lib/index.js'

const root = 'D:/deepseek框架/鱼的大脑/适配器/fish-brain-ui'
const config = {
  freezeMatrixPath: 'D:/deepseek框架/鱼的大脑/总说明/全脑V1冻结矩阵.json',
  brainRoot: 'D:/deepseek框架/鱼的大脑'
}

async function sourceFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(path))
    else out.push(path)
  }
  return out
}

test('declares the connection service on the mounted plugin', () => {
  assert.deepEqual(apply.inject, ['connection'])
})

test('snapshot is complete authority-backed read-only state', async () => {
  const projection = await buildProjection(config)
  assert.equal(projection.schema, 'fish-brain-readonly-projection-v2')
  assert.equal(projection.sourceClass, 'authority-backed')
  assert.equal(projection.personality.maxBytes, 10240)
  assert.equal(projection.memory.documents, 5)
  assert.equal(projection.memory.active, 5)
  assert.equal(projection.memory.writeEnabled, false)
  assert.equal(projection.memory.writebackMode, 'off')
  assert.equal(projection.regions.length, 5)
  assert.ok(projection.regions.every((region) => region.authority && region.keyHash && Array.isArray(region.nodes)))
  assert.equal(projection.interface.readOnly, true)
  assert.deepEqual(projection.interface.regions, ['人格', '记忆', '心情', '思考', '执行'])
  assert.equal(projection.interface.evidenceIsRegion, false)
  assert.equal(projection.interface.fishHands, 'planned-unavailable')
  assert.equal(JSON.stringify(projection).includes('documentId'), false)
  assert.equal(JSON.stringify(projection).includes('synthetic'), false)
})

test('history returns only authority audit entries or an explicit unavailable state', async () => {
  const history = await buildHistory(config)
  assert.equal(history.schema, 'fish-brain-authority-history-v1')
  assert.ok(['available', 'unavailable', 'unknown'].includes(history.status))
  assert.ok(Array.isArray(history.entries))
  for (const entry of history.entries) {
    assert.ok(['mood', 'thinking'].includes(entry.region))
    assert.match(entry.eventRef || '', /^[A-F0-9]{16}$/)
    assert.equal(JSON.stringify(entry).includes('session-aaf'), false)
  }
})

test('evidence is generated from the freeze matrix and current hashes', async () => {
  const evidence = await buildEvidence(config)
  assert.equal(evidence.schema, 'fish-brain-evidence-summary-v1')
  assert.equal(evidence.sourceClass, 'authority-backed')
  assert.equal(evidence.manifests.length, 5)
  assert.equal(evidence.items.length, 7)
  assert.equal(evidence.privacy.evidenceBodyReturned, false)
  assert.equal(evidence.privacy.promptReturned, false)
  assert.equal(evidence.privacy.memoryBodyReturned, false)
  assert.equal(evidence.privacy.fullSessionIdReturned, false)
  assert.ok(evidence.items.every((item) => item.hashStatus === 'match'))
})

test('host registers only GET/HEAD UI and projection routes and disposes them', async () => {
  const routes = [], effects = [], disposed = []
  const ctx = {
    effect(factory) { effects.push(factory) },
    connection: { fetch: { register(route) { routes.push(route); return () => disposed.push(route.path) } } }
  }
  apply(ctx, config)
  const cleanups = effects.map((factory) => factory()).filter(Boolean)
  for (const path of ['/api/fish-brain/ui', '/api/fish-brain/snapshot', '/api/fish-brain/history', '/api/fish-brain/evidence', '/api/fish-brain/events']) assert.ok(routes.some((route) => route.path === path))
  assert.equal(routes.some((route) => route.path.includes('/data/')), false)
  for (const route of routes) assert.deepEqual(route.methods, ['GET', 'HEAD'])
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(disposed.length, routes.length)
})

test('production assets contain no demo data dependency or nested settings navigation', async () => {
  const files = (await sourceFiles(join(root, 'assets'))).filter((path) => /\.(?:html|css|js)$/.test(path))
  const source = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n')
  assert.doesNotMatch(source, /fish-demo|synthetic-demo|分层演示数据|演示任务|FB_SNAPSHOT|FB_EVENTS|FB_EVIDENCE|\/data\//)
  assert.doesNotMatch(source, /innerHTML\s*=/)
  assert.doesNotMatch(source, /账号与余额|通用设置|内置插件|Agent 预设/)
})

test('client registers one fish brain settings section at order 18', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /id: 'fish-brain'/)
  assert.match(source, /order: 18/)
  assert.match(source, /label: \(\) => '鱼的脑'/)
  assert.doesNotMatch(source, /POST|PUT|PATCH|DELETE/)
})
