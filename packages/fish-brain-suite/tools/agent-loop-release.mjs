import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Expose the factory's existing exact, memoized AgentHandle teardown. No new
// Agent factory, cancellation implementation, registry or global shutdown.
export function patchAgentLoop(source) {
  if (source.includes('async releaseExact(agent)')) return source
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('AgentLoop patch anchor mismatch')
    source = source.replace(from, to)
  }
  replace('var AgentLoop = class extends Service {', `var AgentLoop = class extends Service {
\townedHandles = new WeakMap();
\tasync releaseExact(agent) {
\t\tconst dispose = this.ownedHandles.get(agent);
\t\tif (!dispose || this.runtime.ctx.agents.get(agent.id) !== agent)
\t\t\tthrow new Error("agent loop does not own this exact live agent");
\t\tawait dispose();
\t}`)
  replace('\t\t\t\tuntrack();\n\t\t\t}', '\t\t\t\tif (machine) this.ownedHandles.delete(machine);\n\t\t\t\tuntrack();\n\t\t\t}')
  replace('\t\t\tconst agent = machine;\n\t\t\tassertLive();', '\t\t\tconst agent = machine;\n\t\t\tthis.ownedHandles.set(agent, dispose);\n\t\t\tassertLive();')
  return source
}

export function patchTypes(source) {
  if (source.includes('releaseExact(agent: Agent)')) return source
  return source.replace('    private readonly ownership;', '    private readonly ownership;\n    /** Release only this exact live Agent through its existing owned handle. */\n    releaseExact(agent: Agent): Promise<void>;')
}

// Explicit deployment only. Backups and test validation are done by the task's
// deployment script before calling this helper; upgrades require re-validation.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--apply' || !process.argv[3]) throw new Error('usage: --apply <dsh-agent-loop package directory>')
  const dir = process.argv[3]
  for (const [relative, patch] of [['lib/index.js', patchAgentLoop], ['lib/types/index.d.ts', patchTypes]]) {
    const file = resolve(dir, relative)
    const text = readFileSync(file, 'utf8')
    const crlf = text.includes('\r\n')
    const updated = patch(text.replaceAll('\r\n', '\n'))
    writeFileSync(file, crlf ? updated.replaceAll('\n', '\r\n') : updated)
  }
}
