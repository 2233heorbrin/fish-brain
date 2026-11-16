import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const install = process.env.FISH_TEST_INSTALL_ROOT
if (!install) throw new Error('FISH_TEST_INSTALL_ROOT must point to an isolated installed tarball')
const root = join(install, 'node_modules', 'fish-brain')
const { ProfileData, conversationWorkspace, mountProfileData } = await import(pathToFileURL(join(root, 'internal/profile-data.js')))
const temp = mkdtempSync(join(tmpdir(), 'fish-data-test-'))
const directory = name => { const path = join(temp, name); mkdirSync(path, { recursive: true }); return path }
const data = (name, component = 'brain', options) => new ProfileData(directory(name), component, options)

test('every bundled component includes its declared native bundle patch', () => {
  for (const name of readdirSync(join(root, 'packages'))) {
    const directory = join(root, 'packages', name)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (manifest.dsh?.bundle?.patch)
      assert(existsSync(join(directory, manifest.dsh.bundle.patch)), name + ': declared bundle patch missing from installed package')
  }
})

test('no workspace stays pending and never uses cwd', () => {
  const value = data('pending'); assert.equal(value.initialize().status, 'pending-workspace')
  assert(!existsSync(value.file)); assert.equal(conversationWorkspace({ get: () => null }, 'unknown'), null)
})
test('only explicitly addressed native workspace is used', () => {
  const first = directory('workspace-a'), second = directory('workspace-b')
  const ctx = { get: name => name === 'workspaceRegistry' ? { list: () => [{ path: first, sessionIds: ['a'] }, { path: second, sessionIds: ['b'] }] } : null }
  assert.equal(conversationWorkspace(ctx, 'b'), second)
  assert.equal(conversationWorkspace(ctx, 'missing'), null)
  const value = data('current'); value.initialize({ root: conversationWorkspace(ctx, 'b') }); assert.equal(value.state().root, second)
})
for (const order of [['brain', 'body'], ['body', 'brain']]) test('independent binding order ' + order.join(' -> '), () => {
  const profile = directory(order.join('-')), first = new ProfileData(profile, order[0]), second = new ProfileData(profile, order[1])
  const selected = directory(order.join('-') + '-root'), other = directory(order.join('-') + '-other')
  first.initialize({ root: selected }); second.initialize({ root: other })
  assert.equal(first.state().root, selected); assert.equal(second.state().root, other)
  assert.deepEqual(new ProfileData(profile, 'brain').binding().components, ['brain'])
  assert(existsSync(join(first.component === 'body' ? selected : other, '饭'))); assert(existsSync(join(first.component === 'brain' ? selected : other, '鱼的大脑', '人格', 'generated', 'SELF.compat.md')))
})
test('workspace changes do not move data; explicit root switch preserves old files and persists', () => {
  const value = data('switch'), first = directory('switch-first'), next = directory('switch-next')
  value.initialize({ root: first }); writeFileSync(join(first, 'kept.txt'), 'kept')
  value.initialize({ root: next }); assert.equal(value.state().root, first)
  value.initialize({ root: next, switchRoot: true }); assert.equal(value.state().root, next)
  assert.equal(readFileSync(join(first, 'kept.txt'), 'utf8'), 'kept')
  assert(!existsSync(join(next, 'kept.txt')))
  assert.equal(new ProfileData(value.profileDir, 'brain').state().root, next)
})
test('valid legacy content is preserved and invalid legacy path is visible, never replaced', () => {
  const legacy = directory('legacy'), value = data('legacy-profile', 'brain', { legacyRoot: legacy })
  const self = join(legacy, '鱼的大脑', '人格', 'generated', 'SELF.compat.md'); mkdirSync(join(self, '..'), { recursive: true }); writeFileSync(self, 'SYNTHETIC_SELF')
  value.initialize(); assert.equal(readFileSync(self, 'utf8'), 'SYNTHETIC_SELF')
  const invalid = join(temp, 'missing-legacy'), broken = data('broken', 'body', { legacyRoot: invalid })
  assert.equal(broken.state().root, invalid); assert.equal(broken.state().status, 'invalid-root')
  assert.throws(() => broken.initialize({ root: legacy }), /FISH_ROOT_INVALID/); assert(!existsSync(invalid))
})
test('blank SELF and real empty Documents source search work without writes', async () => {
  const value = data('empty-memory'); value.initialize({ root: directory('empty-content') })
  assert.equal(value.state().personality, 'empty-template'); assert.equal(value.state().memory.count, 0)
  const { createDocumentsSearcher } = await import(pathToFileURL(join(root, 'packages/fish-memory-readonly-tools/lib/index.js')))
  const searcher = createDocumentsSearcher({ dataDir: join(value.state().paths.脑区运行状态, '记忆', 'documents-readonly') })
  const result = await searcher.search({ query: 'unknown' }); assert.equal(result.total, 0); assert.deepEqual(result.items, [])
})
test('initialization endpoint reports preparation failure and retries honestly', async () => {
  const value = data('retry'), routes = new Map(), workspace = directory('retry-root'); let calls = 0
  const ctx = { effect: operation => operation(), get: name => name === 'workspaceRegistry' ? { list: () => [{ path: workspace, sessionIds: ['chosen'] }] } : null,
    connection: { fetch: { register: row => { routes.set(row.path, row.fetch); return () => routes.delete(row.path) } } } }
  await mountProfileData(ctx, value, { prepare: async () => { if (++calls === 1) throw new Error('TEST_PREPARE_FAILURE'); return { status: 'ready' } } })
  const post = async body => (await routes.get('/api/fish-brain/data')(new Request('http://local/api/fish-brain/data', { method: 'POST', body: JSON.stringify(body) }))).json()
  const failed = await post({ action: 'initialize', sessionId: 'chosen' }); assert.equal(failed.dependencies.status, 'failed'); assert.equal(failed.dependencies.error, 'TEST_PREPARE_FAILURE')
  const retried = await post({ action: 'retry' }); assert.equal(retried.dependencies.status, 'ready'); assert.equal(calls, 2)
})
test('packed runtime entry and every required internal kernel import independently', async () => {
  for (const entry of ['index.js', 'packages/fish-brain-suite/lib/control.js', 'packages/dsh-agent-mood/lib/index.js',
    'packages/dsh-agent-thinking/lib/index.js', 'packages/dsh-agent-execution/lib/index.js', 'packages/fish-memory-readonly-tools/lib/index.js'])
    assert(await import(pathToFileURL(join(root, entry))))
})
