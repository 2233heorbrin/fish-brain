import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildEventProjection,
  diffEventProjection,
  extractMemorySummaryZh,
  memoryNodes,
  resolveMemoryDocumentPath
} from '../lib/index.js'

const config = {
  freezeMatrixPath: 'D:/deepseek框架/鱼的大脑/总说明/全脑V1冻结矩阵.json',
  brainRoot: 'D:/deepseek框架/鱼的大脑'
}

function normalized(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

test('five active authority documents produce deterministic redacted Chinese summaries', async () => {
  const first = await buildEventProjection(config)
  const second = await buildEventProjection(config)
  const a = first.regions.find((region) => region.id === 'memory')
  const b = second.regions.find((region) => region.id === 'memory')

  assert.equal(first.schema, 'fish-brain-events-projection-v1')
  assert.equal(first.counts.regions, 6)
  assert.equal(a.nodes.length, 5)
  const nodeIds = first.regions.flatMap((region) => region.nodes.map((node) => node.id))
  assert.equal(first.counts.nodes, nodeIds.length)
  assert.equal(new Set(nodeIds).size, nodeIds.length)
  assert.deepEqual(a.nodes.map((node) => node.summaryZh), b.nodes.map((node) => node.summaryZh))

  for (const node of a.nodes) {
    assert.ok(node.summaryZh)
    assert.match(node.summaryZh, /[\u3400-\u9fff]/u)
    assert.ok(node.summaryZh.length <= 260)
    assert.notEqual(normalized(node.summaryZh), normalized(node.titleZh))
    assert.doesNotMatch(node.summaryZh, /https?:\/\/|www\.|[A-Za-z]:[\\/]|\u0060{3}|token|cookie|password|secret|[A-Fa-f0-9]{32,}/i)
    assert.doesNotMatch(node.summaryZh, /^#{1,6}\s|^\|/m)
  }
})

test('extractor skips frontmatter, headings, tables, code and sensitive values', () => {
  const markdown = [
    '---',
    'title: 测试',
    '---',
    '# 测试标题',
    '',
    '## 背景',
    '这是可展示的中文背景。路径 C:/private/secret.txt，URL https://example.test/a，token=abcdef。',
    '',
    '| 列 | 值 |',
    '|---|---|',
    '| 一 | 二 |',
    '',
    '\u0060\u0060\u0060sh',
    'node dangerous.js --token secret',
    '\u0060\u0060\u0060'
  ].join('\n')
  const summary = extractMemorySummaryZh(markdown, '测试标题')
  assert.match(summary, /^这是可展示的中文背景/)
  assert.doesNotMatch(summary, /example|private|token|dangerous|\u0060|\|/i)
})

test('extractor removes orphaned reference prompts, empty parentheses and cleanup punctuation', () => {
  const first = extractMemorySummaryZh([
    '# 真实残词回归',
    '',
    '## 背景',
    '承接自建复盘器（见文档 6b071c84-077c-4e32-b7aa-600e743d77fc）。 用户当时的判断保持不变。。'
  ].join('\n'), '真实残词回归')
  assert.equal(first, '承接自建复盘器。 用户当时的判断保持不变。')

  const second = extractMemorySummaryZh([
    '# 真实残词回归二',
    '',
    '## 发生时间',
    '承接 （该文档当时记录 ②、③ 尚未开工，本文补完）。空括号 () 与（）不应保留。'
  ].join('\n'), '真实残词回归二')
  assert.equal(second, '（该文档当时记录 ②、③ 尚未开工，本文补完）。空括号 与不应保留。')

  for (const summary of [first, second]) {
    assert.doesNotMatch(summary, /见文档\s*(?:[）)，。；：！？、]|$)|承接\s*[（(]|\(\s*\)|（\s*）|([，。；：！？、])\1/)
  }
})

test('path safety and per-document failures degrade only the affected node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-brain-memory-'))
  try {
    const activeDir = join(root, 'documents', 'active')
    await mkdir(activeDir, { recursive: true })
    await writeFile(join(activeDir, 'good.md'), '# 有效标题\n\n## 结论\n这是一段可安全投影的中文结论。', 'utf8')
    await writeFile(join(activeDir, 'empty.md'), '# 空文档', 'utf8')
    const index = {
      documents: [
        { id: '11111111-a', title: '有效标题', status: 'active', relativePath: 'documents/active/good.md' },
        { id: '22222222-b', title: '缺失文件', status: 'active', relativePath: 'documents/active/missing.md' },
        { id: '33333333-c', title: '越界文件', status: 'active', relativePath: '../outside.md' },
        { id: '44444444-d', title: '空文档', status: 'active', relativePath: 'documents/active/empty.md' }
      ]
    }
    const indexPath = join(root, 'documents', 'index.json')
    await writeFile(indexPath, JSON.stringify(index), 'utf8')

    assert.equal(resolveMemoryDocumentPath(root, '../outside.md'), null)
    assert.ok(resolveMemoryDocumentPath(root, 'documents/active/good.md'))

    const result = await memoryNodes({ memRoot: root, memIndex: indexPath })
    assert.equal(result.nodes.length, 4)
    assert.equal(result.nodes[0].summaryZh, '这是一段可安全投影的中文结论。')
    assert.equal(result.nodes[1].summaryZh, null)
    assert.equal(result.nodes[2].summaryZh, null)
    assert.equal(result.nodes[3].summaryZh, null)
    assert.equal(result.status, 'read-only')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a memory summary change uses the existing node.updated event type', async () => {
  const before = await buildEventProjection(config)
  const after = structuredClone(before)
  const memory = after.regions.find((region) => region.id === 'memory')
  memory.nodes[0].summaryZh += '（变化）'
  const diff = diffEventProjection(before, after)
  assert.deepEqual(diff.map((entry) => entry.type), ['node.updated'])
  assert.equal(diff[0].node.id, memory.nodes[0].id)
})
