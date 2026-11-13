import { ExecutionContractError, deepFreeze } from './contracts.mjs'
export const DRIVER_METHODS = ['probeCapabilities', 'createSession', 'deliverInput', 'cancel', 'readStatus', 'close']
export function validateRuntimeDriver(driver) {
  if (!driver || typeof driver !== 'object') throw new ExecutionContractError('invalid-driver', 'runtime driver must be an object')
  for (const method of DRIVER_METHODS) if (typeof driver[method] !== 'function') throw new ExecutionContractError('invalid-driver', 'runtime driver missing method ' + method)
  return driver
}
export const unavailableDshDriver = deepFreeze({
  id: 'dsh-runtime-driver', version: '0.0.0-interface-only', enabled: false,
  async probeCapabilities() { return { schema: 'fish-runtime-capability-report-v1', runtime: 'DSH', observedVersion: '0.2.1-rc.2', status: 'unavailable', realDispatch: false, capabilities: DRIVER_METHODS.map(id => ({ id, status: 'contract-only' })) } },
  async createSession() { throw new ExecutionContractError('real-dispatch-unavailable', 'real DSH sessions are unavailable in offline Mock stage') },
  async deliverInput() { throw new ExecutionContractError('real-dispatch-unavailable', 'real DSH input delivery is unavailable') },
  async cancel() { return { status: 'not-running' } }, async readStatus() { return { status: 'unavailable' } }, async close() { return { status: 'closed' } },
})
