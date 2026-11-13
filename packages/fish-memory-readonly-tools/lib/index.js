import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'
/* mnemon 是第三方只读记忆库，不随本仓库分发：默认 <repo>/vendor/mnemon，
   可用环境变量 FISH_MNEMON_ROOT 指向你的 mnemon 安装目录。 */
const MNEMON_ROOT = (process.env.FISH_MNEMON_ROOT || fileURLToPath(new URL('../../vendor/mnemon', import.meta.url))).replace(/[\\/]+$/, '')
const { createDocumentsMemorySource } = await import('file://' + MNEMON_ROOT.replace(/\\/g, '/') + '/packages/dsh-mnemon-source-documents/lib/index.js')

export const name = 'fish-memory-readonly-tools'
export const inject = ['tools']

export const TOOL_NAME = 'fish_memory_search'
export const DEFAULT_DATA_DIR = process.env.FISH_MEMORY_DIR || '~/.dsh/fish-brain/memory/documents-readonly'
export const DEFAULT_LIMIT = 3
export const MAX_LIMIT = 5
export const MAX_QUERY_CHARACTERS = 512
export const MAX_EVIDENCE_CHARACTERS = 600

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value, maximum) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + '…'
}

export function validateDocumentsStore(dataDir = DEFAULT_DATA_DIR) {
  const root = resolve(dataDir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('fish memory documents directory is unavailable')
  }

  const indexPath = join(root, 'documents', 'index.json')
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error('fish memory documents index is unavailable')
  }

  let index
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'))
  } catch {
    throw new Error('fish memory documents index is invalid')
  }
  if (!isRecord(index) || !Array.isArray(index.documents)) {
    throw new Error('fish memory documents index is invalid')
  }

  for (const document of index.documents) {
    if (!isRecord(document) || typeof document.id !== 'string' || typeof document.filename !== 'string') {
      throw new Error('fish memory documents index contains an invalid record')
    }
    if (document.status !== 'active' && document.status !== 'archived') {
      throw new Error('fish memory documents index contains an invalid status')
    }
    const directory = document.status === 'active' ? 'active' : 'archived'
    const documentPath = join(root, 'documents', directory, document.filename)
    if (!existsSync(documentPath) || !statSync(documentPath).isFile()) {
      throw new Error('fish memory managed document is unavailable')
    }
  }

  return { root, indexPath, documentCount: index.documents.length }
}

export function normalizeSearchInput(value) {
  if (!isRecord(value)) throw new Error('fish_memory_search input must be an object')
  for (const key of Object.keys(value)) {
    if (key !== 'query' && key !== 'limit') throw new Error('unsupported fish_memory_search field: ' + key)
  }

  if (typeof value.query !== 'string') throw new Error('query must be a string')
  const query = value.query.replace(/\s+/gu, ' ').trim()
  if (query === '') throw new Error('query must not be empty')
  if (query.length > MAX_QUERY_CHARACTERS) {
    throw new Error('query is too long (max ' + MAX_QUERY_CHARACTERS + ' characters)')
  }

  const limit = value.limit === undefined ? DEFAULT_LIMIT : value.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error('limit must be an integer from 1 to ' + MAX_LIMIT)
  }
  return { query, limit }
}

export function createDocumentsSearcher(config = {}) {
  const store = validateDocumentsStore(config.dataDir ?? DEFAULT_DATA_DIR)
  const definition = createDocumentsMemorySource({ dataDir: store.root })
  const route = definition.manifest.routes.find((item) => item.id === 'search')
  if (!route) throw new Error('official Documents search route is unavailable')

  const source = definition.create({
    configuration: { dataDir: store.root },
    sourceInstanceKey: 'fish-memory-readonly',
  })
  if (typeof source.facts !== 'function' || typeof source.project !== 'function' || typeof source.query !== 'function') {
    throw new Error('official Documents Source initialization failed')
  }

  const scope = Object.freeze({ workspaceId: store.root })
  return Object.freeze({
    async search(input) {
      const normalized = normalizeSearchInput(input)
      validateDocumentsStore(store.root)

      const facts = source.facts({ scope, scenario: 'fish.memory.search' })
      if (facts?.availability !== 'ready' || typeof facts.revision !== 'string') {
        throw new Error('fish memory Documents Source is unavailable')
      }
      const projection = source.project({
        scope,
        expectedRevision: facts.revision,
        includeProjection: false,
        mode: 'guided',
        maxCharacters: MAX_EVIDENCE_CHARACTERS * normalized.limit,
      })
      if (!projection?.readGrant) throw new Error('fish memory Documents read grant is unavailable')

      const result = await source.query({
        view: { id: 'fish-memory-readonly-view', scope },
        route,
        grant: projection.readGrant,
        input: { query: normalized.query, limit: normalized.limit, includeArchived: false },
      })

      const items = []
      for (const item of result.items ?? []) {
        if (item?.provenance?.kind !== 'match') continue
        if (items.length >= normalized.limit) break
        items.push({
          documentId: boundedText(item.provenance.documentId ?? item.id, 128),
          title: boundedText(item.provenance.title, 160),
          evidence: boundedText(item.text, MAX_EVIDENCE_CHARACTERS),
          score: Number.isFinite(item.score) ? item.score : 0,
        })
      }

      return {
        schema: 'fish-memory-search-result-v1',
        query: normalized.query,
        total: Number.isInteger(result.metadata?.total) ? result.metadata.total : items.length,
        truncated: result.truncated === true || items.length < (result.metadata?.total ?? items.length),
        items,
      }
    },
  })
}

export function toolDefinition(searcher) {
  return {
    name: TOOL_NAME,
    description: 'Search the fish read-only managed Documents when the question depends on the fish history, relationships, or cross-platform experience. This tool cannot create, update, archive, restore, remember, forget, or inspect memory status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARACTERS },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => searcher.search(args),
    presentCall: () => ({ card: 'generic', title: 'Search fish read-only memory', kind: 'read' }),
    presentResult: () => ({ card: 'generic', title: 'Fish memory evidence' }),
  }
}

export function apply(ctx, config = {}) {
  const searcher = createDocumentsSearcher(config)
  const definition = toolDefinition(searcher)
  const dispose = ctx.tools.register(definition)
  return typeof dispose === 'function' ? dispose : () => {}
}

export default { name, inject, apply }
