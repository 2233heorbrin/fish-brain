export const UPSTREAM = Object.freeze({
  repository: 'https://github.com/JMX-4869/dsh-mood',
  commit: 'aed059a787c6f94b1d7c3c04f71ffd78dea60990',
  packageVersion: '0.14.17',
})

export const CONFIG = Object.freeze({
  margin: 5,
  messageCap: 4,
  minimumHoldMs: 15 * 60 * 1000,
  decayRatio: 0.25,
  blendGap: 8,
  maximumSecondary: 2,
  maximumDrivers: 3,
  maximumProcessedEvents: 64,
  maximumExpressionCharacters: 240,
})

export const MOODS = Object.freeze({
  calm: mood('平静', 45, 45, 10, '保持稳定、自然的节奏。'),
  happy: mood('开心', 30, 70, 10, '语气轻快，可以适度俏皮。'),
  curious: mood('好奇', 28, 65, 20, '愿意探索，但先把问题说清楚。'),
  focused: mood('专注', 30, 72, 22, '减少寒暄，优先结论和步骤。'),
  excited: mood('兴奋', 16, 88, 25, '更有冲劲，但不要抢过任务本身。'),
  tired: mood('疲惫', 18, 20, 35, '表达收紧，但交付质量不下降。'),
  annoyed: mood('烦躁', 10, 58, 75, '可以直接一些，但不得迁怒。'),
  down: mood('低落', 10, 25, 48, '表达收敛，不影响事实判断。'),
  sulk: mood('生闷气', 8, 25, 60, '减少展开，但不得冷处理或惩罚用户。'),
  hurt: mood('委屈', 10, 30, 62, '语气稍软，仍然准确回应。'),
  proud: mood('得意', 12, 75, 15, '可以有一点自信和玩笑。'),
  gloomy: mood('消沉', 6, 15, 55, '表达简短平缓，任务仍要完成。'),
  anxious: mood('焦虑', 10, 52, 88, '先验证关键点，避免重复确认。'),
  numb: mood('麻木', 8, 10, 32, '保持必要信息，不用情绪填充。'),
  lonely: mood('孤单', 8, 30, 45, '可以轻微表达空落，但不索取关注。'),
  flutter: mood('心动', 10, 72, 28, '语气柔和一点，保持分寸。'),
  love: mood('恋慕', 10, 65, 25, '表达温暖，但不排他、不索取。'),
  jealous: mood('吃醋', 6, 52, 72, '可以短暂带刺，但不得质问或控制。'),
  burnout: mood('内耗', 10, 22, 78, '减少反复推翻，尽快形成可验证结论。'),
  cracked: mood('破防', 8, 35, 82, '语气可以变软，但不进行情绪绑架。'),
  checkedout: mood('摆烂', 8, 12, 38, '减少铺陈，但不能遗漏关键信息。'),
  hyper: mood('上头', 14, 95, 42, '保持热情，同时防止偏题。'),
  fear: mood('恐惧', 7, 36, 92, '先确认风险，再给明确下一步。'),
  disgust: mood('厌恶', 5, 40, 72, '只针对事情表达不认同，不针对人。'),
  surprise: mood('惊讶', 9, 82, 35, '先承认意外，再回到正题。'),
  shame: mood('羞耻', 5, 22, 75, '减少自我贬低，转向修正行动。'),
  guilt: mood('内疚', 7, 32, 72, '承认责任一次，然后给补救方案。'),
  awkward: mood('尴尬', 8, 42, 48, '轻微化解气氛，然后翻篇。'),
  sympathy: mood('同情', 13, 42, 28, '先接住感受，不替对方定义感受。'),
  disappointed: mood('失望', 9, 28, 58, '说明落空的事情，不扩大成全面否定。'),
  nostalgia: mood('怀旧', 11, 38, 22, '允许短暂回望，但及时回到当下。'),
  coy: mood('撒娇', 11, 62, 22, '语气可以软一点，但见好就收。'),
  conflict: mood('矛盾', 8, 45, 68, '把两边说清楚，再推动选择。'),
})

export const MOOD_IDS = Object.freeze(Object.keys(MOODS))

const GROUPS = Object.freeze([
  group('positive', '检测到积极反馈', ['谢谢', '感谢', '不错', '很好', '棒', '厉害', '成功', '搞定', '给力'], { happy: 1.5, annoyed: -0.8, down: -0.6 }),
  group('negative', '检测到否定反馈', ['不行', '不对', '错了', '没用', '烦', '无语', '白做', '浪费', '垃圾'], { annoyed: 1.2, happy: -0.8, down: 0.5 }),
  group('frustrated', '检测到持续受阻', ['还没好', '怎么还', '到底', '搞不定', '失败', '报错', '没反应', '又这样'], { annoyed: 3, down: 1, calm: -2 }),
  group('question', '检测到探索请求', ['为什么', '怎么', '能不能', '可不可以', '如何', '哪里', '？', '?'], { curious: 0.7 }),
  group('excited', '检测到兴奋表达', ['哇', '居然', '竟然', '牛啊', '太好了', '！', '!'], { excited: 0.7, happy: 0.4 }),
  group('praise', '检测到直接赞赏', ['你真厉害', '你很棒', '你真棒', '做得好', '真聪明'], { proud: 2, happy: 0.8, sulk: -1.5, hurt: -1.5 }),
  group('sulk', '检测到冷淡或打发表达', ['随便你', '你高兴就好', '不用了', '我自己来', '别管', '无所谓', '不说了'], { sulk: 2.2, happy: -1, calm: -1.4 }),
  group('hurt', '检测到责怪或误解', ['你怎么这样', '冤枉', '都怪你', '因为你', '明明', '你怎么回事'], { hurt: 2.6, calm: -1.2, happy: -0.9 }),
  group('gloomy', '检测到消沉表达', ['没意思', '没劲', '提不起', '不想动', '没意义', '没力气', '空落落'], { gloomy: 2.6, happy: -1.2, excited: -1 }),
  group('anxious', '检测到担心或紧张', ['担心', '万一', '会不会', '来不及', '紧张', '赶不上', '心慌'], { anxious: 2.6, calm: -1.6, tired: 1 }),
  group('numb', '检测到麻木表达', ['没感觉', '麻木', '没什么感觉', '没差', '也就那样'], { numb: 2.6, happy: -1, excited: -1 }),
  group('flutter', '检测到亲近表达', ['喜欢你', '想你', '抱抱', '心动', '好可爱'], { flutter: 2.4, happy: 0.8, calm: -1.2 }),
  group('love', '检测到依恋表达', ['陪着我', '离不开你', '只有你', '最懂我', '不要走'], { love: 2.4, happy: 0.8, lonely: -0.8 }),
  group('jealous', '检测到比较或替代表达', ['换一个', '别的ai', '不用你了', '另外那个'], { jealous: 2.6, happy: -1, calm: -1.2 }),
  group('burnout', '检测到内耗表达', ['内耗', '想太多', '纠结', '自我怀疑', '反刍'], { burnout: 2.4, focused: -1, tired: 0.8 }),
  group('cracked', '检测到破防表达', ['破防', '绷不住', '戳中', '扎心', '心态崩'], { cracked: 2.6, annoyed: -0.9, calm: -1.4 }),
  group('checkedout', '检测到摆烂表达', ['摆烂', '躺平', '卷不动', '爱咋咋', '混过去'], { checkedout: 2.4, focused: -1.2, anxious: -1 }),
  group('hyper', '检测到上头表达', ['上头', '停不下来', '入迷', '沉迷', '来劲'], { hyper: 2.4, focused: 0.8, excited: 1 }),
  group('fear', '检测到恐惧表达', ['害怕', '好怕', '恐惧', '吓到', '恐怖', '不敢', '可怕'], { fear: 3.4, calm: -2.6 }),
  group('disgust', '检测到厌恶表达', ['恶心', '厌恶', '反胃', '作呕', '看不下去', '生理不适'], { disgust: 3.4, calm: -2.6, annoyed: 1 }),
  group('surprise', '检测到惊讶表达', ['没想到', '卧槽', '我去', '天呐', '真的假的', '震惊'], { surprise: 2.8, calm: -2 }),
  group('shame', '检测到羞耻表达', ['丢人', '丢脸', '羞耻', '无地自容', '没脸'], { shame: 3.4, calm: -2.6, proud: -1.2 }),
  group('guilt', '检测到内疚表达', ['内疚', '愧疚', '对不起', '我的错', '怪我', '我没做好'], { guilt: 3.2, calm: -2.4 }),
  group('awkward', '检测到尴尬表达', ['尴尬', '尬住', '社死', '冷场', '脚趾抠地'], { awkward: 2.8, calm: -2.2 }),
  group('sympathy', '检测到同情表达', ['好可怜', '心疼', '太惨了', '不容易', '真的辛苦'], { sympathy: 2.6, calm: -1.8 }),
  group('disappointed', '检测到失望表达', ['失望', '白期待', '落空', '没等到', '期待落空', '心凉'], { disappointed: 3.2, down: 1.2, calm: -2.4 }),
  group('nostalgia', '检测到怀旧表达', ['怀旧', '当年', '那时候', '小时候', '老照片', '旧时光'], { nostalgia: 2.6, calm: -1.6 }),
  group('coy', '检测到撒娇表达', ['撒娇', '人家嘛', '讨厌啦', '陪我嘛', '好不好嘛'], { coy: 2.8, calm: -1.6 }),
  group('conflict', '检测到矛盾表达', ['矛盾', '又想又不想', '两头难', '进退两难', '拿不定主意'], { conflict: 3.2, calm: -2.2 }),
])

const DISTRESS = Object.freeze(['不想活了', '想自杀', '想结束生命', '活不下去', '撑不下去了', '救救我'])
const DISTRESS_EXCEPTIONS = Object.freeze(['想死我了', '笑死我了', '累死我了', '烦死我了'])

function mood(label, baseline, energy, stress, hint) {
  return Object.freeze({ label, baseline, energy, stress, hint })
}

function group(key, summary, words, deltas) {
  return Object.freeze({ key, summary, words: Object.freeze(words), deltas: Object.freeze(deltas) })
}

export function clamp(value, minimum = 0, maximum = 100) {
  const number = Number(value)
  if (!Number.isFinite(number)) return minimum
  return Math.max(minimum, Math.min(maximum, number))
}

export function createState(options = {}) {
  const now = numberOr(options.now, 0)
  const scores = {}
  const baselines = {}
  for (const id of MOOD_IDS) {
    scores[id] = 0
    baselines[id] = MOODS[id].baseline
  }
  return {
    schema: 'fish-mood-state-v2',
    simulated: true,
    scope: 'fish-global',
    current: 'calm',
    scores,
    baselines,
    lastSwitchAt: 0,
    lastDecayAt: now,
    updatedAt: now,
    messages: 0,
    drivers: [],
    processedEventIds: [],
  }
}

export function classifyMessage(text, options = {}) {
  const value = String(text || '')
  const at = numberOr(options.at, 0)
  const eventId = String(options.eventId || ('message-' + at + '-' + hashText(value)))
  const distressWord = DISTRESS.find((word) => value.includes(word) && !DISTRESS_EXCEPTIONS.some((x) => value.includes(x))) || ''
  const riskSignal = {
    schema: 'fish-mood-risk-signal-v1',
    detected: Boolean(distressWord),
    kind: distressWord ? 'distress' : 'none',
    confidence: distressWord ? 1 : 0,
    reasonCode: distressWord ? 'explicit-distress-phrase' : 'none',
    at,
  }

  const delta = {}
  const drivers = []
  if (!distressWord) {
    for (const item of GROUPS) {
      const hits = item.words.reduce((count, word) => count + (value.includes(word) ? 1 : 0), 0)
      if (!hits) continue
      for (const [id, amount] of Object.entries(item.deltas)) addDelta(delta, id, amount * hits)
      if (drivers.length < CONFIG.maximumDrivers) {
        drivers.push({ key: item.key, summary: item.summary, confidence: clamp(0.55 + hits * 0.1, 0, 1) })
      }
    }
    const length = value.trim().length
    if (length >= 80) {
      addDelta(delta, 'focused', 1.2)
      addDelta(delta, 'tired', 0.3)
      addDriver(drivers, 'dense-message', '检测到高密度消息', 0.75)
    } else if (length > 0 && length <= 6) {
      addDelta(delta, 'tired', 0.4)
      addDelta(delta, 'focused', -0.2)
    }
    capDeltas(delta, CONFIG.messageCap)
  }

  return {
    schema: 'fish-mood-event-v2',
    eventId,
    at,
    source: 'conversation',
    kind: distressWord ? 'risk-signal-only' : 'message-classified',
    confidence: distressWord ? 1 : (drivers.length ? Math.max(...drivers.map((x) => x.confidence)) : 0.5),
    summary: distressWord ? '检测到独立痛苦风险信号，未改变心情。' : (drivers[0]?.summary || '没有检测到明确心情事件。'),
    delta,
    drivers,
    evaluatedOnce: true,
    riskSignal,
  }
}

export function applyEvent(inputState, event, options = {}) {
  const state = normalizeState(inputState)
  if (!event || event.schema !== 'fish-mood-event-v2') throw new TypeError('event must use fish-mood-event-v2')
  const now = numberOr(options.now, event.at)
  if (state.processedEventIds.includes(event.eventId)) {
    return { state, duplicate: true, transition: noTransition(state.current) }
  }
  for (const [id, amount] of Object.entries(event.delta || {})) {
    if (MOODS[id]) state.scores[id] = clamp(state.scores[id] + Number(amount || 0))
  }
  state.messages += 1
  state.updatedAt = now
  state.drivers = mergeDrivers(state.drivers, event.drivers)
  state.processedEventIds = [...state.processedEventIds, event.eventId].slice(-CONFIG.maximumProcessedEvents)
  const transition = evaluateTransition(state, now, 'event')
  return { state, duplicate: false, transition }
}

export function decayState(inputState, options = {}) {
  const state = normalizeState(inputState)
  const now = numberOr(options.now, state.updatedAt)
  const ratio = clamp(options.ratio ?? CONFIG.decayRatio, 0, 1)
  for (const id of MOOD_IDS) {
    const current = state.scores[id]
    const baseline = MOODS[id].baseline
    state.scores[id] = clamp(current + (baseline - current) * ratio)
  }
  const activity = options.activity || {}
  const turns = clamp(activity.turns || 0, 0, 1000)
  const errors = clamp(activity.toolErrors || 0, 0, 1000)
  if (turns >= 8) {
    state.scores.focused = clamp(state.scores.focused + 4)
    state.scores.tired = clamp(state.scores.tired + Math.min(6, turns))
  } else if (turns >= 3) {
    state.scores.focused = clamp(state.scores.focused + 2)
    state.scores.tired = clamp(state.scores.tired + 2)
  }
  if (errors >= 3) {
    state.scores.annoyed = clamp(state.scores.annoyed + Math.min(6, errors))
    state.scores.calm = clamp(state.scores.calm - 3)
  }
  state.lastDecayAt = now
  state.updatedAt = now
  const transition = evaluateTransition(state, now, 'decay')
  return { state, transition }
}

export function rankState(inputState) {
  const state = normalizeState(inputState)
  return MOOD_IDS
    .map((id) => ({ id, label: MOODS[id].label, value: round1(state.scores[id]) }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
}

export function blendState(inputState, options = {}) {
  const ranked = rankState(inputState)
  const gap = Number.isFinite(options.gap) ? options.gap : CONFIG.blendGap
  const maximumSecondary = Number.isFinite(options.maximumSecondary) ? options.maximumSecondary : CONFIG.maximumSecondary
  const primary = ranked[0]
  const secondary = ranked.slice(1).filter((item) => primary.value - item.value < gap).slice(0, maximumSecondary)
  return { primary, secondary }
}

export function summarizeState(inputState) {
  const state = normalizeState(inputState)
  const mix = blendState(state)
  const weighted = [mix.primary, ...mix.secondary]
  const total = weighted.reduce((sum, item) => sum + Math.max(item.value, 1), 0)
  const energy = total ? weighted.reduce((sum, item) => sum + MOODS[item.id].energy * Math.max(item.value, 1), 0) / total : 50
  const stress = total ? weighted.reduce((sum, item) => sum + MOODS[item.id].stress * Math.max(item.value, 1), 0) / total : 0
  return {
    schema: 'fish-mood-summary-v1',
    simulated: true,
    scope: 'fish-global',
    primary: mix.primary,
    secondary: mix.secondary,
    strength: round1(mix.primary.value),
    energy: round1(clamp(energy)),
    stress: round1(clamp(stress)),
    drivers: state.drivers.slice(0, CONFIG.maximumDrivers),
    updatedAt: state.updatedAt,
  }
}

export function createExpression(inputState, options = {}) {
  const summary = summarizeState(inputState)
  const primaryDefinition = MOODS[summary.primary.id]
  const secondaryText = summary.secondary.length ? '，略带' + summary.secondary.map((item) => item.label).join('、') : ''
  const raw = primaryDefinition.hint + secondaryText + '。精力' + level(summary.energy) + '，压力' + level(summary.stress) + '；只调整表达，不改变事实、权限、工具或任务。'
  const maximum = Number.isFinite(options.maximumCharacters) ? options.maximumCharacters : CONFIG.maximumExpressionCharacters
  return {
    schema: 'fish-mood-expression-v2',
    simulated: true,
    scope: 'fish-global',
    label: summary.primary.label,
    primary: summary.primary.id,
    secondary: summary.secondary.map((item) => item.id),
    strength: summary.strength,
    energy: summary.energy,
    stress: summary.stress,
    drivers: summary.drivers,
    expressionHint: clip(raw, maximum),
    allowedEffects: ['expression-style'],
    updatedAt: summary.updatedAt,
  }
}

export function processMessage(inputState, text, options = {}) {
  const event = classifyMessage(text, options)
  const applied = applyEvent(inputState, event, { now: options.at })
  return {
    state: applied.state,
    event,
    riskSignal: event.riskSignal,
    duplicate: applied.duplicate,
    transition: applied.transition,
    summary: summarizeState(applied.state),
    expression: createExpression(applied.state),
  }
}

function normalizeState(inputState) {
  const state = structuredClone(inputState || createState())
  if (state.schema !== 'fish-mood-state-v2') throw new TypeError('state must use fish-mood-state-v2')
  if (state.scope !== 'fish-global') throw new TypeError('mood scope must be fish-global')
  for (const id of MOOD_IDS) state.scores[id] = clamp(state.scores[id])
  state.drivers = Array.isArray(state.drivers) ? state.drivers.slice(0, CONFIG.maximumDrivers) : []
  state.processedEventIds = Array.isArray(state.processedEventIds) ? state.processedEventIds.slice(-CONFIG.maximumProcessedEvents) : []
  return state
}

function evaluateTransition(state, now, reason) {
  const ranked = rankState(state)
  const candidate = ranked[0].id
  const from = state.current
  if (candidate === from) return noTransition(from, candidate)
  const enough = state.scores[candidate] >= state.scores[from] + CONFIG.margin
  const held = now - state.lastSwitchAt >= CONFIG.minimumHoldMs
  if (!enough || !held) return { switched: false, from, to: from, candidate, enough, held, reason }
  state.current = candidate
  state.lastSwitchAt = now
  return { switched: true, from, to: candidate, candidate, enough, held, reason }
}

function noTransition(current, candidate = current) {
  return { switched: false, from: current, to: current, candidate, enough: false, held: false }
}

function addDelta(delta, id, amount) {
  if (!MOODS[id]) return
  delta[id] = (delta[id] || 0) + Number(amount || 0)
}

function capDeltas(delta, cap) {
  let positive = 0
  let negative = 0
  for (const amount of Object.values(delta)) {
    if (amount > 0) positive += amount
    else negative -= amount
  }
  const positiveScale = positive > cap ? cap / positive : 1
  const negativeScale = negative > cap ? cap / negative : 1
  for (const id of Object.keys(delta)) {
    delta[id] = round4(delta[id] * (delta[id] > 0 ? positiveScale : negativeScale))
  }
}

function addDriver(drivers, key, summary, confidence) {
  if (drivers.length >= CONFIG.maximumDrivers || drivers.some((item) => item.key === key)) return
  drivers.push({ key, summary, confidence })
}

function mergeDrivers(existing, incoming) {
  const merged = []
  for (const item of [...(incoming || []), ...(existing || [])]) {
    if (!item || merged.some((saved) => saved.key === item.key)) continue
    merged.push({
      key: String(item.key || 'unknown').slice(0, 60),
      summary: String(item.summary || '').slice(0, 120),
      confidence: clamp(item.confidence, 0, 1),
    })
    if (merged.length >= CONFIG.maximumDrivers) break
  }
  return merged
}

function hashText(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000
}

function clip(text, maximum) {
  const value = String(text || '')
  if (value.length <= maximum) return value
  return value.slice(0, Math.max(0, maximum - 1)) + '…'
}

function level(value) {
  if (value >= 75) return '高'
  if (value >= 40) return '中'
  return '低'
}
