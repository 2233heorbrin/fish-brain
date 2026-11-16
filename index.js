import { basename, dirname } from 'node:path'
import { ProfileData, mountProfileData } from './internal/profile-data.js'
import { mountBrain } from './internal/runtime.js'

export const name = 'fish-brain'
export const inject = ['connection', 'profileContext']
export async function apply(ctx, config = {}) {
  const data = new ProfileData(ctx.profileContext.dir, 'brain', {
    legacyRoots: () => {
      if (config.brainRoot && basename(config.brainRoot) !== '鱼的大脑')
        throw new Error('FISH_BINDING_INVALID: config.brainRoot must name the existing 鱼的大脑 directory')
      return [
        ...(config.brainRoot ? [{ source: 'config.brainRoot', root: dirname(config.brainRoot) }] : []),
        ...(config.fishRoot ? [{ source: 'config.fishRoot', root: config.fishRoot }] : []),
      ]
    },
  })
  let runtimeRoot
  await mountProfileData(ctx, data, {
    prepare: async state => {
      if (runtimeRoot) return runtimeRoot === state.root ? { status: 'ready', packages: 'ready' }
        : { status: 'restart-required', error: '新位置已保存；请原生重新加载鱼脑。旧数据未移动。' }
      await Promise.all([
        import('./packages/fish-memory-readonly-tools/lib/index.js'),
        import('./packages/dsh-agent-mood/lib/index.js'),
        import('./packages/dsh-agent-thinking/lib/index.js'),
        import('./packages/dsh-agent-execution/lib/index.js'),
      ])
      const result = await mountBrain(ctx, state)
      if (result.status === 'ready') runtimeRoot = state.root
      return result
    },
  })
}
export default { name, inject, apply }
