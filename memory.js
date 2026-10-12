// 长期记忆:数据长什么样、让 AI 整理时说什么、AI 的结果怎么写回去
// 这里不调 AI,也不碰界面。什么时候整理、怎么调 AI,在 brain.js 里
//
// 三层:
//   原文    聊天原文全部留在本机(store.js 的 messages),一字不改
//   碎片    一段聊天停下后压成的梗概,带关键词
//   卡片    七张固定维度的卡片,每天根据前一天的小传增量更新
// 另外还有:关系时间线(只追加)、时效状态(到期自动失效)、每天的小传、你亲口让他记的事
import * as store from './store.js';

// 七张卡片的维度和含义,整理记忆时会原样告诉 AI
export const CARDS = {
  偏好: 'ta 喜欢和讨厌的东西,雷点',
  相处模式: '你们平时怎么聊,ta 吃哪一套、不吃哪一套',
  近况: 'ta 最近在忙什么、状态如何、日程作息',
  目标: 'ta 想做成的事、在努力的方向',
  关系: '你们现在到哪一步、互相怎么称呼;还有 ta 身边重要的人',
  关键事件: '发生过的、以后还会提起的事',
  相处规则: '你们约定过的事、答应过 ta 的事',
};

const CARD_MAX = 20; // 每张卡片最多几条
const STATES_MAX = 20;
const TIMELINE_IN_PROMPT = 10; // 带给 AI 看的最近几条大事记
const DIARY_IN_PROMPT = 7; // 带给 AI 看的最近几天小传

export const emptyMemory = () => ({
  cards: Object.fromEntries(Object.keys(CARDS).map((name) => [name, []])),
  pinned: [], // 你亲口让他记住的,AI 整理时不许动
  timeline: [], // 关系时间线:{ d, text }
  states: [], // 时效状态:{ id, text, until }
  fragments: [], // 还没写进小传的碎片:{ d, text, keywords, keep, fromId, toId }
  diary: [], // 每天的小传:{ d, text }
  nextId: 1,
  upToId: 0, // 已经压成碎片的最后一条消息的编号,之后的消息算"待整理"
  nightlyDay: '', // 最近一次"写小传、更新卡片"是哪天做的
  lastMicro: 0,
  fails: 0,
  lastError: '',
  pausedUntil: 0,
});

export async function loadMemory() {
  const saved = (await store.get('memory')) || {};
  const blank = emptyMemory();
  return { ...blank, ...saved, cards: { ...blank.cards, ...saved.cards } };
}

export const saveMemory = (memory) => store.set('memory', memory);

// 写完小传的碎片搬到这里长期存着,以后按关键词找旧事用
export const loadArchive = async () => (await store.get('archive')) || [];

// 时间都按这台设备的本地时间算

// 2026-10-12
export const dayKey = (t) => new Date(t).toLocaleDateString('sv-SE');

// 10/12周一 21:30
export const stamp = (t) =>
  new Date(t).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

// 聊天记录里真正说的话。"语音通话 3:20"这种记号不算
export const spoken = (messages) => messages.filter((m) => m.role === 'user' || m.role === 'assistant');

const weekday = (t) => new Date(t).toLocaleDateString('zh-CN', { weekday: 'short' });

// 未来两周的日期和星期。AI 自己算"下周三是几号"容易算错,直接给它
function calendar(now) {
  const days = new Set();
  for (let i = 0; i < 14; i++) days.add(`${dayKey(now + i * 86400000)}${weekday(now + i * 86400000)}`);
  return [...days].join('、');
}

export function pin(memory, text) {
  memory.pinned.push({ id: memory.nextId++, text });
}

// 按编号删一条,卡片、亲口交代的、时效状态里都找
export function forget(memory, id) {
  for (const name of Object.keys(memory.cards)) {
    memory.cards[name] = memory.cards[name].filter((x) => x.id !== id);
  }
  memory.pinned = memory.pinned.filter((x) => x.id !== id);
  memory.states = memory.states.filter((x) => x.id !== id);
}

export const activeStates = (memory, now) => memory.states.filter((s) => s.until >= dayKey(now));

// 把记忆拼成给 AI 看的文字。顺序是"变得慢的在前、变得快的在后",这样 AI 接口的前缀缓存能多命中一些
export function renderMemory(memory, now) {
  const list = (items) => items.map((x) => `- ${x.text}`).join('\n');
  const parts = [];

  for (const name of Object.keys(CARDS)) {
    if (memory.cards[name].length) parts.push(`${name}:\n${list(memory.cards[name])}`);
  }
  if (memory.pinned.length) parts.push(`ta 亲口让你记住的:\n${list(memory.pinned)}`);

  const events = memory.timeline.slice(-TIMELINE_IN_PROMPT);
  if (events.length) parts.push(`你们的大事记:\n${events.map((e) => `- ${e.d}:${e.text}`).join('\n')}`);

  const days = memory.diary.slice(-DIARY_IN_PROMPT);
  if (days.length) parts.push(`最近几天:\n${days.map((d) => `- ${d.d}:${d.text}`).join('\n')}`);

  if (memory.fragments.length) {
    parts.push(`刚聊过、还没写进日记的:\n${memory.fragments.map((f) => `- ${f.d}:${f.text}`).join('\n')}`);
  }

  const active = activeStates(memory, now);
  if (active.length) {
    parts.push(`眼下的情况(优先留意):\n${active.map((s) => `- ${s.text}(到 ${s.until})`).join('\n')}`);
  }
  return parts.join('\n\n');
}

const SYSTEM = (name) => `你在帮聊天角色"${name}"整理他的记忆。只输出一个 JSON 对象,不要别的文字。`;

const transcriptOf = (messages, name) =>
  messages.map((m) => `[${stamp(m.t)}] ${m.role === 'user' ? 'ta' : name}:${m.content}`).join('\n');

// 小整理:一段聊天停下后,压成一条碎片,顺便记下带截止日的短期情况
export function microPrompt(name, memory, pending, now) {
  const active = activeStates(memory, now);
  const user = `【正在生效的短期情况(带编号)】
${active.map((s) => `${s.id}. ${s.text}(到 ${s.until})`).join('\n') || '(无)'}

【日历】今天是 ${dayKey(now)}${weekday(now)}。未来两周:${calendar(now)}

【新的聊天】
${transcriptOf(pending, name)}

【要求】输出 JSON,字段如下:
- "summary":把这段聊天压成一段梗概,150 字以内。保留具体的人、具体的事、ta 当时的反应和情绪,不要写成空泛的总结。
- "keywords":这段聊天里的人名、地名、店名、东西的名字等专有名词,以后靠它们找回这段聊天。数组,最多 8 个。没有就给空数组。
- "keep":这段聊天以后值不值得再翻出来。只是打招呼、闲聊几句就给 false,有具体的事、心情或约定就给 true。
- "states_add":聊天里明确提到的、有明确结束时间的短期情况,比如"这周感冒""周三下午有考试""今晚要赶作业"。每项是 {"text": "……", "until": "YYYY-MM-DD"},until 是它结束的那一天,对照日历填。没明确提到就给空数组,不许猜。
- "states_remove":已经结束、或 ta 说已经解决了的短期情况的编号。没有就给空数组。`;
  return [
    { role: 'system', content: SYSTEM(name) },
    { role: 'user', content: user },
  ];
}

// 大整理:把前一天的碎片写成小传,再对照七张卡片做增量更新
export function nightlyPrompt(name, persona, memory, due, expired) {
  const byDay = {};
  for (const f of due) (byDay[f.d] ||= []).push(f.text);

  const user = `【角色设定(仅供参考)】
${persona}

【现有记忆卡片(带编号)】
${Object.entries(CARDS)
  .map(([card, meaning]) => {
    const items = memory.cards[card].map((x) => `  ${x.id}. ${x.text}`).join('\n') || '  (空)';
    return `${card}(${meaning}):\n${items}`;
  })
  .join('\n')}

【关系时间线】
${memory.timeline.map((e) => `- ${e.d}:${e.text}`).join('\n') || '(无)'}

【刚到期的短期情况】
${expired.map((s) => `- ${s.text}(到 ${s.until} 为止)`).join('\n') || '(无)'}

【要归档的聊天碎片】
${Object.entries(byDay)
  .map(([d, texts]) => `${d}:\n${texts.map((t) => `- ${t}`).join('\n')}`)
  .join('\n')}

【要求】输出 JSON,字段如下:
- "diary":对象,键是日期(格式 2026-10-12),值是那天的小传,150 字以内:聊了什么、发生了什么、气氛如何。刚到期的短期情况改写成过去时写进去(比如"这周感冒"写成"十月中旬感冒了一周,已经好了")。
- "cards":对象,键是七个维度名,值是 {"add": ["……"], "remove": [编号]}。对照现有卡片,只提取新的、变了的、或者和旧认知冲突的内容,已经记过的不许重复。有冲突时,把旧条目的编号放进 remove,新说法放进 add。每条一句话,要具体。某一维超过 12 条时,合并相近的、移除过时的。没有变化的维度不用写。
  其中"关系"这一维只根据聊天里真实发生的事来写,不要替他们推进。
- "timeline":值得写进关系时间线的大事,比如第一次换了称呼、一次深夜长谈、一次争执和解。每条 30 字以内。普通的一天给空数组,宁缺毋滥。`;
  return [
    { role: 'system', content: SYSTEM(name) },
    { role: 'user', content: user },
  ];
}

export function parseJSON(raw) {
  try {
    return JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  } catch {
    throw new Error(`AI 没按格式输出:${raw.slice(0, 80)}`);
  }
}

// AI 的输出不一定规矩,所以下面每一项都先检查类型再用

const strings = (v) =>
  Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];

const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function applyMicro(memory, update, pending) {
  if (typeof update.summary !== 'string' || !update.summary.trim()) {
    throw new Error('AI 没给出聊天梗概');
  }
  const last = pending[pending.length - 1];
  memory.fragments.push({
    d: dayKey(pending[0].t), // 算在这段聊天开始的那天,跨过零点的夜聊整段归前一天
    text: update.summary.trim(),
    keywords: strings(update.keywords).slice(0, 8),
    keep: update.keep !== false,
    fromId: pending[0].id,
    toId: last.id,
  });

  const gone = ids(update.states_remove);
  memory.states = memory.states.filter((s) => !gone.includes(s.id));
  if (Array.isArray(update.states_add)) {
    for (const s of update.states_add) {
      if (!s || typeof s.text !== 'string' || !s.text.trim() || !isDay(s.until)) continue;
      if (s.until < dayKey(last.t)) continue;
      memory.states.push({ id: memory.nextId++, text: s.text.trim(), until: s.until });
    }
  }
  memory.states = memory.states.slice(-STATES_MAX);
  memory.upToId = last.id;
}

// update 为 null 表示前一天没有聊天,只需要让到期的状态下线。返回被归档的碎片
export function applyNightly(memory, update, today) {
  const due = memory.fragments.filter((f) => f.d < today);

  if (update) {
    if (update.diary && typeof update.diary === 'object') {
      for (const [d, text] of Object.entries(update.diary)) {
        if (!isDay(d) || typeof text !== 'string' || !text.trim()) continue;
        memory.diary = memory.diary.filter((entry) => entry.d !== d);
        memory.diary.push({ d, text: text.trim() });
      }
      memory.diary.sort((a, b) => a.d.localeCompare(b.d));
    }

    for (const name of Object.keys(CARDS)) {
      const change = update.cards && update.cards[name];
      if (!change || typeof change !== 'object') continue;
      const gone = ids(change.remove);
      memory.cards[name] = memory.cards[name].filter((x) => !gone.includes(x.id));
      for (const text of strings(change.add)) memory.cards[name].push({ id: memory.nextId++, text });
      memory.cards[name] = memory.cards[name].slice(-CARD_MAX);
    }

    // 大事记记在被归档的最后一天名下
    const day = due.length ? due[due.length - 1].d : today;
    for (const text of strings(update.timeline)) memory.timeline.push({ d: day, text });
  }

  // 用"早于今天"而不是"等于昨天":哪怕好几天没打开,每条碎片也都有归属
  memory.fragments = memory.fragments.filter((f) => f.d >= today);
  memory.states = memory.states.filter((s) => s.until >= today);
  memory.nightlyDay = today;
  return due;
}
