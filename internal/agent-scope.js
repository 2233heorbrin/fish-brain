/** Use native composition, never ids, names, or transcript text as ownership. */
export function isFishAgent(ctx, agent) {
  if (!agent?.ctx) return false
  const presets = ctx.get?.('agentPresets') || ctx.agentPresets
  return presets?.composedPreset(agent.ctx) === 'fish'
}
