import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const BINDING_FILE = 'fish-brain-data.json'
export const LEGACY_BINDING_FILE = 'fish-data.json'
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const directory = path => { try { return statSync(path).isDirectory() } catch { return false } }
const writeOnce = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  try { writeFileSync(path, value, { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
}
const json = value => JSON.stringify(value, null, 2) + '\n'

const sameRoot = (a, b) => process.platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
function readBinding(file) {
  let value
  try { value = read(file) } catch (error) { throw new Error(`FISH_BINDING_INVALID: ${file}: ${error.message}`) }
  if (value?.schema !== 'fish-profile-data/v1' || (typeof value.root !== 'string' || !isAbsolute(value.root)) ||
    !Array.isArray(value.components) || value.components.some(c => !['brain', 'body'].includes(c)))
    throw new Error(`FISH_BINDING_INVALID: ${file}`)
  return value
}

/** Component-owned binding. Legacy inputs are consulted only before it exists. */
export class ProfileData {
  constructor(profileDir, component, { legacyRoot, legacyRoots = () => [] } = {}) {
    if (!isAbsolute(profileDir || '')) throw new Error('FISH_PROFILE_REQUIRED')
    if (!['brain', 'body'].includes(component)) throw new Error('FISH_COMPONENT_INVALID')
    this.profileDir = resolve(profileDir)
    this.component = component
    this.file = join(this.profileDir, `fish-${component}-data.json`)
    this.legacyRoots = () => [...(legacyRoot ? [{ source: 'config.legacyRoot', root: legacyRoot }] : []), ...legacyRoots()]
  }
  binding() {
    if (existsSync(this.file)) return readBinding(this.file)
    const sharedFile = join(this.profileDir, LEGACY_BINDING_FILE)
    const roots = this.legacyRoots()
    if (existsSync(sharedFile)) roots.push({ source: sharedFile, root: readBinding(sharedFile).root })
    if (!roots.length) return null
    for (const { source, root } of roots) if (typeof root !== 'string' || !isAbsolute(root)) throw new Error(`FISH_BINDING_INVALID: ${source}`)
    if (roots.some(row => !sameRoot(row.root, roots[0].root)))
      throw new Error('FISH_BINDING_CONFLICT: ' + roots.map(row => `${row.source}=${row.root}`).join('; '))
    // Register location only. Initialization below supplements our own structure.
    writeOnce(this.file, json({ schema: 'fish-profile-data/v1', root: resolve(roots[0].root), components: [], origin: 'legacy' }))
    return readBinding(this.file)
  }
  paths(root) {
    return this.component === 'brain'
      ? Object.fromEntries(['人格', '记忆', '心情', '思考', '执行', '脑区运行状态'].map(key => [key, join(root, '鱼的大脑', key)]))
      : { rice: join(root, '饭'), stomach: join(root, '鱼的胃'), hand: join(root, '鱼的手') }
  }
  state() {
    try {
      const value = this.binding()
      if (!value) return { status: 'pending-workspace', root: null, paths: {}, profileDir: this.profileDir }
      const valid = directory(value.root)
      const state = { status: valid ? (value.components.includes(this.component) ? 'ready' : 'pending-initialization') : 'invalid-root',
        root: value.root, paths: this.paths(value.root), profileDir: this.profileDir }
      if (valid && this.component === 'brain') {
        const self = join(state.paths.人格, 'generated', 'SELF.compat.md')
        state.personality = existsSync(self) && readFileSync(self, 'utf8').trim() ? 'filled' : 'empty-template'
        const index = join(state.paths.脑区运行状态, '记忆', 'documents-readonly', 'documents', 'index.json')
        state.memory = existsSync(index) ? { count: read(index).documents.length } : { count: 0 }
      }
      return state
    } catch (error) { return { status: 'invalid-config', root: null, paths: {}, profileDir: this.profileDir, error: error.message } }
  }
  initialize({ root, switchRoot = false } = {}) {
    let previous
    try { previous = this.binding() } catch (error) { if (!switchRoot) throw error }
    if (previous && !switchRoot) root = previous.root
    if (!root) return this.state()
    if (!isAbsolute(root) || !directory(root)) throw new Error('FISH_ROOT_INVALID: 请选择已存在的绝对目录；旧路径不会自动替换')
    root = resolve(root)
    const paths = this.paths(root)
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
    if (this.component === 'brain') {
      // Empty content is deliberate. Instructions live outside the injected SELF.
      writeOnce(join(paths.人格, 'generated', 'SELF.compat.md'), '')
      writeOnce(join(paths.人格, 'README.md'), '# 人格\n\n请自行填写 generated/SELF.compat.md。空文件不注入角色事实。\n')
      writeOnce(join(paths.思考, '策略', '思考运行卡.txt'), '')
      writeOnce(join(paths.思考, '能力索引.json'), json({ capabilities: [] }))
      const store = join(paths.脑区运行状态, '记忆', 'documents-readonly', 'documents')
      for (const dir of ['active', 'archived']) mkdirSync(join(store, dir), { recursive: true })
      writeOnce(join(store, 'index.json'), json({ version: 1, documents: [] }))
    } else {
      for (const dir of ['来源审查', '脑组件', '手组件']) mkdirSync(join(paths.stomach, dir), { recursive: true })
      for (const dir of ['插件仓', '插件注册表/requests', '插件注册表/decisions', '运行数据', '审计日志']) mkdirSync(join(paths.hand, dir), { recursive: true })
      writeOnce(join(paths.hand, '插件注册表', 'registry.json'), json({ schema: 'fish-hand-plugin-registry/v1', plugins: [] }))
    }
    const binding = { schema: 'fish-profile-data/v1', root,
      components: [this.component],
      origin: previous?.root === root ? previous.origin : switchRoot ? 'manual' : 'conversation-workspace' }
    // Publish only this component's location; never rewrite the shared/other file.
    if (!existsSync(this.file)) writeOnce(this.file, json(binding))
    else { const temp = this.file + '.tmp'; writeFileSync(temp, json(binding)); renameSync(temp, this.file) }
    return this.state()
  }
}

/** Resolve only the explicitly addressed native conversation's workspace. */
export function conversationWorkspace(ctx, sessionId) {
  if (!sessionId) return null
  const workspace = ctx.get('workspaceRegistry')?.list().find(row => row.sessionIds?.includes(sessionId))
  if (workspace && isAbsolute(workspace.path || '') && directory(workspace.path)) return workspace.path
  return null
}

export async function mountProfileData(ctx, data, { prepare = async () => ({}), status = () => ({}) } = {}) {
  const base = '/api/fish-' + data.component + '/data'
  const response = (value, code = 200) => new Response(JSON.stringify(value), { status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  let preparation = { status: 'not-prepared' }, pending
  const ready = async () => {
    const state = data.state()
    if (state.status !== 'ready') return
    if (!pending) pending = Promise.resolve().then(() => prepare(state)).then(value => { preparation = value })
      .catch(error => { preparation = { status: 'failed', error: error.message } }).finally(() => { pending = null })
    await pending
  }
  const state = () => ({ ...data.state(), dependencies: preparation, ...status() })
  ctx.effect(() => ctx.connection.fetch.register({ path: base, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        if (request.method === 'POST') {
          const input = await request.json()
          if (input.action === 'select') data.initialize({ root: input.path, switchRoot: true })
          else if (input.action === 'initialize') data.initialize({ root: conversationWorkspace(ctx, input.sessionId) })
          else if (input.action !== 'retry') return response({ error: 'FISH_DATA_ACTION_INVALID' }, 400)
          await ready()
        }
        return response(state())
      } catch (error) { return response({ ...state(), error: error.message }, 400) }
    } }))
  ctx.effect(() => ctx.connection.fetch.register({ path: base + '/open', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        const { section } = await request.json(), current = data.state()
        const target = section === 'root' ? current.root : current.paths[section]
        if (!target || !directory(target)) throw new Error('FISH_DIRECTORY_UNAVAILABLE')
        await ctx.get('sessionController').openWorkspacePath({ path: target }, request.signal)
        return response({ ok: true })
      } catch (error) { return response({ error: error.message }, 400) }
    } }))
  // Upgrades reuse the saved root; no current conversation is needed in that case.
  try { if (data.binding()) { data.initialize(); await ready() } }
  catch (error) { preparation = { status: 'failed', error: error.message } }
  return { state, ready }
}
