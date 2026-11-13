import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  createDocumentsSearcher,
  DEFAULT_DATA_DIR,
  MAX_EVIDENCE_CHARACTERS,
  MAX_LIMIT,
  MAX_QUERY_CHARACTERS,
  normalizeSearchInput,
  TOOL_NAME,
  toolDefinition,
} from '../lib/index.js'

const KNOWN_DOCUMENT_ID = '2ecabd62-f2d5-4d38-95f3-6c56daa87529'

async function managedState() {
  const indexPath = join(DEFAULT_DATA_DIR, 'documents', 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const activeDir = join(DEFAULT_DATA_DIR, 'documents', 'active')
  const files = (await readdir(activeDir)).sort()
  const bodies = []
  for (const filename of files) {
    const bytes = await readFile(join(activeDir, filename))
    bodies.push({ filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return {
    documents: index.documents.map((item) => ({
      id: item.id,
      status: item.status,
      filename: item.filename,
      relativePath: item.relativePath,
      contentHash: item.contentHash,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    bodies,
  }
}

function createHarness() {
  const record = { definition: null, disposed: false, registrations: 0 }
  const ctx = {
    tools: {
      register(definition) {
        record.definition = definition
        record.registrations += 1
        return () => { record.disposed = true }
      },
    },
  }
  return { ctx, record }
}

test('真实 Documents Source 搜索命中既有锚点且正文语义不变', async () => {
  const before = await managedState()
  const searcher = createDocumentsSearcher()
  const result = await searcher.search({ query: '自建复盘器脚本', limit: 3 })
  const after = await managedState()

  assert.equal(result.schema, 'fish-memory-search-result-v1')
  assert.ok(result.items.some((item) => item.documentId === KNOWN_DOCUMENT_ID))
  assert.ok(result.items.length <= 3)
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(), ['documentId', 'evidence', 'score', 'title'])
    assert.ok(item.evidence.length <= MAX_EVIDENCE_CHARACTERS)
    assert.equal(typeof item.score, 'number')
  }
  assert.deepEqual(after, before)
})

test('输入只允许非空有界 query 和 limit', () => {
  assert.deepEqual(normalizeSearchInput({ query: '  关系  记忆  ' }), { query: '关系 记忆', limit: 3 })
  assert.throws(() => normalizeSearchInput({ query: '' }), /must not be empty/)
  assert.throws(() => normalizeSearchInput({ query: 'x'.repeat(MAX_QUERY_CHARACTERS + 1) }), /too long/)
  for (const limit of [0, MAX_LIMIT + 1, 1.5, '2']) {
    assert.throws(() => normalizeSearchInput({ query: '测试', limit }), /limit must be an integer/)
  }
  assert.throws(() => normalizeSearchInput({ query: '测试', includeArchived: true }), /unsupported/)
})

test('目录或索引缺失和索引损坏时 fail closed', async () => {
  const missing = join(tmpdir(), 'fish-memory-missing-' + randomUUID())
  assert.throws(() => createDocumentsSearcher({ dataDir: missing }), /directory is unavailable/)

  const root = await mkdtemp(join(tmpdir(), 'fish-memory-invalid-'))
  try {
    assert.throws(() => createDocumentsSearcher({ dataDir: root }), /index is unavailable/)
    await mkdir(join(root, 'documents'), { recursive: true })
    await writeFile(join(root, 'documents', 'index.json'), '{invalid', 'utf8')
    assert.throws(() => createDocumentsSearcher({ dataDir: root }), /index is invalid/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只定义 fish_memory_search，不暴露写接口或 Mnemon 工具', () => {
  const definition = toolDefinition({ search: async () => ({ items: [] }) })
  assert.equal(definition.name, TOOL_NAME)
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['limit', 'query'])
  assert.equal(definition.parameters.additionalProperties, false)
  for (const forbidden of ['includeArchived', 'manage', 'mutate', 'create', 'archive', 'remember', 'forget', 'status']) {
    assert.equal(Object.hasOwn(definition.parameters.properties, forbidden), false)
  }
  assert.equal(definition.name.startsWith('mnemon_'), false)
})

test('在当前 preset 工具作用域只注册一次并随插件释放', () => {
  const harness = createHarness()
  const stop = apply(harness.ctx)
  assert.equal(harness.record.definition.name, TOOL_NAME)
  assert.equal(harness.record.registrations, 1)
  assert.equal(harness.record.disposed, false)
  stop()
  assert.equal(harness.record.disposed, true)
})

test('活动源码不依赖 tools.restrict 且不注册写能力', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const forbidden of [
    'tools.restrict',
    'mnemon_document_manage',
    'mnemon_document_create',
    'mnemon_remember',
    'mnemon_forget',
    'source.manage(',
    'source.mutate(',
  ]) assert.equal(source.includes(forbidden), false, '活动源码不得包含 ' + forbidden)
})
