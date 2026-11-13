// Minimal independent samples for native Loader integration. No installed
// third-party plugins, network, model, production state or files are involved.
export const inject = ['systemPrompt', 'tools']
export function apply(ctx, config = {}) {
  if (config.context) ctx.systemPrompt.context({ name: config.context, order: 130, text: config.context })
  if (config.tool) ctx.tools.register({
    name: config.tool, description: 'isolated lifecycle fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => config.tool,
  })
  if (config.listener) ctx.on('fish-brain-fixture/ping', () => { globalThis.__fishFixtureCalls++ })
  if (config.timer) {
    const timer = setInterval(() => { globalThis.__fishFixtureTicks++ }, 5)
    ctx.effect(() => () => clearInterval(timer))
  }
  if (config.failRelease) ctx.effect(() => () => { throw new Error('FIXTURE_RELEASE_FAILURE') })
}
