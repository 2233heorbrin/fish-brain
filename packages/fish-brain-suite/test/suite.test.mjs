import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import FishBrainSuite from '../lib/index.js'
import { req } from './native-harness.mjs'

test('refuses a second loader when native group is unavailable', async () => {
  const suite = new FishBrainSuite({ loader: { builtins: {} } }, [])
  const lifecycle = suite[Symbol.for('cordis.init')]()
  await assert.rejects(() => lifecycle.next(), /cordis:group builtin/)
})

test('Host owns UI and reversible gates; identity stays inside fish preset', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const id of ['fish-brain-ui', 'fish-agent-collab-gate', 'fish-engineering-tools-gate']) assert(patch.includes('id: ' + id))
  for (const forbidden of [
    'dsh-memory-shipei',
    'dsh-mnemon',
    'fish-memory-readonly-tools',
    'dsh-agent-mood',
    'dsh-agent-thinking',
    'dsh-agent-execution',
  ]) assert.equal(patch.includes(forbidden), false, 'Host Suite 不得加载 ' + forbidden)
})

test('source and fish-main installed Suite patch are byte-identical', async () => {
  const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const installed = await readFile('D:/deepseek框架/DSH/profiles/fish-main/node_modules/fish-brain-suite/cordis.patch.yml', 'utf8')
  assert.equal(installed, source)
})

test('Profile preserves standard, native defaults, independent plugins and user settings; only ownership moves', async () => {
  const { load } = req('js-yaml')
  const { entryListSchema } = req('@deepseek-ai/cordis-plugin-include')
  const parse = text => load(text, { schema: entryListSchema })
  const before = parse(await readFile('E:/蒜香大肥鱼的家/鱼脑总开关修复证据-20261111/before-0.bin', 'utf8'))
  const after = parse(await readFile('D:/deepseek框架/DSH/profiles/fish-main/cordis.patch.yml', 'utf8'))
  const removed = new Set(['preset-fish', 'fish-agent-collab-gate', 'fish-engineering-tools-gate', 'fish-brain-lifecycle'])
  const retained = rows => rows.filter(row => !row.insert?.some(child => removed.has(child.id)))
  assert.deepEqual(retained(after), retained(before))
  assert.equal(after.flatMap(row => row.insert || []).filter(row => row.id === 'fish-brain-lifecycle').length, 1)
  const originalFish = before.flatMap(row => row.insert || []).find(row => row.id === 'preset-fish').config.plugins
  const currentFish = JSON.parse(await readFile(new URL('../fish-plugins.json', import.meta.url), 'utf8'))
  delete currentFish.find(row => row.id === 'dsh-agent-thinking').config.scopeOnly
  assert.deepEqual(currentFish, originalFish)
})
