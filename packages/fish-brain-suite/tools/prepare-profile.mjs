import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Produce a reviewable candidate; never change the user's selection/package.json.
const [anchor, profileFile, outputFile] = process.argv.slice(2)
if (!outputFile) throw new Error('usage: <DSH install anchor> <profile patch> <candidate path>')
const req = createRequire(resolve(anchor))
const { load } = req('js-yaml')
const { entryListSchema } = req('@deepseek-ai/cordis-plugin-include')
const original = readFileSync(profileFile, 'utf8')
const rows = load(original, { schema: entryListSchema })
const fish = rows.flatMap(row => row.insert || []).find(row => row.id === 'preset-fish')
if (!fish) throw new Error('expected original fish declaration')
const plugins = structuredClone(fish.config.plugins)
plugins.find(row => row.id === 'dsh-agent-thinking').config.scopeOnly = true
writeFileSync(new URL('../fish-plugins.json', import.meta.url), JSON.stringify(plugins, null, 2) + '\n')
const start = original.indexOf('- insert:\n    - id: preset-fish')
const end = original.indexOf('\n- id: credentials', start)
if (start < 0 || end < 0) throw new Error('profile fish block anchors changed')
let result = original.slice(0, start) + `- insert:
    - id: fish-brain-lifecycle
      name: "fish-brain-suite/control"
      config:
        epochPath: "D:/deepseek框架/DSH/profiles/fish-main/fish-brain-lifecycle.json"
` + original.slice(end)
for (const id of ['fish-agent-collab-gate', 'fish-engineering-tools-gate']) {
  const from = result.indexOf('- insert:\n    - id: ' + id)
  const tail = result.slice(from + 1).search(/\n- (?:id|insert):/)
  const to = tail < 0 ? result.length : from + 1 + tail
  if (from < 0) throw new Error('missing gate ' + id)
  result = result.slice(0, from) + result.slice(to)
}
load(result, { schema: entryListSchema })
writeFileSync(outputFile, result)
