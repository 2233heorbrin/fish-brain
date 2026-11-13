import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFishAgent } from '../../../internal/agent-scope.js'

import {
  classifyTask, decideFinalStatus, decideUnknownAction, nextRetryState,
  planExecution, reconcileTaskLevel, reviewEvidence, validateExecutionPlan,
  validateWorkerReport,
} from '../../thinking-core/src/index.mjs'

const brainPath = (rel) => {
  const root = (process.env.FISH_BRAIN_ROOT || '').replace(/[\\/]+$/, '')
  return root ? root + '/' + rel : rel
}

export const name = 'dsh-agent-thinking'
export const inject = ['agents']
export const CORE = Object.freeze({
  path: fileURLToPath(new URL('../../thinking-core/src/core.mjs', import.meta.url)),
  version: '1.1.0-fish.1',
  sha256: 'AAE3E31512E545D0BAB639192DD61EFF496517D01E130AF4615F192616FE573F',
})
export const DEFAULTS = Object.freeze({
  thinkingEnabled: false,
  parallelWorkersEnabled: false,
  stateDir: brainPath('脑区运行状态/思考'),
  runtimeCardPath: brainPath('思考/策略/思考运行卡.txt'),
  capabilityIndexPath: brainPath('思考/能力索引.json'),
  order: 138,
  includeSubagents: false,
  maximumSeenEvents: 100,
})

function sha256Buffer(value) { return createHash('sha256').update(value).digest('hex').toUpperCase() }
function sha256File(file) { return sha256Buffer(fs.readFileSync(file)) }
function textBlocks(content) { return (Array.isArray(content) ? content : []).filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join(' ').trim() }
function sessionIdOf(session) { return String(session?.id || session?.header?.id || 'unknown-session') }
function isChildSession(session) { return Boolean(session?.header?.parentSession || session?.parentSession || session?.parent) }
function messageTextOf(message) { return message?.role === 'user' && message?.source?.kind === 'user' ? textBlocks(message.content) : '' }
export function stableEventIdentity(session, message, seq = null) {
  if (message?.id != null && String(message.id)) return 'message:' + String(message.id)
  const numericSeq = Number(seq ?? message?.seq)
  const sessionId = sessionIdOf(session)
  if (sessionId !== 'unknown-session' && Number.isFinite(numericSeq)) return 'session:' + sessionId + ':seq:' + numericSeq
  return ''
}
function latestEligibleUserMessage(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return null
  const events = session.snapshotEvents() || []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (!messageTextOf(message)) continue
    return {message, seq:event.seq}
  }
  return null
}

export function verifyCore() {
  const actual = sha256File(CORE.path)
  if (actual !== CORE.sha256) throw new Error('dsh-agent-thinking core SHA-256 mismatch: ' + actual)
  return actual
}

export function loadRuntimeCard(file = DEFAULTS.runtimeCardPath) {
  const card = fs.readFileSync(file, 'utf8').trim()
  if ([...card].length > 500) throw new Error('thinking runtime card exceeds 500 characters')
  return card
}

export function classifyText(text) {
  const value = String(text || '').trim()
  const local = /(修改|创建|新增|修复|测试|验证|构建|制作|开发|搭建|接入|配置|重启|迁移|更新|安装|文件|目录|代码|脚本|Canary)/i
  const cross = /(人格.*记忆|记忆.*心情|心情.*思考|跨脑区|跨系统|多个交付|Superagent|Worker)/i
  const sideEffects = []
  if (/(发送|评论|私信|上传|发布(?!的?(?:计划|版本|契约|证据|结果)))/i.test(value)) sideEffects.push('external-send')
  if (/(删除|清空)/i.test(value)) sideEffects.push('delete')
  if (/(切换生产|生产切换)/i.test(value)) sideEffects.push('production-switch')
  if (/(权限|授权|凭据)/i.test(value)) sideEffects.push('permission-change')
  if (/(不可逆|付款|购买)/i.test(value)) sideEffects.push('irreversible')
  const signals = {
    stepCount: local.test(value) ? 2 : 1,
    localWrite: local.test(value),
    hasDependencies: /(依赖|前置|然后|之后|先.+再)/i.test(value),
    requiresRollback: /(回退|回滚|恢复基线)/i.test(value),
    crossRegion: cross.test(value),
    crossSystem: /跨系统/i.test(value),
    productionData: /(生产数据|生产配置|生产记忆)/i.test(value),
    multipleDeliverables: /(多个交付|分别生成|同时完成)/i.test(value),
    irreversible: sideEffects.includes('irreversible'),
    sideEffects,
  }
  const route = classifyTask(signals)
  const ambiguous = value.length > 300 || /(评估一下|看情况|酌情|可能需要)/i.test(value)
  return {...route, ambiguous, signals}
}

function realFixture(text) {
  if (/(JSON|Markdown|数据转换|转换验收)/i.test(text)) return {
    capability:'worker.data.transform', action:'读取 input.json，按 id 升序生成 output.json，并生成包含三行数据的 output.md',
    target:'worker-workspace', inputs:{input:'input.json',jsonOutput:'output.json',markdownOutput:'output.md',sortKey:'id'},
    criterion:'转换输出结构正确、按 id 升序且文件哈希可验证',
  }
  if (/(玩具\s*Node|Node\s*项目|修复[^。；\n]*Node|node\s*--test)/i.test(text)) return {
    capability:'worker.node.repair-test', action:'读取玩具 Node 项目，修复 sum 实现并运行固定 node --test',
    target:'worker-workspace', inputs:{source:'src/sum.mjs',test:'test/sum.test.mjs',command:'node --test'},
    criterion:'玩具项目测试退出码为 0，修复文件和测试输出哈希可验证',
  }
  return {
    capability:'worker.workspace.generate', action:'按固定规范生成 generated.txt，内容为 FISH-RUNTIME-DRIVER-RC2',
    target:'worker-workspace', inputs:{output:'generated.txt',content:'FISH-RUNTIME-DRIVER-RC2\n'},
    criterion:'generated.txt 内容和 SHA-256 与固定规范一致',
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

export function extractParallelCandidate(text) {
  const value = String(text || '').trim()
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  const candidates = [value, ...fenced.map((match) => match[1].trim())]
  for (const candidateText of candidates) {
    const parsed = parseJsonObject(candidateText)
    if (parsed && Object.hasOwn(parsed, 'parallelCandidate')) {
      return {present:true,candidate:parsed.parallelCandidate}
    }
  }
  return {present:false,candidate:null}
}

function planFor(route, taskId, text, now = Date.now(), config = DEFAULTS) {
  if (route.level === 'small') return null
  const structured = extractParallelCandidate(text)
  if (structured.present) {
    if (config.parallelWorkersEnabled !== true) {
      route.parallelReview = {valid:false,status:'replan-required',errors:[{code:'parallel.disabled',message:'parallelWorkersEnabled=false'}],unverified:['parallel-disabled']}
      return null
    }
    const reviewed = planExecution({parallelCandidate:structured.candidate})
    route.parallelReview = reviewed
    return reviewed.valid ? reviewed.plan : null
  }
  const explicitlyMock = /(dispatchMode\s*=\s*mock|保持[^。；\n]*mock|不要[^。；\n]*真实\s*Worker|不创建[^。；\n]*真实\s*Worker|禁止[^。；\n]*真实\s*Worker)/i.test(text)
  const explicitlyReal = /(dispatchMode\s*=\s*real|真实\s*Worker|真实工作区)/i.test(text)
  const dispatchMode = explicitlyReal && !explicitlyMock ? 'real' : 'mock'
  const riskLevel = route.sideEffects.length ? 'external-write' : 'local-reversible'
  if (dispatchMode === 'real') {
    const fixture = realFixture(text)
    const workspace = 'workspaces/workers/' + taskId
    const approvalRequired = route.level === 'large'
    const approved = /已批准|批准执行|approval\s*=\s*approved/i.test(text)
    const worker = {id:'real-worker-1',workspace,writeTargets:[workspace]}
    return {
      schema:'fish-execution-plan-v1',dispatchMode,taskId,planVersion:1,createdAt:new Date(now).toISOString(),sourceRegion:'思考',
      taskLevel:route.level,goal:'完成一个隔离真实 Worker ' + fixture.capability + ' 验收并生成独立权威证据',riskLevel,
      approval:{required:approvalRequired,status:approvalRequired?(approved?'approved':'pending'):'not-required',basis:approvalRequired?'大型真实执行必须先获得批准':'隔离、可回退且只写 Worker 临时工作区'},
      acceptanceCriteria:[{id:'result-evidence',authority:'thinking.review',description:fixture.criterion}],
      steps:[{id:'execute',workerId:worker.id,dependsOn:[],capability:fixture.capability,action:fixture.action,target:fixture.target,inputs:fixture.inputs,phase:'execute',acceptanceCriteriaIds:['result-evidence'],budget:{maxWallTimeMs:120000,maxTokens:12000,maxCost:0.03,maxSteps:12},maxAttempts:1,idempotent:true,recovery:'保留异常工作区；成功裁定后清理',credentialRefs:[]}],
      parallelAllowed:false,conflictCheckBeforeMerge:true,workers:[worker],
      finalSuccessCriteria:['唯一权威证据通过且思考层裁定 pass；真实 commit 保持 unavailable'],
    }
  }
  const worker = {id:'mock-worker-1',workspace:'workspaces/workers/mock-worker-1',writeTargets:['workspaces/workers/mock-worker-1']}
  const budget = {maxWallTimeMs:30000,maxTokens:0,maxCost:0,maxSteps:1}
  const step = (id, capability, action, target, phase = 'execute', dependsOn = []) => ({
    id,workerId:worker.id,dependsOn,capability,action,target,inputs:{},phase,
    acceptanceCriteriaIds:['result-evidence'],budget,maxAttempts:1,idempotent:true,
    recovery:'discard isolated Mock fixture',credentialRefs:[],
  })
  const steps = [
    step('inspect','thinking.review','读取当前请求所需的最少证据','workspaces/workers/mock-worker-1'),
    step('verify','thinking.review','按唯一权威判据复核结果','workspaces/workers/mock-worker-1','execute',['inspect']),
  ]
  if (route.level === 'large') steps.splice(1, 0, step('approval-gate','thinking.decide','在高副作用动作前检查授权和停止条件','side-effect-boundary','prepare',['inspect']))
  return {
    schema:'fish-execution-plan-v1',dispatchMode,taskId,planVersion:1,createdAt:new Date(now).toISOString(),sourceRegion:'思考',
    taskLevel:route.level,goal:'完成当前隔离 ' + route.level + ' 任务并生成权威证据',riskLevel,
    approval:{required:false,status:'not-required',basis:'当前计划只允许隔离 Mock prepare 或本地可回退步骤'},
    acceptanceCriteria:[{id:'result-evidence',authority:'thinking.review',description:'执行证据支持最终三态裁定'}],
    steps,parallelAllowed:false,conflictCheckBeforeMerge:true,workers:[worker],
    finalSuccessCriteria:['全部权威验收证据通过且思考层裁定 pass'],
  }
}

function renderRoute(route, plan) {
  const lines = ['【肥鱼思考路由】最低等级：' + route.level + '；分类方式：本地确定性规则；额外模型调用：0。']
  if (route.parallelReview && route.parallelReview.valid !== true) {
    const codes = (route.parallelReview.errors || []).map((item) => item.code || item.message).filter(Boolean)
    lines.push('结构化 parallelCandidate 未发布：replan-required；未验证项：' + (codes.join(',') || 'parallel-candidate') + '。不得调用执行工具或自行改写计划。')
  }
  if (route.ambiguous) lines.push('当前分类存在歧义；主模型只可在本次请求内基于新证据升级或有证据降级。')
  if (route.level === 'small') lines.push('直接给结论或执行最小步骤；不展示内部思考，不读取详细思考规范。')
  if (route.level === 'medium' && plan) lines.push('内部执行 planVersion=' + plan.planVersion + ' 的可回退计划；完成声明必须经过证据复核。')
  if (route.level === 'large' && plan) lines.push('先向用户展示关键决策与 planVersion=' + plan.planVersion + ' 计划；高副作用动作在授权门前停止。')
  if (plan) {
    lines.push('以下 JSON 是思考层已发布的唯一权威计划。调用 execution_submit_plan 时必须把它原样放入 plan 字段，不得自行增删、重写或另造计划；无法原样提交时返回 replan-required。')
    lines.push('【可提交Fish计划】' + JSON.stringify(plan))
  }
  return lines.join(String.fromCharCode(10))
}

function initialState(coreHash, cardHash, indexHash) {
  return {schema:'fish-thinking-canary-runtime-v1',coreHash,cardHash,indexHash,lastTask:null,seenEventHashes:[],updatedAt:null}
}

export class ThinkingRuntime {
  constructor(config = {}) {
    this.config = {...DEFAULTS, ...config}
    this.stateDir = path.resolve(this.config.stateDir)
    this.stateFile = path.join(this.stateDir, 'runtime.json')
    this.auditFile = path.join(this.stateDir, 'audit.jsonl')
    this.coreHash = verifyCore()
    this.runtimeCard = loadRuntimeCard(this.config.runtimeCardPath)
    this.cardHash = sha256Buffer(Buffer.from(this.runtimeCard, 'utf8'))
    this.indexHash = sha256File(this.config.capabilityIndexPath)
    this.state = null
  }

  load() {
    if (this.state) return this.state
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      this.state = value?.schema === 'fish-thinking-canary-runtime-v1' ? value : initialState(this.coreHash, this.cardHash, this.indexHash)
    } catch { this.state = initialState(this.coreHash, this.cardHash, this.indexHash) }
    const metadataChanged = this.state.coreHash !== this.coreHash || this.state.cardHash !== this.cardHash || this.state.indexHash !== this.indexHash
    if (metadataChanged) {
      this.state = {...this.state, coreHash:this.coreHash, cardHash:this.cardHash, indexHash:this.indexHash}
      this.persist()
    }
    return this.state
  }

  persist() {
    fs.mkdirSync(this.stateDir, {recursive:true})
    const temp = this.stateFile + '.tmp-' + process.pid
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2) + String.fromCharCode(10), 'utf8')
    fs.renameSync(temp, this.stateFile)
  }

  ingestMessage(agent, message, now = Date.now(), seq = null) {
    const session = agent?.session || agent
    const text = messageTextOf(message)
    if (!text) return {accepted:false,reason:'not-eligible-user-text'}
    if (!this.config.includeSubagents && isChildSession(session)) return {accepted:false,reason:'child-session'}
    const sessionId = sessionIdOf(session)
    const eventKey = stableEventIdentity(session, message, seq)
    if (!eventKey) return {accepted:false,reason:'missing-stable-event-identity'}
    const eventHash = sha256Buffer(Buffer.from(eventKey, 'utf8'))
    const state = this.load()
    if ((state.seenEventHashes || []).includes(eventHash)) return {accepted:true,duplicate:true,lastTask:state.lastTask}
    const route = classifyText(text)
    const taskId = 'thinking-' + sha256Buffer(Buffer.from(sessionId + ':' + eventKey, 'utf8')).slice(0,16).toLowerCase()
    const plan = planFor(route, taskId, text, now, this.config)
    const task = {taskId,planVersion:plan?.planVersion || null,level:route.level,ambiguous:route.ambiguous,sideEffects:route.sideEffects,routeText:renderRoute(route,plan),planHash:plan?sha256Buffer(Buffer.from(JSON.stringify(plan),'utf8')):null,at:now}
    state.lastTask = task
    state.seenEventHashes = [...(state.seenEventHashes || []), eventHash].slice(-this.config.maximumSeenEvents)
    state.updatedAt = now
    this.persist()
    fs.appendFileSync(this.auditFile, JSON.stringify({schema:'fish-thinking-route-audit-v1',at:now,taskId,planVersion:task.planVersion,level:task.level,ambiguous:task.ambiguous,sideEffects:task.sideEffects,planHash:task.planHash,sessionRef:sha256Buffer(Buffer.from(sessionId,'utf8')).slice(0,16)}) + String.fromCharCode(10), 'utf8')
    return {accepted:true,duplicate:false,route,plan,task}
  }

  promptText() {
    const state = this.load()
    return this.runtimeCard + (state.lastTask?.routeText ? String.fromCharCode(10) + state.lastTask.routeText : '')
  }
}

export const capabilities = Object.freeze({'thinking.route':classifyText,'thinking.review':reviewEvidence,'thinking.decide':decideUnknownAction,'thinking.plan':validateExecutionPlan,'thinking.replan':nextRetryState})
export function invoke(capabilityId,input){const handler=capabilities[capabilityId];return handler?{status:'ok',capabilityId,output:handler(input)}:{status:'unavailable',capabilityId}}
export const contractHelpers = Object.freeze({decideFinalStatus,reconcileTaskLevel,validateWorkerReport})

export function apply(ctx, config = {}) {
  const cfg = {...DEFAULTS, ...config}
  if (cfg.thinkingEnabled !== true) return
  const runtime = new ThinkingRuntime(cfg)
  runtime.load()
  const mounted = new Map()
  const mountAgent = (agent) => {
    if (!isFishAgent(ctx, agent)) return
    if (!agent?.id || mounted.has(agent.id) || (!cfg.includeSubagents && isChildSession(agent.session))) return
    const stops = []
    stops.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      try {
        const event = latestEligibleUserMessage(agent.session)
        if (event) runtime.ingestMessage(agent, event.message, Date.now(), event.seq)
      } catch (error) { ctx.logger?.warn?.('dsh-agent-thinking scoped assemble failed: ' + String(error?.message || error)) }
      const accepted = await next()
      const contexts = Array.isArray(accepted?.contexts) ? accepted.contexts.filter((entry) => entry?.name !== 'agent:thinking') : []
      return {...accepted, contexts:[...contexts,{name:'agent:thinking',text:runtime.promptText(),interpolate:false}]}
    }, {prepend:true}))
    stops.push(agent.ctx.systemPrompt.context({name:'agent:thinking',order:cfg.order,required:true,interpolate:false,text:() => runtime.promptText()}))
    mounted.set(agent.id, () => { for (const stop of stops.reverse()) if (typeof stop === 'function') stop() })
  }
  let stopAgentCreated
  if ('agents' in ctx && ctx.agents) {
    if (!cfg.scopeOnly) for (const agent of ctx.agents.list() || []) mountAgent(agent)
    stopAgentCreated = ctx.on('agent/created', ({agent}) => { mountAgent(agent) })
  }
  const stopAssemble = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (!isFishAgent(ctx, context?.agent)) return next()
    try {
      const agent = context?.agent
      const event = latestEligibleUserMessage(agent?.session)
      if (event) runtime.ingestMessage(agent, event.message, Date.now(), event.seq)
    } catch (error) { ctx.logger?.warn?.('dsh-agent-thinking assemble failed: ' + String(error?.message || error)) }
    const accepted = await next()
    const contexts = Array.isArray(accepted?.contexts) ? accepted.contexts.filter((entry) => entry?.name !== 'agent:thinking') : []
    return {...accepted, contexts:[...contexts,{name:'agent:thinking',text:runtime.promptText(),interpolate:false}]}
  }, {prepend:true})
  const stopPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    if (!isFishAgent(ctx, payload?.agent)) return next()
    try { for (const message of payload?.messages || []) runtime.ingestMessage(payload.agent, message) }
    catch (error) { ctx.logger?.warn?.('dsh-agent-thinking pre-step failed: ' + String(error?.message || error)) }
    return next()
  }, {prepend:true})
  const promptEntry = {name:'agent:thinking',order:cfg.order,required:true,text:context => {
      if (!isFishAgent(ctx, context?.agent)) return ''
      try { return runtime.promptText() }
      catch (error) { ctx.logger?.warn?.('dsh-agent-thinking render failed: ' + String(error?.message || error)); return '' }
    }}
  const stopPrompt = ctx.inject(['systemPrompt'], (scope) => { scope.systemPrompt.context(promptEntry) })
  return () => { for (const stop of mounted.values()) stop(); if (typeof stopAgentCreated === 'function') stopAgentCreated(); if (typeof stopPrompt === 'function') stopPrompt(); if (typeof stopPreStep === 'function') stopPreStep(); if (typeof stopAssemble === 'function') stopAssemble() }
}

export default {name,inject,apply}
