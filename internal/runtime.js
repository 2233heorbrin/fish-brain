import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as control from '../packages/fish-brain-suite/lib/control.js'
import FishBrainSuite from '../packages/fish-brain-suite/lib/index.js'

const entry = name => new URL(`../packages/${name}/${name.includes('gate') ? 'index.js' : 'lib/index.js'}`, import.meta.url).href
const resolveEntries = rows => rows.map(row => ({ ...row,
  name: row.name.startsWith('@') || row.name.startsWith('cordis:') ? row.name : entry(row.name),
  ...(Array.isArray(row.config) ? { config: resolveEntries(row.config) } : {}),
}))

/** The native root retains only the off-state fish entry and epoch admission.
 * All brain UI, guards, scoped prompt components and agents belong to the suite.
 */
export async function mountBrain(ctx, state) {
  if (typeof ctx.get('agentLoop')?.releaseExact !== 'function') return {
    status: 'host-blocked', code: 'FISH_EXACT_AGENT_RELEASE_UNAVAILABLE', packages: 'ready',
    error: '官方 DSH rc.5 无精确 Agent 释放接口；需要本轮明确标记的宿主扩展，鱼脑未启用。',
  }
  const brainRoot = join(state.root, '鱼的大脑')
  const profileDir = state.profileDir
  let lifecycle = ctx.get('fishBrainLifecycle')
  if (!lifecycle) {
    const fishPlugins = resolveEntries(JSON.parse(readFileSync(new URL('../packages/fish-brain-suite/fish-plugins.json', import.meta.url), 'utf8')))
    const handle = ctx.root.plugin(control, { brainRoot, profileDir, fishPlugins,
      epochPath: join(profileDir, 'fish-brain-epoch.json') })
    await handle.await()
    lifecycle = ctx.get('fishBrainLifecycle')
    if (!lifecycle) throw new Error('FISH_LIFECYCLE_NOT_READY')
  }
  // A manual root change creates no new context generation until old ownership
  // has been released. Re-opening the native plugin uses the saved binding.
  lifecycle.config.brainRoot = brainRoot
  lifecycle.config.fishPlugins = resolveEntries(JSON.parse(readFileSync(new URL('../packages/fish-brain-suite/fish-plugins.json', import.meta.url), 'utf8')))
    .map(row => ({ ...row, config: row.config && JSON.parse(JSON.stringify(row.config)
      .split('<FISH_BRAIN_ROOT>').join(brainRoot.replaceAll('\\', '/'))
      .split('<PROFILE_DIR>').join(profileDir.replaceAll('\\', '/'))) }))
  const handle = ctx.plugin(FishBrainSuite, [
    { id: 'fish-brain-ui', name: new URL('./brain-ui.js', import.meta.url).href, config: { brainRoot, freezeMatrixPath: join(brainRoot, '总说明/全脑V1冻结矩阵.json') } },
    { id: 'fish-agent-collab-gate', name: entry('fish-agent-collab-gate'), config: { statePath: join(profileDir, 'agent-collab.json') } },
    { id: 'fish-engineering-tools-gate', name: entry('fish-engineering-tools-gate'), config: { statePath: join(profileDir, 'engineering-tools.json') } },
  ])
  await handle.await()
  if (handle.state !== 2 || lifecycle.mode !== 'enabled') throw new Error('FISH_SUITE_NOT_READY: ' + lifecycle.failures.join('; '))
  return { status: 'ready', packages: 'ready', lifecycle: 'native-handle-extension-v1' }
}
