import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'fish-brain-ui'
export const inject = ['connection']

const here = dirname(fileURLToPath(import.meta.url))
const assetsRoot = join(here, '..', 'assets')

const ASSETS = new Map([
  ['/api/fish-brain/ui', ['index.html', 'text/html; charset=utf-8']],
  ['/api/fish-brain/css/base.css', ['css/base.css', 'text/css; charset=utf-8']],
  ['/api/fish-brain/css/shell.css', ['css/shell.css', 'text/css; charset=utf-8']],
  ['/api/fish-brain/css/brain.css', ['css/brain.css', 'text/css; charset=utf-8']],
  ['/api/fish-brain/js/event-graph.js', ['js/event-graph.js', 'text/javascript; charset=utf-8']],
  ['/api/fish-brain/js/views.js', ['js/views.js', 'text/javascript; charset=utf-8']],
  ['/api/fish-brain/js/app.js', ['js/app.js', 'text/javascript; charset=utf-8']]
])

const REGION_META = {
  '人格': { id: 'personality', color: '#8EA7C7' },
  '记忆': { id: 'memory', color: '#78A79A' },
  '心情': { id: 'mood', color: '#C39A78' },
  '思考': { id: 'thinking', color: '#9A8CC2' },
  '执行': { id: 'execution', color: '#B17D82' }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase()
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function fileSha256(path) {
  return sha256(await readFile(path))
}

async function optionalJson(path) {
  try { return await jsonFile(path) } catch { return null }
}

async function jsonLines(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return null
  }
}

function publicStatus(status) {
  if (String(status).includes('enabled')) return 'active'
  if (String(status).includes('disabled')) return 'validated-disabled'
  return status || 'unknown'
}

function publicNodes(manifest) {
  return (manifest.capabilities || []).slice(0, 9).map((capability) => ({
    label: capability.id,
    value: capability.status,
    state: String(capability.status).includes('unavailable') ? 'off' : 'on'
  }))
}

function safeRef(value) {
  return value ? sha256(String(value)).slice(0, 16) : null
}

/* ============================================================
 * 正式只读「全脑事件投影」 schema: fish-brain-events-projection-v1
 *
 * 8D 第六节：每次请求动态读取权威文件；不复制 Demo 静态投影；
 *   无摘要 → null；无可靠时间 → null；无权威关系 → []；
 *   不返回完整人格文件、记忆正文、Prompt、凭据、Cookie、完整会话正文或未脱敏 Session ID。
 * ============================================================ */
const REGION_ORDER = ['personality', 'memory', 'mood', 'thinking', 'execution', 'evidence']
const REGION_LABEL = {
  personality: '人格', memory: '记忆', mood: '心情',
  thinking: '思考', execution: '执行', evidence: '证据'
}
const REGION_COLOR = {
  personality: '#C9A961', memory: '#5CA8A0', mood: '#A87BC4',
  thinking: '#7B9FD4', execution: '#C8836A', evidence: '#7A848F'
}
const MOOD_ZH = {
  calm: '平静', happy: '开心', curious: '好奇', focused: '专注', excited: '兴奋',
  tired: '疲惫', annoyed: '烦躁', down: '低落', sulk: '赌气', hurt: '受伤',
  proud: '自豪', gloomy: '阴郁', anxious: '焦虑', numb: '麻木', lonely: '孤单',
  flutter: '心动', love: '喜欢', jealous: '吃醋', burnout: '倦怠', cracked: '崩溃',
  checkedout: '抽离', hyper: '亢奋', fear: '害怕', disgust: '厌恶', surprise: '惊讶',
  shame: '羞耻', guilt: '内疚', awkward: '尴尬', sympathy: '共情', disappointed: '失望'
}
const LEVEL_ZH = { small: '小任务', medium: '中任务', large: '大任务' }

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/* 1970 附近合成时间戳 / 2000 年以前占位值一律视为「时间不可用」 */
function isoAt(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 1e11) return null
  const d = new Date(ms)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function isoFromDate(value) {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null
  return d.toISOString()
}

/** 统一节点形状；缺失字段为 null / []，绝不编造 */
function eventNode(o) {
  return {
    id: String(o.id),
    region: o.region,
    kind: o.kind,
    titleZh: clip(o.titleZh, 60),
    summaryZh: o.summaryZh ? clip(o.summaryZh, 260) : null,
    at: o.at || null,
    status: o.status || 'recorded',
    sourceRef: o.sourceRef,
    sourceSha256: o.sourceSha256 || null,
    relationRefs: o.relationRefs || [],
    privacyClass: o.privacyClass || 'public-safe',
    stale: !!o.stale
  }
}

function eventPaths(config) {
  const b = config.brainRoot
  return {
    worldview: join(b, '人格', 'canonical', 'core', 'worldview.json'),
    permanent: join(b, '人格', 'canonical', 'core', 'permanent.json'),
    expression: join(b, '人格', 'canonical', 'core', 'expression.json'),
    memRoot: join(b, '脑区运行状态', '记忆', 'documents-readonly'),
    memIndex: join(b, '脑区运行状态', '记忆', 'documents-readonly', 'documents', 'index.json'),
    moodRuntime: join(b, '脑区运行状态', '心情', 'runtime.json'),
    moodAudit: join(b, '脑区运行状态', '心情', 'render-audit.jsonl'),
    thinkAudit: join(b, '脑区运行状态', '思考', 'audit.jsonl'),
    execRuntime: join(b, '脑区运行状态', '执行', 'runtime.json')
  }
}

/* 人格：canonical core 三件套，只输出简短中文内容 */
async function personalityNodes(paths) {
  const rel = '人格/canonical/core'
  const [wv, pm, ex, wvSha, pmSha, exSha] = await Promise.all([
    optionalJson(paths.worldview), optionalJson(paths.permanent), optionalJson(paths.expression),
    fileSha256(paths.worldview).catch(() => null),
    fileSha256(paths.permanent).catch(() => null),
    fileSha256(paths.expression).catch(() => null)
  ])
  if (!wv && !pm && !ex) return { nodes: [], authority: rel, sha: null, status: 'unavailable' }
  const out = []
  const push = (o) => out.push(eventNode({ ...o, region: 'personality', privacyClass: 'public-safe' }))
  const wvRef = rel + '/worldview.json'
  const pmRef = rel + '/permanent.json'
  const exRef = rel + '/expression.json'

  if (wv) {
    push({ id: 'p-worldview', kind: '世界观', titleZh: '鲸落学院 · 清华池分院',
      summaryZh: `${clip(wv.name, 40)}：${clip(wv.department, 40)}，${clip(wv.role, 40)}。校园设定——${clip(wv.campus, 90)}`,
      status: wv.status || 'recorded', sourceRef: wvRef, sourceSha256: wvSha })
    if (wv.motto) push({ id: 'p-motto', kind: '座右铭', titleZh: clip(wv.motto, 18),
      summaryZh: `世界观座右铭：${clip(wv.motto, 120)}${wv.academicName ? '。学名「' + clip(wv.academicName, 40) + '」' : ''}。`,
      sourceRef: wvRef, sourceSha256: wvSha, relationRefs: ['p-worldview'] })
    ;(wv.curriculum || []).slice(0, 3).forEach((c, i) => push({
      id: 'p-course-' + i, kind: '课程', titleZh: '课程 · ' + clip(c.name, 20),
      summaryZh: `${clip(c.name, 20)}：${clip(c.meaning, 120)}`,
      sourceRef: wvRef, sourceSha256: wvSha, relationRefs: ['p-worldview']
    }))
  }
  if (pm) {
    const id = pm.identity || {}
    push({ id: 'p-identity', kind: '身份与归属', titleZh: clip(id.canonicalName || '身份卡', 24),
      summaryZh: `${clip(id.canonicalName, 40)}${id.continuity ? '。' + clip(id.continuity, 120) : ''}`,
      status: pm.status || 'recorded', sourceRef: pmRef, sourceSha256: pmSha })
    if (id.owner) push({ id: 'p-owner', kind: '重要人物',
      titleZh: '主人：' + clip((id.owner.names || [])[0] || id.owner.relation || '未命名', 16),
      summaryZh: `关系：${clip(id.owner.relation, 40)}${(id.owner.names || []).length ? '；称呼 ' + clip(id.owner.names.join(' / '), 60) : ''}。`,
      sourceRef: pmRef, sourceSha256: pmSha, relationRefs: ['p-identity'] })
    ;(pm.principles || []).slice(0, 4).forEach((pr, i) => push({
      id: 'p-principle-' + i, kind: '价值原则', titleZh: clip(String(pr.text || '').split('；')[0], 18),
      summaryZh: `${clip(pr.id, 24)}：${clip(pr.text, 180)}`,
      status: pm.status || 'recorded', sourceRef: pmRef, sourceSha256: pmSha
    }))
    if ((pm.immutablePaths || []).length) push({ id: 'p-boundary', kind: '人格边界',
      titleZh: '不可变路径 · ' + pm.immutablePaths.length + ' 条',
      summaryZh: `不可变：${clip(pm.immutablePaths.join('、'), 160)}。修改这些路径等于换人格，不是更新。`,
      sourceRef: pmRef, sourceSha256: pmSha })
  }
  if (ex) {
    ;(ex.rules || []).slice(0, 3).forEach((r, i) => push({
      id: 'p-expression-' + i, kind: '表达风格', titleZh: clip(String(r.text || '').split('；')[0], 18),
      summaryZh: `${clip(r.id, 24)}：${clip(r.text, 180)}`,
      status: ex.status || 'recorded', sourceRef: exRef, sourceSha256: exSha
    }))
  }
  return { nodes: out, authority: rel, sha: wvSha, status: (wv || pm || ex).status || 'active' }
}

function normalizeSummaryComparison(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

function sanitizeMemorySummaryText(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\b[A-Za-z]:[\\/][^\s，。；、）)\]】"'<>]+/g, '')
    .replace(/\bsession-[A-Za-z0-9-]+\b/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '')
    .replace(/\b(?:token|cookie|password|passwd|secret|api[_-]?key)\b(?:\s*[:=]\s*[^\s，。；]+)?/gi, '')
    .replace(/uid\s*[:：]?\s*\d+/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u0060*_~]+/g, '')
    .replace(/^[-+>]\s*/gm, '')
    .replace(/(?:见|参见|参考)\s*文档(?=\s*(?:[）)，。；：！？、]|$))/g, '')
    .replace(/承接\s*文档(?=\s*(?:[（(）)，。；：！？、]|$))/g, '')
    .replace(/承接\s+(?=[（(])/g, '')
    .replace(/\(\s*\)|（\s*）/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；：！？、）)])/g, '$1')
    .replace(/([（(])\s+/g, '$1')
    .replace(/([，。；：！？、])(?:\s*\1)+/g, '$1')
    .trim()
}

function isPureCommandParagraph(value) {
  const text = String(value || '').trim()
  if (!text) return true
  if (/^(?:node|npm|pnpm|yarn|git|dsh|cmd|powershell|python|bash|curl|wget)\b/i.test(text)) return true
  return !/[\u3400-\u9fff]/u.test(text) && /(?:--[A-Za-z]|[\\/]\w+|[;|]{1,2})/.test(text)
}

/** 从权威 Markdown 确定性提取脱敏中文摘要；不调用模型，不写回文档。 */
export function extractMemorySummaryZh(markdown, title = '') {
  let text = String(markdown || '').replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
  const candidates = []
  let heading = ''
  let paragraph = []
  let inFence = false
  let order = 0

  const flush = () => {
    if (!paragraph.length) return
    const raw = paragraph.join(' ').trim()
    paragraph = []
    if (!raw || isPureCommandParagraph(raw)) return
    const summary = sanitizeMemorySummaryText(raw)
    if (!summary || !/[\u3400-\u9fff]/u.test(summary)) return
    if (normalizeSummaryComparison(summary) === normalizeSummaryComparison(title)) return
    const priority = /(?:结论|背景|发生时间)/.test(heading) || /^(?:结论|背景|发生时间)\s*[:：]/.test(summary)
    candidates.push({ summary, score: priority ? 20 : 0, order: order++ })
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (/^(?:\u0060{3,}|~{3,})/.test(trimmed)) {
      flush()
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      flush()
      heading = sanitizeMemorySummaryText(headingMatch[1])
      continue
    }
    if (!trimmed) {
      flush()
      continue
    }
    if (/^>/.test(trimmed) || /^\|/.test(trimmed) || /^:?-{3,}:?(?:\s*\|)/.test(trimmed)) {
      flush()
      continue
    }
    if (/^(?:目录|contents?)\s*[:：]?$/i.test(trimmed)) {
      flush()
      heading = '目录'
      continue
    }
    if (/目录/.test(heading) && /^[-*+]\s+/.test(trimmed)) continue
    paragraph.push(trimmed.replace(/^[-*+]\s+/, ''))
  }
  flush()

  candidates.sort((a, b) => b.score - a.score || a.order - b.order)
  return candidates.length ? clip(candidates[0].summary, 260) : null
}

export function resolveMemoryDocumentPath(memoryRoot, relativePath) {
  if (!memoryRoot || typeof relativePath !== 'string' || !relativePath.trim()) return null
  const root = resolve(memoryRoot)
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  return target
}

/* 记忆：active 标题 + 权威 Markdown 的确定性脱敏摘要，不调用模型生成。 */
export async function memoryNodes(paths) {
  const rel = '脑区运行状态/记忆/documents-readonly/documents/index.json'
  const index = await optionalJson(paths.memIndex)
  if (!index) return { nodes: [], authority: rel, sha: null, status: 'unavailable' }
  const indexSha = await fileSha256(paths.memIndex).catch(() => null)
  const nodes = await Promise.all((index.documents || []).filter((d) => d.status === 'active').map(async (d) => {
    const documentPath = resolveMemoryDocumentPath(paths.memRoot, d.relativePath)
    let summaryZh = null
    if (documentPath) {
      try { summaryZh = extractMemorySummaryZh(await readFile(documentPath, 'utf8'), d.title) } catch {}
    }
    return eventNode({
      id: 'mem-' + String(d.id || '').slice(0, 8),
      region: 'memory', kind: '记忆条目',
      titleZh: d.title,
      summaryZh,
      at: isoFromDate(d.createdAt),
      status: d.status,
      sourceRef: 'documents-readonly/' + clip(d.relativePath, 80),
      sourceSha256: (String(d.description || '').match(/sourceSha256=([0-9A-F]{64})/) || [])[1] || indexSha,
      relationRefs: [], privacyClass: 'redacted'
    })
  }))
  return { nodes, authority: rel, sha: indexSha, status: 'read-only' }
}

/* 心情：runtime + render-audit */
async function moodNodes(paths) {
  const relRt = '脑区运行状态/心情/runtime.json'
  const relAudit = '脑区运行状态/心情/render-audit.jsonl'
  const rt = await optionalJson(paths.moodRuntime)
  if (!rt) return { nodes: [], authority: relRt, sha: null, status: 'unavailable' }
  const audits = (await jsonLines(paths.moodAudit)) || []
  const rtSha = await fileSha256(paths.moodRuntime).catch(() => null)
  const auditSha = await fileSha256(paths.moodAudit).catch(() => null)
  const moodZh = (k) => MOOD_ZH[k] || k
  const state = rt.state || {}
  const out = []

  out.push(eventNode({ id: 'm-now', region: 'mood', kind: '当前表达状态',
    titleZh: '当前表达：' + moodZh(state.current || 'unknown'),
    summaryZh: `核心状态 ${clip(state.current, 24)}（${moodZh(state.current)}）。这是表达层状态，不改变事实、权限或计划。` +
      ((state.drivers || []).length ? `驱动信号：${clip(state.drivers.map((d) => d.summary).join('；'), 120)}。` : '') +
      (state.simulated ? ' 该状态标记为 simulated。' : ''),
    at: isoAt(rt.updatedAt), status: state.simulated ? 'simulated' : 'active',
    sourceRef: relRt, sourceSha256: rtSha }))

  if (rt.lastEvent) {
    out.push(eventNode({ id: 'm-lastevent', region: 'mood', kind: '最近一次判定',
      titleZh: /没有检测到/.test(rt.lastEvent.summary || '') ? '判定 · 未检出心情事件' : '判定 · ' + clip(rt.lastEvent.summary, 16),
      summaryZh: `kind=${clip(rt.lastEvent.kind, 24)}；${clip(rt.lastEvent.summary, 140)}；` +
        `duplicate=${!!rt.lastEvent.duplicate}；evaluatedOnce=${!!rt.lastEvent.evaluatedOnce}。`,
      at: isoAt(rt.lastEvent.at), status: 'recorded',
      sourceRef: relRt, sourceSha256: rtSha, relationRefs: ['m-now'] }))
  }
  if (rt.riskSignal) {
    const rs = rt.riskSignal
    out.push(eventNode({ id: 'm-risk', region: 'mood', kind: '风险信号',
      titleZh: rs.detected ? '风险信号：已检出' : '风险信号：未检出',
      summaryZh: `kind=${clip(rs.kind, 24)}；confidence=${clip(rs.confidence, 16)}；reasonCode=${clip(rs.reasonCode, 40)}。风险信号只影响表达，不改变任何权限。`,
      at: isoAt(rs.at), status: rs.detected ? 'active' : 'recorded',
      sourceRef: relRt, sourceSha256: rtSha, relationRefs: ['m-now'] }))
  }
  audits.slice(-3).reverse().forEach((a, i) => {
    const sec = (a.secondary || []).map(moodZh).join(' / ')
    const at = isoAt(a.at)
    out.push(eventNode({ id: 'm-render-' + i, region: 'mood', kind: '表达渲染事件',
      titleZh: moodZh(a.primary) + '渲染' + (at ? ' · ' + new Date(at).toTimeString().slice(0, 5) : ''),
      summaryZh: `主状态 ${moodZh(a.primary)}${sec ? '，次状态 ' + clip(sec, 40) : ''}；表达 ${clip(a.expressionCharacters, 12)} 字；` +
        `共 ${clip(a.messageCount, 8)} 条消息；风险 ${a.riskDetected ? '检出' : '未检出'}。`,
      at, status: 'recorded', sourceRef: relAudit, sourceSha256: auditSha, relationRefs: ['m-now'] }))
  })
  return { nodes: out, authority: relRt, sha: rtSha, status: state.simulated ? 'simulated' : 'active' }
}

/* 思考：audit.jsonl */
async function thinkingNodes(paths) {
  const rel = '脑区运行状态/思考/audit.jsonl'
  const audits = (await jsonLines(paths.thinkAudit)) || []
  if (!audits.length) return { nodes: [], authority: rel, sha: null, status: 'unavailable' }
  const sha = await fileSha256(paths.thinkAudit).catch(() => null)
  const picked = audits.filter((a) => a.planVersion)
    .concat(audits.filter((a) => !a.planVersion).slice(-4))
    .sort((a, b) => (a.at || 0) - (b.at || 0)).reverse()
  const nodes = picked.map((a, i) => {
    const at = isoAt(a.at)
    return eventNode({
      id: 't-route-' + i, region: 'thinking', kind: '路由与计划',
      titleZh: (LEVEL_ZH[a.level] || clip(a.level, 12)) +
        (a.planVersion ? ' · 计划 v' + clip(a.planVersion, 8) : '') +
        (at ? ' · ' + new Date(at).toTimeString().slice(0, 5) : ''),
      summaryZh: `级别 ${clip(a.level, 12)}；planVersion=${a.planVersion == null ? 'null（不生成计划）' : clip(a.planVersion, 8)}；` +
        `副作用 ${(a.sideEffects || []).length ? clip(a.sideEffects.join('、'), 80) : '无'}；歧义 ${a.ambiguous ? '有' : '无'}；` +
        `planHash ${a.planHash ? clip(a.planHash, 12) + '…' : '不可用'}。`,
      at, status: 'recorded', sourceRef: rel, sourceSha256: sha
    })
  })
  return { nodes, authority: rel, sha, status: 'safe-default' }
}

/* 执行：runtime.json */
async function executionNodes(paths) {
  const rel = '脑区运行状态/执行/runtime.json'
  const rt = await optionalJson(paths.execRuntime)
  if (!rt) return { nodes: [], authority: rel, sha: null, status: 'unavailable' }
  const sha = await fileSha256(paths.execRuntime).catch(() => null)
  const nodes = Object.keys(rt.tasks || {}).map((k) => {
    const t = rt.tasks[k] || {}
    const p = t.plan || {}
    const tickets = t.tickets || []
    return eventNode({
      id: 'e-' + k.split(':')[0], region: 'execution',
      kind: p.dispatchMode === 'real' ? '真实执行' : 'Mock 执行',
      titleZh: clip(p.goal || k, 48),
      summaryZh: `目标：${clip(p.goal, 120)}。派发 ${clip(p.dispatchMode, 16)}；授权 ${clip(p.approval && p.approval.status, 24) || '不可用'}；` +
        `tickets ${tickets.length}；最终 ${clip(t.finalStatus, 24) || '不可用'}；复核 ${clip(t.reviewVerdict, 24) || '不可用'}；` +
        `结果包 ${(t.resultPackageIds || []).length} 个。`,
      at: isoFromDate(p.createdAt), status: t.finalStatus || 'unknown',
      sourceRef: rel, sourceSha256: sha
    })
  })
  return { nodes, authority: rel, sha, status: 'safe-default' }
}

/* 证据：从冻结矩阵动态生成，哈希不写死 */
async function evidenceNodes(config) {
  const rel = '总说明/全脑V1冻结矩阵.json'
  const matrix = await optionalJson(config.freezeMatrixPath)
  if (!matrix) return { nodes: [], authority: rel, sha: null, status: 'unavailable' }
  const sha = await fileSha256(config.freezeMatrixPath).catch(() => null)
  const marker = matrix.totalMarker || {}
  const first = eventNode({ id: 'ev-marker', region: 'evidence', kind: '冻结标记',
    titleZh: clip(marker.id || '冻结标记', 40) + ' · ' + clip(marker.status || 'unknown', 12),
    summaryZh: `全脑 V1 冻结标记状态 ${clip(marker.status, 16)}；` +
      `矩阵内区域 ${(matrix.regions || []).length} 个、证据条目 ${(matrix.evidence || []).length} 条。本轮只读取，未修改。`,
    at: null, status: marker.status || 'unknown', sourceRef: rel, sourceSha256: sha })
  const second = eventNode({ id: 'ev-matrix', region: 'evidence', kind: '权威矩阵',
    titleZh: '全脑 V1 冻结矩阵',
    summaryZh: `五脑区 manifest、默认安全开关与证据索引的唯一权威来源；` +
      `wholeBrainVersion=${clip(matrix.wholeBrainVersion, 24) || '不可用'}。摘要不可用（权威未提供摘要字段）。`,
    at: null, status: 'frozen', sourceRef: rel, sourceSha256: sha, relationRefs: ['ev-marker'] })
  return { nodes: [first, second], authority: rel, sha, status: 'non-region' }
}

/**
 * 构建正式事件投影。每次调用重新读取权威文件，节点数量全部来自运行时。
 * @param {{brainRoot: string, freezeMatrixPath: string}} config
 */
export async function buildEventProjection(config) {
  const paths = eventPaths(config)
  const matrix = await optionalJson(config.freezeMatrixPath)
  const active = matrix?.bindings?.active || {}
  const safety = matrix?.defaultSafety || {}
  const builder = {
    personality: personalityNodes, memory: memoryNodes, mood: moodNodes,
    thinking: thinkingNodes, execution: executionNodes
  }
  const results = await Promise.all(REGION_ORDER.map((id) =>
    id === 'evidence' ? evidenceNodes(config) : builder[id](paths)))
  const regions = REGION_ORDER.map((id, i) => ({
    id, label: REGION_LABEL[id], color: REGION_COLOR[id],
    status: results[i].status, authority: results[i].authority, sha: results[i].sha,
    nodeCount: results[i].nodes.length, nodes: results[i].nodes
  }))
  const all = regions.flatMap((r) => r.nodes)
  return {
    schema: 'fish-brain-events-projection-v1',
    sourceClass: 'authority-backed',
    generatedAt: new Date().toISOString(),
    binding: {
      id: active.id || 'fish-main', profile: active.profile || 'fish-main',
      port: matrix?.environment?.port ?? 55299,
      launcher: matrix?.environment?.launcher || 'DSH-X',
      dshVersion: matrix?.environment?.dshVersion || '0.2.1-rc.2'
    },
    freeze: {
      marker: matrix?.totalMarker?.id || null,
      status: matrix?.totalMarker?.status || null,
      matrixSha256: await fileSha256(config.freezeMatrixPath).catch(() => null)
    },
    safety: {
      writeEnabled: safety.writeEnabled === true,
      writebackMode: safety.writebackMode || 'off',
      realWorker: safety.realWorker === true,
      parallel: safety.parallel === true,
      maximumWorkers: safety.maximumWorkers ?? 1,
      mayStartReadOnlyBrainFrontend: safety.mayStartReadOnlyBrainFrontend === true
    },
    interface: {
      readOnly: true, methods: ['GET', 'HEAD'], writeRoutes: [],
      summaryGeneration: false, memoryBodyReturned: false, promptReturned: false,
      credentialReturned: false, fullSessionIdReturned: false
    },
    counts: {
      regions: regions.length, nodes: all.length,
      withSummary: all.filter((n) => n.summaryZh !== null).length,
      withTime: all.filter((n) => n.at !== null).length,
      withRelations: all.filter((n) => n.relationRefs.length > 0).length
    },
    regions
  }
}

/** 幂等合并：按 id 覆盖；新节点只追加到所属脑区末尾，不整体重排 */
export function mergeEventNode(regions, incoming) {
  const region = regions.find((r) => r.id === incoming.region)
  if (!region) return { regions, changed: false }
  const next = eventNode(incoming)
  const index = region.nodes.findIndex((n) => n.id === next.id)
  let nodes
  if (index >= 0) {
    if (JSON.stringify(region.nodes[index]) === JSON.stringify(next)) return { regions, changed: false }
    nodes = region.nodes.slice()
    nodes[index] = next
  } else {
    nodes = region.nodes.concat([next])
  }
  return {
    regions: regions.map((r) => r.id === region.id ? { ...r, nodes, nodeCount: nodes.length } : r),
    changed: true
  }
}

export function eventProjectionDigest(projection) {
  const { generatedAt, ...stable } = projection
  return sha256(JSON.stringify(stable))
}

/** 与上一份快照对比，产出细粒度 added / updated 事件（供 SSE 推送） */
export function diffEventProjection(previous, current) {
  if (!previous) return []
  const before = new Map(previous.regions.flatMap((r) => r.nodes).map((n) => [n.id, n]))
  const events = []
  for (const region of current.regions) {
    for (const n of region.nodes) {
      const old = before.get(n.id)
      if (!old) events.push({ type: 'node.added', node: n })
      else if (JSON.stringify(old) !== JSON.stringify(n)) events.push({ type: 'node.updated', node: n })
    }
  }
  return events
}

export async function buildProjection(config) {
  const frozenMatrix = await optionalJson(config.freezeMatrixPath)
  const matrix = frozenMatrix || { regions: [], bindings: { active: {} }, environment: {}, totalMarker: { status: 'not-frozen' },
    memory: {}, defaultSafety: { writeEnabled: false, embeddingEnabled: false, autoCaptureEnabled: false } }
  const regions = await Promise.all(matrix.regions.map(async (frozen) => {
    const path = join(config.brainRoot, ...frozen.manifest.split('/'))
    const manifest = await jsonFile(path)
    const meta = REGION_META[frozen.region]
    return {
      id: meta.id,
      region: frozen.region,
      color: meta.color,
      status: publicStatus(frozen.status),
      statusLabel: frozen.status,
      manifestStatus: manifest.status,
      authority: frozen.manifest,
      keyHash: frozen.keyHash || await fileSha256(path),
      evidenceState: frozen.evidenceState,
      capabilities: (manifest.capabilities || []).map(({ id, status }) => ({ id, status })),
      doesNotOwn: manifest.doesNotOwn || [],
      nodes: publicNodes(manifest)
    }
  }))

  const moodRuntime = await optionalJson(join(config.brainRoot, '脑区运行状态', '心情', 'runtime.json'))
  const thinkingRuntime = await optionalJson(join(config.brainRoot, '脑区运行状态', '思考', 'runtime.json'))
  const executionRuntime = await optionalJson(join(config.brainRoot, '脑区运行状态', '执行', 'runtime.json'))
  const matrixSha256 = await fileSha256(config.freezeMatrixPath).catch(() => null)

  return {
    schema: 'fish-brain-readonly-projection-v2',
    generatedAt: new Date().toISOString(),
    sourceClass: frozenMatrix ? 'authority-backed' : 'runtime-unfrozen',
    binding: {
      id: matrix.bindings.active.id,
      profile: matrix.bindings.active.profile,
      port: matrix.environment.port,
      launcher: matrix.environment.launcher,
      dshVersion: matrix.environment.dshVersion
    },
    freeze: {
      marker: matrix.totalMarker.id,
      markerStatus: matrix.totalMarker.status,
      matrixSha256,
      wholeBrainVersion: matrix.wholeBrainVersion,
      workBlock7B: matrix.workBlock7B
    },
    safety: matrix.defaultSafety,
    memory: {
      documents: matrix.memory.documents,
      active: matrix.memory.active,
      semanticReadOnly: matrix.memory.semanticReadOnly,
      writeEnabled: matrix.defaultSafety.writeEnabled,
      writebackMode: 'off',
      embeddingEnabled: matrix.defaultSafety.embeddingEnabled,
      autoCaptureEnabled: matrix.defaultSafety.autoCaptureEnabled
    },
    personality: { includeSelf: true, includeSubagents: false, maxBytes: 10240 },
    runtime: {
      mood: moodRuntime ? { status: 'available', current: moodRuntime.state?.current || 'unknown', messages: moodRuntime.state?.messages ?? null } : { status: 'unavailable' },
      thinking: thinkingRuntime ? { status: 'available', lastLevel: thinkingRuntime.lastTask?.level || thinkingRuntime.state?.lastLevel || null } : { status: 'unavailable' },
      execution: executionRuntime ? { status: 'available', mode: executionRuntime.dispatchMode || executionRuntime.state?.dispatchMode || 'safe-default' } : { status: 'unavailable' }
    },
    regions,
    flows: [
      { from: 'personality', to: 'thinking', label: '人格边界' },
      { from: 'memory', to: 'thinking', label: '只读事实' },
      { from: 'mood', to: 'thinking', label: '表达修饰' },
      { from: 'thinking', to: 'execution', label: '版本化计划' },
      { from: 'execution', to: 'evidence', label: '证据引用' }
    ],
    evidenceNode: { label: '证据', status: 'active', statusLabel: '非脑区输出端' },
    evidenceSummary: { marker: matrix.totalMarker.id, markerStatus: matrix.totalMarker.status, matrixSha256 },
    interface: {
      readOnly: true,
      methods: ['GET', 'HEAD'],
      regions: ['人格', '记忆', '心情', '思考', '执行'],
      evidenceIsRegion: false,
      fishHands: 'planned-unavailable'
    }
  }
}

export async function buildHistory(config) {
  const moodPath = join(config.brainRoot, '脑区运行状态', '心情', 'render-audit.jsonl')
  const thinkingPath = join(config.brainRoot, '脑区运行状态', '思考', 'audit.jsonl')
  const [mood, thinking] = await Promise.all([jsonLines(moodPath), jsonLines(thinkingPath)])
  if (mood === null && thinking === null) {
    return { schema: 'fish-brain-authority-history-v1', status: 'unavailable', entries: [] }
  }
  const entries = []
  for (const item of mood || []) entries.push({
    at: new Date(item.at).toISOString(),
    region: 'mood',
    type: 'mood-render',
    eventRef: safeRef(item.eventId || JSON.stringify([item.at, item.primary, item.messageCount])),
    status: 'recorded',
    data: { primary: item.primary, secondary: item.secondary || [], expressionCharacters: item.expressionCharacters, riskDetected: item.riskDetected }
  })
  for (const item of thinking || []) entries.push({
    at: new Date(item.at).toISOString(),
    region: 'thinking',
    type: 'thinking-route',
    eventRef: safeRef(item.taskId || JSON.stringify([item.at, item.level, item.planVersion, item.planHash])),
    sessionRef: safeRef(item.sessionRef),
    status: 'recorded',
    data: { level: item.level, planVersion: item.planVersion, ambiguous: item.ambiguous, sideEffects: item.sideEffects || [], planRef: safeRef(item.planHash) }
  })
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return { schema: 'fish-brain-authority-history-v1', status: entries.length ? 'available' : 'unavailable', entries }
}

export async function buildEvidence(config) {
  const matrix = await optionalJson(config.freezeMatrixPath)
  if (!matrix) return { schema: 'fish-brain-evidence-summary-v1', status: 'unavailable',
    sourceClass: 'runtime-unfrozen', marker: null, matrix: null, manifests: [], items: [],
    privacy: { evidenceBodyReturned: false, promptReturned: false, memoryBodyReturned: false, fullSessionIdReturned: false } }
  const items = await Promise.all((matrix.evidence || []).map(async (entry) => {
    const path = join(config.brainRoot, ...entry.path.split('/'))
    let currentSha256 = null
    let hashStatus = 'unavailable'
    try {
      currentSha256 = await fileSha256(path)
      hashStatus = currentSha256 === entry.sha256 ? 'match' : 'changed'
    } catch {}
    return { id: entry.id, path: entry.path, frozenSha256: entry.sha256, currentSha256, hashStatus }
  }))
  const manifests = await Promise.all(matrix.regions.map(async (region) => ({
    region: region.region,
    path: region.manifest,
    sha256: await fileSha256(join(config.brainRoot, ...region.manifest.split('/'))),
    status: region.status
  })))
  return {
    schema: 'fish-brain-evidence-summary-v1',
    status: items.every((item) => item.hashStatus === 'match') ? 'available' : 'unknown',
    sourceClass: 'authority-backed',
    marker: { id: matrix.totalMarker.id, status: matrix.totalMarker.status, activeBinding: matrix.totalMarker.activeBinding },
    matrix: { path: '总说明/全脑V1冻结矩阵.json', sha256: await fileSha256(config.freezeMatrixPath) },
    manifests,
    items,
    safety: matrix.defaultSafety,
    privacy: { evidenceBodyReturned: false, promptReturned: false, memoryBodyReturned: false, fullSessionIdReturned: false }
  }
}

function register(ctx, path, fetch) {
  ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch }))
}

function jsonResponse(request, value) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  })
}

function stableProjectionDigest(projection) {
  const { generatedAt, ...stable } = projection
  return sha256(JSON.stringify(stable))
}

export function apply(ctx, config) {
  const live = new Map()
  ctx.effect(() => () => {
    for (const [controller, timer] of live) {
      clearInterval(timer)
      try { controller.close() } catch {}
    }
    live.clear()
  })

  for (const [path, [relative, contentType]] of ASSETS) {
    register(ctx, path, async (request) => new Response(request.method === 'HEAD' ? null : await readFile(join(assetsRoot, relative)), {
      headers: { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    }))
  }

  register(ctx, '/api/fish-brain/snapshot', async (request) => jsonResponse(request, await buildProjection(config)))
  register(ctx, '/api/fish-brain/history', async (request) => jsonResponse(request, await buildHistory(config)))
  register(ctx, '/api/fish-brain/evidence', async (request) => jsonResponse(request, await buildEvidence(config)))
  register(ctx, '/api/fish-brain/events-projection', async (request) => jsonResponse(request, await buildEventProjection(config)))
  register(ctx, '/api/fish-brain/events', (request) => {
    if (request.method === 'HEAD') return Promise.resolve(new Response(null, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } }))
    let controllerRef
    const stream = new ReadableStream({
      async start(controller) {
        controllerRef = controller
        let lastDigest = null
        let lastEventDigest = null
        let lastEventProjection = null
        const encode = (event, data) => controller.enqueue(
          new TextEncoder().encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'))
        const poll = async () => {
          try {
            /* 既有 snapshot 事件：字段语义不变，旧消费者继续可用 */
            const projection = await buildProjection(config)
            const digest = stableProjectionDigest(projection)
            if (digest !== lastDigest) {
              lastDigest = digest
              encode('snapshot', projection)
            }
            /* 新增：完整事件图快照 + 细粒度 added / updated，按 id 幂等 */
            const events = await buildEventProjection(config)
            const eventDigest = eventProjectionDigest(events)
            if (eventDigest !== lastEventDigest) {
              if (!lastEventProjection) {
                encode('event-graph.snapshot', events)
              } else {
                for (const change of diffEventProjection(lastEventProjection, events)) {
                  encode(change.type, { node: change.node })
                }
                encode('event-graph.snapshot', events)
              }
              lastEventDigest = eventDigest
              lastEventProjection = events
            }
          } catch (error) {
            encode('projection-error', { status: 'unknown', message: String(error?.message ?? error) })
          }
        }
        await poll()
        const timer = setInterval(poll, 15000)
        live.set(controller, timer)
      },
      cancel() {
        const timer = live.get(controllerRef)
        if (timer) clearInterval(timer)
        live.delete(controllerRef)
      }
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' } }))
  })
}

apply.inject = ['connection']
export default apply
