import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ExecutionContractError } from './contracts.mjs'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
export class AtomicTicketStore {
  constructor(filePath) { this.filePath = filePath; this.lockPath = filePath + '.lock' }
  async withLock(action, attempts = 40) {
    await mkdir(dirname(this.filePath), { recursive: true })
    for (let index = 0; index < attempts; index += 1) {
      try { const handle = await open(this.lockPath, 'wx'); try { return await action() } finally { await handle.close(); await rm(this.lockPath, { force: true }) } }
      catch (error) { if (error?.code !== 'EEXIST') throw error; await wait(5) }
    }
    throw new ExecutionContractError('store-locked', 'ticket store lock could not be acquired')
  }
  async load() { try { return JSON.parse(await readFile(this.filePath, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return { schema: 'fish-execution-store-v1', tasks: {} }; throw error } }
  async save(state) { return this.withLock(async () => { const temp = this.filePath + '.tmp-' + process.pid + '-' + Date.now(); await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8'); await rename(temp, this.filePath); return state }) }
}
