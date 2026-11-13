// Root package owns the only client registration. Loading the legacy standalone
// UI entry directly makes DSH discover its second dsh.client declaration.
export { name, inject, apply } from '../packages/fish-brain-ui/lib/index.js'
