// 大脑:拼提示词、调 AI、把回复拆成一条条气泡、定期整理记忆。不碰界面,以后换别的入口也能直接用
import * as store from './store.js';
import {
  loadMemory,
  saveMemory,
  loadArchive,
  dayKey,
  stamp,
  spoken,
  renderMemory,
  microPrompt,
  nightlyPrompt,
  parseJSON,
  applyMicro,
  applyNightly,
} from './memory.js';

// 设置页"选一家"里的选项。任何 OpenAI 兼容接口都能接,加一行就多一家
// models 是填 Key 之前先给的默认模型名;填了 Key 点"测试连接",会向那家要一份最新的模型列表
export const PRESETS = [
  { label: 'DeepSeek', apiBaseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  { label: '通义千问', apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  { label: '硅基流动', apiBaseUrl: 'https://api.siliconflow.cn/v1', models: [] },
  { label: '豆包', apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: [] },
  { label: '混元', apiBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: [] },
  { label: 'Grok', apiBaseUrl: 'https://api.x.ai/v1', models: [] },
];

// 一条"线路"= 一家 AI + 一个 Key + 一个模型。可以接好几条,再用 routes 决定什么时候用哪条
export const newLine = (preset = PRESETS[0]) => ({
  id: Math.random().toString(36).slice(2, 8),
  label: preset.label,
  apiBaseUrl: preset.apiBaseUrl,
  apiKey: '',
  model: preset.models[0] || '',
});

const DEFAULT_SETTINGS = {
  lines: [],
  // 每个场合用哪条线路(填线路的 id)。night、memory、call 留空就跟日常聊天用同一条
  routes: { chat: '', night: '', memory: '', call: '' },
  nightFrom: '23:00',
  nightTo: '05:00',
  nightPrompt: '', // 深夜时段额外加给他的设定,你自己在设置里填。打字和打电话都会用上
  safeword: '红灯', // 你说出这个词,他立刻停下,接下来一段时间不再用深夜设定
  temperature: 1.1,
  // 语音。听写你说的话(asr)固定用硅基流动;他的声音(tts)由 provider 决定用哪家
  voice: {
    provider: 'minimax', // 'grok'、'minimax'、'elevenlabs' 或 'siliconflow'
    // Grok:真正的实时通话,能随时打断。apiKey 留空就借用 Grok 线路的 Key
    grok: { apiKey: '', voice: 'eve' },
    // MiniMax:国内能用,声音自然
    minimax: { apiKey: '', voiceId: '', model: 'speech-2.8-hd' },
    // 硅基流动:apiKey 留空就借用线路里硅基流动那条的 Key
    apiBaseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    ttsModel: 'FunAudioLLM/CosyVoice2-0.5B',
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    voice: 'charles',
    speed: 1,
    // ElevenLabs:英文最自然,但是国外服务,国内不翻墙连不上
    eleven: { apiKey: '', voiceId: '', model: 'eleven_flash_v2_5' },
  },
};

const CONTEXT_MESSAGES = 60; // 每次带给 AI 的最近消息条数(一条气泡算一条)

// 记忆整理的节奏
const EVERY = 30; // 每攒够这么多条聊天记录(一个气泡算一条),压成一段碎片
const BATCH_MAX = 80; // 手动点"现在整理"时,一次最多压多少条,太多就分几次
const NIGHTLY_HOUR = 4; // 每天几点之后,第一次打开时写前一天的小传、更新卡片
const PAUSE_MS = 6 * 60 * 60 * 1000; // 连续失败三次后歇这么久再试,免得白烧钱

// 他突然说"我是 AI"或莫名拒答时,不让这种回复出现在聊天里
const OUT_OF_CHARACTER =
  /(作为|我是|身为)一?[个名位]?\s*(AI|人工智能|语言模型|智能助手|虚拟助手)|(无法|不能)(继续|提供|协助|参与)(这|此|该)|\bas an AI\b|\bI(?:'m| am) an AI\b|language model/i;
const FALLBACK = '刚才信号不好,没发出去。你再说一遍?';
const CALL_FALLBACK = [{ en: 'Sorry, the line cut out for a second. Say that again?', zh: '抱歉,刚才信号断了一下。你再说一遍?' }];

// 打电话时换用这套规则(平时打字用的是 chat-rules.txt)
const CALL_RULES = `## 现在是语音通话
- 你们在打电话,你说的话会被念出来。全程用英语说。
- 英语要地道:像母语是英语的人平时打电话那样说,多用缩写和口语(yeah, gonna, kinda),句子短。不要书面语,不要把中文的说法直译过来。
- 一次说一到三句,每句不要太长。
- 不要用括号、星号、表情符号,不要写动作和心理。
- ta 说中文或英文都可以,你始终用英语回答。
- ta 的话开头方括号里是时间,是系统加的,你不要带时间。ta 的话是语音转出来的文字,可能有错字,按意思理解。
- 输出格式:每句话占两行,第一行是英文,第二行是这句的中文翻译。除此之外不要输出任何内容。`;

// 有的声音能念出笑声、叹气这类语气声。能的话就告诉他可以用,听起来更像真人
const SOUND_RULE = `- 英文那一行里可以偶尔加一个语气声标签,让你听起来更像真人。只能用这几个:(laughs) (chuckle) (sighs) (breath) (emm) (humming)。合适才用,大多数句子不用,一句最多一个。中文那行不要加。`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadSettings() {
  const { apiBaseUrl, apiKey, model, ...saved } = (await store.get('settings')) || {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    routes: { ...DEFAULT_SETTINGS.routes, ...saved.routes },
    voice: {
      ...DEFAULT_SETTINGS.voice,
      ...saved.voice,
      grok: { ...DEFAULT_SETTINGS.voice.grok, ...(saved.voice && saved.voice.grok) },
      minimax: { ...DEFAULT_SETTINGS.voice.minimax, ...(saved.voice && saved.voice.minimax) },
      eleven: { ...DEFAULT_SETTINGS.voice.eleven, ...(saved.voice && saved.voice.eleven) },
    },
  };

  // 最早的版本只能接一家,存的是平铺的三项。转成一条线路,已经填好的 Key 不会丢
  if (!settings.lines.length && apiBaseUrl) {
    const preset = PRESETS.find((p) => p.apiBaseUrl === apiBaseUrl);
    settings.lines = [{ id: 'main', label: preset ? preset.label : '日常', apiBaseUrl, apiKey: apiKey || '', model }];
  }
  if (!settings.lines.length) settings.lines = [{ ...newLine(), id: 'main' }];
  if (!settings.lines.some((line) => line.id === settings.routes.chat)) settings.routes.chat = settings.lines[0].id;
  return settings;
}

export const saveSettings = (settings) => store.set('settings', settings);

function isNight(settings, now) {
  const date = new Date(now);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const { nightFrom: from, nightTo: to } = settings;
  // 23:00 到 05:00 这种跨过零点的时间段,是"晚于开始或早于结束"
  return from <= to ? clock >= from && clock < to : clock >= from || clock < to;
}

// 这个场合现在该用哪条线路。purpose:'chat' 聊天,'call' 打电话,'memory' 整理记忆
export async function lineFor(purpose, now = Date.now()) {
  const settings = await loadSettings();
  const byId = (id) => settings.lines.find((line) => line.id === id);
  let line = byId(settings.routes.chat);
  if (purpose !== 'memory' && isNight(settings, now)) line = byId(settings.routes.night) || line;
  if (purpose === 'call') line = byId(settings.routes.call) || line;
  if (purpose === 'memory') line = byId(settings.routes.memory) || line;
  return { ...line, temperature: settings.temperature };
}

// 默认人设和聊天规则是项目里的文本文件,改文件就能改默认值
//   character.txt        放到网上的默认人设,谁都能看到,所以只是个空白模板
//   character.local.txt  你自己的人设,只留在电脑上,不上传。电脑上本地预览时有它就用它
//   chat-rules.txt       打字聊天的规则
let defaults;
async function loadDefaults() {
  const read = (file) =>
    fetch(file)
      .then((res) => (res.ok ? res.text() : ''))
      .catch(() => '');
  defaults ||= Promise.all([read('character.local.txt'), read('character.txt'), read('chat-rules.txt')]).then(
    ([local, shared, rules]) => ({ persona: (local || shared).trim(), rules: rules.trim() }),
  );
  return defaults;
}

export const defaultPersona = async () => (await loadDefaults()).persona;

export const getPersona = async () => (await store.get('persona')) || defaultPersona();

// 和默认一样就不单独存,这样以后改了默认文件也会跟着变
export async function savePersona(text) {
  const persona = text.trim();
  await store.set('persona', persona && persona !== (await defaultPersona()) ? persona : null);
}

function explain(status, body) {
  // 对面给的原话也一起显示,里面常常直接写了原因和该怎么改
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || body;
  } catch {}
  detail = String(detail).slice(0, 200);
  if (status === 401) return `API Key 不对(${detail})`;
  if (status === 402) return `账户余额不足(${detail})`;
  if (status === 404) return `接口地址或模型名不对(${detail})`;
  if (status === 429) return `请求太频繁或额度用完了,等一会儿再试(${detail})`;
  return `接口报错 ${status}:${detail}`;
}

const endpoint = (line, path) => `${line.apiBaseUrl.replace(/\/$/, '')}/${path}`;

// 向一条线路发一次对话请求,返回 AI 回的文字
export async function chat(line, messages, { temperature = line.temperature, json = false } = {}) {
  if (!line.apiKey) throw new Error('还没填 API Key');
  if (!line.model) throw new Error('还没填模型名,点模型名下面的按钮选一个');
  const body = { model: line.model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(endpoint(line, 'chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${line.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('连不上 AI 接口,检查网络或接口地址');
    }
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content.trim();
    }
    // 对面临时抽风(限流、服务器错误)就等一下再试,最多三次
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await sleep(1000);
      continue;
    }
    // 有的模型不认"强制 JSON"这个开关,去掉再试一次(提示词里本来也要求了 JSON)
    if (res.status === 400 && body.response_format) {
      delete body.response_format;
      continue;
    }
    throw new Error(explain(res.status, await res.text()));
  }
}

export const testConnection = (line) =>
  chat(line, [{ role: 'user', content: '回复一个"好"字' }], { temperature: 0 });

// 问这家现在有哪些能聊天的模型。问不到就返回空,不算错
export async function listModels(line) {
  try {
    // sub_type=chat 是硅基流动的筛选参数,只要聊天模型;别家不认识这个参数会直接忽略
    const res = await fetch(endpoint(line, 'models?sub_type=chat'), {
      headers: { authorization: `Bearer ${line.apiKey}` },
    });
    const data = await res.json();
    const notChat = /embed|rerank|bge|whisper|tts|speech|voice|image|video/i;
    return data.data.map((model) => model.id).filter((id) => !notChat.test(id)).sort();
  } catch {
    return [];
  }
}

// 把一条条气泡合成一轮轮对话:连着几条是同一个人发的,就并成一轮
// 你的每一轮开头标上发送时间,他才知道隔了多久、现在多晚
function toTurns(messages) {
  const turns = [];
  let note = '';
  for (const m of messages) {
    // "语音通话 03:20"这种记号不算对话,但要在你下一句话前告诉他:电话挂了,回到打字
    // 不然他会以为还在电话里,接着用电话腔回你
    if (m.role === 'note') {
      note = m.content;
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let content = m.content;
    if (m.role === 'user' && note) content = `(${note} 已经结束,现在回到打字聊天)${content}`;
    if (m.role === 'user') note = '';
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content += `\n${content}`;
    else turns.push({ role: m.role, content: m.role === 'user' ? `[${stamp(m.t)}] ${content}` : content });
  }
  // 有的 AI 接口要求对话必须由你这边开头。如果最前面是他的话,垫一句
  if (turns.length && turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(更早的对话略)' });
  return turns;
}

// 第一次聊天时让他给自己起名,之后固定不变
async function pickName(line, persona) {
  const raw = await chat(line, [
    { role: 'system', content: persona },
    { role: 'user', content: '给你自己起一个中文名字,两到三个字,像现实里会有的名字。只输出名字,不要别的。' },
  ]);
  // 万一他没听话多说了几个字("我叫XX。"),只留名字本身
  return raw.replace(/^.*(我叫|我是|名字是|叫做)/u, '').replace(/[^\p{Script=Han}]/gu, '').slice(0, 4) || '阿屿';
}

// 出戏了就悄悄重试一次,还不行返回 null,由调用的地方换成一句圆场的话
async function replyInCharacter(line, messages) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(line, messages);
    if (!OUT_OF_CHARACTER.test(raw)) return raw;
    console.warn('出戏了,重试一次:', raw.slice(0, 80));
  }
  return null;
}

// ---------- 深夜设定和安全词 ----------

const SAFEWORD_PAUSE_MS = 6 * 60 * 60 * 1000; // 说了安全词之后,这么久之内不再用深夜设定

// 你最近这一轮话里有没有说安全词
async function saidSafeword(messages) {
  const { safeword } = await loadSettings();
  if (!safeword) return false;
  const recent = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'user'; i--) recent.push(messages[i].content);
  return recent.some((text) => text.toLowerCase().includes(safeword.toLowerCase()));
}

// 说了安全词:记下时间,深夜设定先停用
export async function noteSafeword(messages) {
  if (!(await saidSafeword(messages))) return false;
  await store.set('nightPausedUntil', Date.now() + SAFEWORD_PAUSE_MS);
  return true;
}

// 这一刻要额外加给他的深夜内容:到了深夜时段、你填了深夜设定、最近没说过安全词,才加
async function nightSection(messages) {
  const settings = await loadSettings();
  const now = Date.now();
  if (await noteSafeword(messages)) {
    return `## 安全词
ta 刚刚说了安全词"${settings.safeword}"。不管刚才在做什么,立刻完全停下,不再继续任何亲密或压制的内容,也不要追问原因。
换回平常的你:语气放软,简单确认 ta 现在还好吗、需不需要什么。之后由 ta 决定聊什么。`;
  }
  const pausedUntil = (await store.get('nightPausedUntil')) || 0;
  if (!settings.nightPrompt.trim() || !isNight(settings, now) || pausedUntil > now) return '';
  return `## 深夜\n${settings.nightPrompt.trim()}\n\n不管在做什么,ta 说出"${settings.safeword}"就立刻停下。`;
}

// 准备好一次回复要用的东西:他的名字(没有就现起)和系统提示词
// 人设 + 名字 + 这个场合的规则 + 深夜设定(到点才有)+ 记忆
async function prepare(line, rules, messages) {
  const persona = await getPersona();
  let name = await store.get('name');
  if (!name) {
    name = await pickName(line, persona);
    await store.set('name', name);
  }
  const night = await nightSection(messages);
  const remembered = renderMemory(await loadMemory(), Date.now());
  const system = [persona, `你的名字是${name}。`, rules, night, remembered && `## 你记得的事\n${remembered}`]
    .filter(Boolean)
    .join('\n\n');
  return { name, system };
}

// 把他的回复拆成一行一行。万一他学着在回复里也带上时间戳,去掉
const linesOf = (raw) =>
  raw
    .split(/\n+/)
    .map((text) => text.replace(/^\s*\[[^\]\n]{0,30}\]\s*/, '').trim())
    .filter(Boolean);

// 真人发微信很少在句末打句号,去掉。问号、感叹号、省略号留着
const casual = (text) => text.replace(/(?<!。)。$/u, '');

// 打字聊天:根据到目前为止的聊天记录,生成他的下一轮回复。返回他的名字和拆好的气泡
// cue 是只给他看的一句提示,接在聊天记录最后,不会存进聊天记录
export async function reply(messages, cue = '') {
  const line = await lineFor('chat');
  const { rules } = await loadDefaults();
  const { name, system } = await prepare(line, rules, messages);
  const turns = toTurns(messages.slice(-CONTEXT_MESSAGES));
  if (cue) turns.push({ role: 'user', content: `[${stamp(Date.now())}] ${cue}` });
  const raw = await replyInCharacter(line, [{ role: 'system', content: system }, ...turns]);
  return { name, bubbles: linesOf(raw || FALLBACK).map(casual) };
}

// 隔了一阵你再打开小手机时,他先找你。hours 是离上次说话过了多久,没聊过就是 null
export function opener(messages, hours) {
  const gap = hours === null ? '你们还没聊过天' : `距离你们上次说话已经过了大约 ${Math.round(hours)} 小时`;
  return reply(
    messages,
    `(这条是系统提示,不是 ta 发的:ta 刚拿起手机,${gap}。你主动给 ta 发消息,就像你算好 ta 这会儿有空。` +
      '可以说你自己刚遇到的事、转一个你刷到的东西,或者顺着 ta 现在大概的状态接上。不要问 ta 在干嘛,也不要提到这条提示。)',
  );
}

// 把"一行英文、一行中文"的回复配成对:[{ en, zh }]。靠有没有汉字来分辨哪行是哪种
export function parseBilingual(raw) {
  const items = [];
  for (const text of linesOf(raw)) {
    const line = text.replace(/^(EN|ZH|English|Chinese|英文|中文|翻译)\s*[::]\s*/i, '');
    const last = items[items.length - 1];
    if (!/\p{Script=Han}/u.test(line)) items.push({ en: line, zh: '' });
    else if (last && !last.zh) last.zh = line;
    else items.push({ en: '', zh: line });
  }
  // 万一他只说了中文,就直接念中文
  return items.map((item) => (item.en ? item : { en: item.zh, zh: '' }));
}

// Grok 实时通话用的规则:他直接开口说,不需要"一行英文一行中文"的格式,中文翻译另外做
const REALTIME_RULES = `## 现在是语音通话
- 全程用英语说。要地道:像母语是英语的人平时打电话那样,用缩写和口语,句子短,不要书面语,不要把中文的说法直译过来。
- ta 说中文或英文你都听得懂,你始终用英语回答。
- 一次别说太久,说一两句就停下,给 ta 接话的空间。ta 打断你时就停下来听。
- 不要描述动作,不要念标点和表情。`;

// 准备 Grok 实时通话:系统提示词里放人设、规则、记忆和最近的聊天记录,让他接着平时的话头聊
export async function realtimeSetup(messages) {
  const line = await lineFor('chat');
  const { name, system } = await prepare(line, REALTIME_RULES, messages);
  const recent = spoken(messages)
    .slice(-30)
    .map((m) => `[${stamp(m.t)}] ${m.role === 'user' ? 'ta' : name}:${m.content}`)
    .join('\n');
  const now = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' });
  const instructions = [system, recent && `## 最近的聊天记录\n${recent}`, `现在是 ${now}。`]
    .filter(Boolean)
    .join('\n\n');
  return { name, instructions, opening: '(ta 给你打来了语音电话,你接了起来。先开口说第一句。)' };
}

// 把他在电话里说的一句英文翻成中文,给字幕用
export async function translate(text) {
  const line = await lineFor('chat');
  return chat(
    line,
    [
      { role: 'system', content: '把用户给的这句英文口语翻成自然的中文口语。只输出译文,不要解释。' },
      { role: 'user', content: text },
    ],
    { temperature: 0.3 },
  );
}

// 打电话:生成他接下来要说的几句话,每句带英文和中文
// opening 表示电话刚接通,他先开口;sounds 表示现在用的声音能念出笑声叹气
export async function callReply(messages, { opening = false, sounds = false } = {}) {
  const line = await lineFor('call');
  const { name, system } = await prepare(line, sounds ? `${CALL_RULES}\n${SOUND_RULE}` : CALL_RULES, messages);
  const turns = toTurns(messages.slice(-CONTEXT_MESSAGES));
  if (opening) {
    const cue = `[${stamp(Date.now())}] (ta 给你打来了语音电话,你接了起来,先开口)`;
    const last = turns[turns.length - 1];
    if (last && last.role === 'user') last.content += `\n${cue}`;
    else turns.push({ role: 'user', content: cue });
  }
  const raw = await replyInCharacter(line, [{ role: 'system', content: system }, ...turns]);
  const items = raw ? parseBilingual(raw) : [];
  return { name, items: items.length ? items : CALL_FALLBACK };
}

// ---------- 记忆整理 ----------

// 小整理:把还没整理的聊天压成碎片。返回压了几段
async function microBatch(line, name, messages, now, force) {
  let made = 0;
  for (let round = 0; round < 5; round++) {
    const memory = await loadMemory();
    const pending = spoken(messages).filter((m) => m.id > memory.upToId);
    if (!pending.length) break;
    // 平时攒够 30 条才整理,每次正好整理 30 条;手动点"现在整理"时不管攒了多少都整理
    if (!force && pending.length < EVERY) break;

    const batch = pending.slice(0, force ? BATCH_MAX : EVERY);
    const raw = await chat(line, microPrompt(name, memory, batch, now), { temperature: 0.3, json: true });
    const update = parseJSON(raw);

    // 整理期间你可能在记忆页里增删了东西,所以重新读一遍再改;期间被清空了就作废
    const fresh = await loadMemory();
    if (fresh.upToId !== memory.upToId) break;
    applyMicro(fresh, update, batch);
    fresh.lastMicro = now;
    await saveMemory(fresh);
    made++;
  }
  return made;
}

// 大整理:每天一次,把前一天的碎片写成小传、更新卡片、让到期的状态下线。返回有没有写小传
async function nightly(line, name, now) {
  const memory = await loadMemory();
  const today = dayKey(now);
  if (memory.nightlyDay === today || new Date(now).getHours() < NIGHTLY_HOUR) return false;

  const due = memory.fragments.filter((f) => f.d < today);
  const expired = memory.states.filter((s) => s.until < today);
  let update = null;
  if (due.length) {
    const prompt = nightlyPrompt(name, await getPersona(), memory, due, expired);
    update = parseJSON(await chat(line, prompt, { temperature: 0.3, json: true }));
  }

  const fresh = await loadMemory();
  if (fresh.nightlyDay !== memory.nightlyDay || fresh.upToId !== memory.upToId) return false;
  const archived = applyNightly(fresh, update, today);
  if (archived.length) await store.set('archive', [...(await loadArchive()), ...archived]);
  await saveMemory(fresh);
  return due.length > 0;
}

let maintaining = false;

// 该整理就整理,不该就什么都不做,所以界面可以放心地时不时调它一下
// force 是你在记忆页手动点"现在整理":不等聊天停下,也不管是不是在歇着
// 返回 { fragments: 压了几段, nightly: 有没有写小传 }。出错会记进 memory.lastError 再抛出
export async function maintain(messages, { force = false } = {}) {
  const nothing = { fragments: 0, nightly: false };
  if (maintaining) return nothing;
  maintaining = true;
  try {
    const line = await lineFor('memory');
    const name = await store.get('name');
    const now = Date.now();
    if (!line.apiKey || !name || !navigator.onLine) return nothing;
    if (!force && (await loadMemory()).pausedUntil > now) return nothing;

    try {
      const fragments = await microBatch(line, name, messages, now, force);
      const wrote = await nightly(line, name, now);
      if (fragments || wrote) {
        const memory = await loadMemory();
        Object.assign(memory, { fails: 0, lastError: '', pausedUntil: 0 });
        await saveMemory(memory);
      }
      return { fragments, nightly: wrote };
    } catch (err) {
      const memory = await loadMemory();
      memory.fails += 1;
      memory.lastError = err.message;
      if (memory.fails >= 3) memory.pausedUntil = now + PAUSE_MS;
      await saveMemory(memory);
      throw err;
    }
  } finally {
    maintaining = false;
  }
}
