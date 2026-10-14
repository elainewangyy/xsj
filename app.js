// 界面:聊天页和设置页。和 AI 有关的事都交给 brain.js,和存储有关的事都交给 store.js
import * as store from './store.js';
import * as brain from './brain.js';
import { CARDS, loadMemory, saveMemory, pin, forget, activeStates, stamp, spoken } from './memory.js';
import { startCall, inCall, bubbleNode } from './call.js';
import {
  GROK,
  VOICES,
  MINIMAX_MODELS,
  ELEVEN_MODELS,
  grokVoices,
  minimaxVoices,
  elevenVoices,
  synthesize,
  Player,
} from './voice.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = 200; // 一次显示多少条,更早的点按钮再加载
const GAP = 5 * 60 * 1000; // 两条消息隔这么久,中间显示一次时间
const WAIT = 2500; // 你发完等这么久他才开始回,所以连发几条他会一起回

let messages = [];
let shown = PAGE;
let replying = false;
let replyTimer = null;

// ---------- 聊天页 ----------

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function timeLabel(t) {
  const date = new Date(t);
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (daysAgo === 0) return clock;
  if (daysAgo === 1) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function messageNodes(msg, prev) {
  const nodes = [];
  if (!prev || msg.t - prev.t > GAP) {
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = timeLabel(msg.t);
    nodes.push(time);
  }
  if (msg.role === 'note') {
    // "语音通话 03:20"这种记号,居中显示成一行小字
    const note = document.createElement('div');
    note.className = 'time';
    note.textContent = msg.content;
    nodes.push(note);
  } else {
    nodes.push(bubbleNode(msg.role, msg.content, msg.zh));
  }
  return nodes;
}

function render() {
  const start = Math.max(0, messages.length - shown);
  const nodes = messages.slice(start).flatMap((msg, i) => messageNodes(msg, messages[start + i - 1]));
  $('list').replaceChildren(...nodes);
  $('earlier').hidden = start === 0;
}

function scrollToBottom() {
  $('chat').scrollTop = $('chat').scrollHeight;
}

// extra 是附带的信息,比如电话里那句话的中文翻译 { zh, call: true }
async function addMessage(role, content, extra = {}) {
  const msg = await store.addMessage({ role, content, t: Date.now(), ...extra });
  $('list').append(...messageNodes(msg, messages[messages.length - 1]));
  messages.push(msg);
  scrollToBottom();
  return msg;
}

function setTyping(on) {
  $('typing').hidden = !on;
  if (on) scrollToBottom();
}

function showNotice(text, actionLabel, onAction) {
  $('notice-text').textContent = text;
  $('notice-action').hidden = !actionLabel;
  $('notice-action').textContent = actionLabel || '';
  $('notice-action').onclick = onAction || null;
  $('notice').hidden = false;
}

function hideNotice() {
  $('notice').hidden = true;
}

function resizeInput() {
  $('input').style.height = 'auto';
  $('input').style.height = `${$('input').scrollHeight + 2}px`;
  $('send').disabled = !$('input').value.trim();
}

async function send() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  resizeInput();
  await addMessage('user', text);
  scheduleReply();
}

function scheduleReply(delay = WAIT) {
  clearTimeout(replyTimer);
  replyTimer = setTimeout(runReply, delay);
}

async function runReply() {
  const last = messages[messages.length - 1];
  if (replying || inCall() || !last || last.role !== 'user') return;
  if ($('input').value.trim()) return scheduleReply(); // 你还在打字,他再等等
  if (!navigator.onLine) return showNotice('现在没有网络。连上之后他会回你。');

  replying = true;
  hideNotice();
  setTyping(true);
  let ok = false;
  try {
    const { name, bubbles } = await brain.reply(messages);
    $('name').textContent = name;
    // 一条一条发出来,字多的那条"打"得久一点
    for (const text of bubbles) {
      setTyping(true);
      await sleep(Math.min(400 + text.length * 60, 2200));
      setTyping(false);
      await addMessage('assistant', text);
    }
    ok = true;
  } catch (err) {
    if (err.message.includes('API Key')) showNotice(`${err.message}。`, '去设置', openSettings);
    else showNotice(`这条没回成:${err.message}。`, '重试', runReply);
  }
  setTyping(false);
  replying = false;

  // 他回的时候你又发了新消息,接着回
  if (ok && messages[messages.length - 1].role === 'user') scheduleReply();
  if (ok) maintainQuietly();
}

// ---------- 记忆页 ----------

// 在后台看看有没有该整理的记忆。大多数时候什么都不会发生
function maintainQuietly() {
  brain
    .maintain(messages)
    .then((result) => {
      if ((result.fragments || result.nightly) && !$('memory').hidden) renderMemoryPage();
    })
    .catch(async () => {
      const memory = await loadMemory();
      if (memory.fails === 3) showNotice('记忆整理连续失败了三次,先歇一会儿。', '看看', openMemory);
    });
}

// 一个小标题加一组条目。rows 里每项是 { text, note, onRemove },没有条目就什么都不显示
function memoryList(title, rows) {
  if (!rows.length) return [];
  const heading = document.createElement('h2');
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'memory-list';
  for (const row of rows) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = row.text;
    if (row.note) {
      const note = document.createElement('small');
      note.textContent = row.note;
      text.append(note);
    }
    item.append(text);
    if (row.onRemove) {
      const button = document.createElement('button');
      button.textContent = '×';
      button.setAttribute('aria-label', '删掉这条');
      button.onclick = row.onRemove;
      item.append(button);
    }
    list.append(item);
  }
  return [heading, list];
}

async function changeMemory(change) {
  const memory = await loadMemory();
  change(memory);
  await saveMemory(memory);
  renderMemoryPage();
}

async function renderMemoryPage() {
  const memory = await loadMemory();
  const now = Date.now();

  const pending = spoken(messages).filter((m) => m.id > memory.upToId).length;
  let status = `聊天记录 ${messages.length} 条,其中 ${pending} 条还没整理。`;
  status += memory.lastMicro ? `上次整理:${stamp(memory.lastMicro)}。` : '还没整理过。';
  if (memory.lastError) status += `最近一次整理失败(连续 ${memory.fails} 次):${memory.lastError}。`;
  if (memory.pausedUntil > now) status += `先歇到 ${stamp(memory.pausedUntil)} 再自动重试。`;
  $('memory-status').textContent = status;

  const removeById = (id) => () => {
    if (confirm('删掉这条记忆?')) changeMemory((m) => forget(m, id));
  };
  const removable = (items) => items.map((x) => ({ text: x.text, onRemove: removeById(x.id) }));

  const nodes = [
    ...memoryList(
      '眼下的情况',
      activeStates(memory, now).map((s) => ({ text: s.text, note: `到 ${s.until}`, onRemove: removeById(s.id) })),
    ),
    ...memoryList('你让他记住的', removable(memory.pinned)),
    ...Object.keys(CARDS).flatMap((name) => memoryList(name, removable(memory.cards[name]))),
    ...memoryList(
      '你们的大事记',
      memory.timeline.map((e) => ({
        text: e.text,
        note: e.d,
        onRemove: () => {
          if (!confirm('删掉这条大事记?')) return;
          changeMemory((m) => (m.timeline = m.timeline.filter((x) => x.d !== e.d || x.text !== e.text)));
        },
      })),
    ),
    ...memoryList('每天的小传', memory.diary.slice(-30).reverse().map((d) => ({ text: d.text, note: d.d }))),
    ...memoryList('刚聊过、还没写进小传的', memory.fragments.map((f) => ({ text: f.text, note: f.d }))),
  ];

  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '他还没攒下记忆。每攒够 30 条聊天记录,他会自己整理一次;也可以点上面的"现在整理"。';
    nodes.push(empty);
  }
  $('memory-content').replaceChildren(...nodes);
}

async function openMemory() {
  $('memory-run-result').textContent = '';
  await renderMemoryPage();
  $('memory').hidden = false;
}

async function runMemoryNow() {
  if (!navigator.onLine) {
    $('memory-run-result').textContent = '现在没有网络。';
    return;
  }
  $('memory-run').disabled = true;
  $('memory-run-result').textContent = '整理中…';
  try {
    const result = await brain.maintain(messages, { force: true });
    $('memory-run-result').textContent = result.fragments || result.nightly ? '整理好了。' : '没有新内容要整理。';
  } catch (err) {
    $('memory-run-result').textContent = `没成:${err.message}`;
  }
  $('memory-run').disabled = false;
  renderMemoryPage();
}

async function addPin() {
  const text = $('pin-text').value.trim();
  if (!text) return;
  $('pin-text').value = '';
  await changeMemory((m) => pin(m, text));
}

// ---------- 设置页 ----------

const CUSTOM = '自定义';

// 模型名下面的快捷按钮:点一下就填上,不用自己打
function showModels(card, models) {
  const buttons = models.map((model) => {
    const button = document.createElement('button');
    button.className = 'plain-button small';
    button.textContent = model;
    button.onclick = () => (card.querySelector('.line-model').value = model);
    return button;
  });
  card.querySelector('.line-models').replaceChildren(...buttons);
}

function readLine(card) {
  const value = (selector) => card.querySelector(selector).value.trim();
  return {
    id: card.dataset.id,
    label: value('.line-label') || '没起名',
    apiBaseUrl: value('.line-base'),
    apiKey: value('.line-key'),
    model: value('.line-model'),
  };
}

const readLines = () => [...$('lines').children].map(readLine);

// 三个"用哪条"下拉框的选项跟着上面的线路走。selected 不传就保留现在选的
function fillRoutes(selected) {
  const lines = readLines();
  for (const purpose of ['chat', 'night', 'memory', 'call']) {
    const select = $(`route-${purpose}`);
    const keep = selected ? selected[purpose] : select.value;
    const options = lines.map((line) => new Option(line.label, line.id));
    if (purpose !== 'chat') options.unshift(new Option('跟日常聊天一样', ''));
    select.replaceChildren(...options);
    const fallback = purpose === 'chat' ? lines[0].id : '';
    select.value = lines.some((line) => line.id === keep) ? keep : fallback;
  }
}

// 在设置页里加一条线路的表单
function addLineCard(line) {
  const card = $('line-template').content.firstElementChild.cloneNode(true);
  const field = (selector) => card.querySelector(selector);
  card.dataset.id = line.id;

  const labels = [...brain.PRESETS.map((p) => p.label), CUSTOM];
  field('.line-preset').replaceChildren(...labels.map((label) => new Option(label)));
  const preset = brain.PRESETS.find((p) => p.apiBaseUrl === line.apiBaseUrl);
  field('.line-preset').value = preset ? preset.label : CUSTOM;
  field('.line-label').value = line.label;
  field('.line-base').value = line.apiBaseUrl;
  field('.line-key').value = line.apiKey;
  field('.line-model').value = line.model;
  showModels(card, preset ? preset.models : []);

  field('.line-preset').onchange = () => {
    const chosen = brain.PRESETS.find((p) => p.label === field('.line-preset').value);
    showModels(card, chosen ? chosen.models : []);
    if (!chosen) return;
    field('.line-label').value = chosen.label;
    field('.line-base').value = chosen.apiBaseUrl;
    field('.line-model').value = chosen.models[0] || '';
    fillRoutes();
  };
  field('.line-label').oninput = () => fillRoutes();
  field('.line-remove').onclick = () => {
    if ($('lines').children.length === 1) return alert('至少要留一条线路。');
    card.remove();
    fillRoutes();
  };
  field('.line-test').onclick = async () => {
    field('.line-result').textContent = '测试中…';
    const draft = { ...readLine(card), temperature: 0 };
    // 先问问这家现在有哪些模型,列成按钮。问不到也没关系
    const models = await brain.listModels(draft);
    if (models.length) showModels(card, models);
    try {
      await brain.testConnection(draft);
      field('.line-result').textContent = '能连上。';
    } catch (err) {
      field('.line-result').textContent = `不行:${err.message}`;
    }
  };

  $('lines').append(card);
}

async function openSettings() {
  const settings = await brain.loadSettings();
  $('lines').replaceChildren();
  settings.lines.forEach(addLineCard);
  fillRoutes(settings.routes);
  $('night-from').value = settings.nightFrom;
  $('night-to').value = settings.nightTo;
  $('night-prompt').value = settings.nightPrompt;
  $('safeword').value = settings.safeword;

  const { voice } = settings;
  $('voice-provider').value = voice.provider;
  $('voice-key').value = voice.apiKey;
  $('voice-voice').replaceChildren(...VOICES.map(([id, label]) => new Option(label, id)));
  $('voice-voice').value = voice.voice;
  const modelOptions = (models) => models.map(([id, label]) => new Option(`${id}(${label})`, id));
  $('minimax-key').value = voice.minimax.apiKey;
  $('minimax-model').replaceChildren(...modelOptions(MINIMAX_MODELS));
  $('minimax-model').value = voice.minimax.model;
  $('eleven-key').value = voice.eleven.apiKey;
  $('eleven-model').replaceChildren(...modelOptions(ELEVEN_MODELS));
  $('eleven-model').value = voice.eleven.model;
  $('grok-key').value = voice.grok.apiKey;
  $('voice-result').textContent = '';
  showVoiceProvider();
  loadGrokVoices(voice.grok.voice);
  loadMinimaxVoices(voice.minimax.voiceId);
  loadElevenVoices(voice.eleven.voiceId);

  $('his-name').value = (await store.get('name')) || '';
  $('persona').value = await brain.getPersona();
  $('storage-info').textContent = `这台设备上现在存着 ${messages.length} 条消息。`;
  $('settings').hidden = false;
}

async function saveSettings() {
  const settings = await brain.loadSettings();
  await brain.saveSettings({
    ...settings,
    lines: readLines(),
    routes: {
      chat: $('route-chat').value,
      night: $('route-night').value,
      memory: $('route-memory').value,
      call: $('route-call').value,
    },
    nightFrom: $('night-from').value || settings.nightFrom,
    nightTo: $('night-to').value || settings.nightTo,
    nightPrompt: $('night-prompt').value,
    safeword: $('safeword').value.trim(),
    voice: readVoice(settings.voice),
  });
  await brain.savePersona($('persona').value);
  const name = $('his-name').value.trim();
  if (name) {
    await store.set('name', name);
    $('name').textContent = name;
  }
  $('settings').hidden = true;
  hideNotice();
  runReply(); // 之前因为没填 Key 没回成的,现在接着回
}

// 选了哪家,就只显示哪家要填的东西
function showVoiceProvider() {
  const provider = $('voice-provider').value;
  $('voice-grok').hidden = provider !== 'grok';
  $('voice-minimax').hidden = provider !== 'minimax';
  $('voice-eleven').hidden = provider !== 'elevenlabs';
  $('voice-silicon').hidden = provider !== 'siliconflow';
  $('voice-relay').hidden = provider === 'grok';
}

// Grok 的 Key:这里没填就用设置页里那条 Grok 线路的
const grokKey = () =>
  $('grok-key').value.trim() || (readLines().find((line) => line.apiBaseUrl === GROK && line.apiKey) || {}).apiKey || '';

async function loadGrokVoices(selected) {
  const voices = await grokVoices(grokKey());
  if (selected && !voices.some((v) => v.id === selected)) voices.unshift({ id: selected, name: selected });
  $('grok-voice').replaceChildren(...voices.map((v) => new Option(v.name === v.id ? v.id : `${v.name} · ${v.id}`, v.id)));
  if (selected) $('grok-voice').value = selected;
}

let minimaxList = []; // MiniMax 的声音列表,填了 Key 才拿得到

async function loadMinimaxVoices(selected) {
  try {
    minimaxList = await minimaxVoices($('minimax-key').value.trim());
  } catch {
    minimaxList = [];
  }
  // 拿不到列表(没填 Key、Key 不对、没网)时,留着已经选好的那个,免得保存时把它弄丢
  if (!minimaxList.length && selected) minimaxList = [{ id: selected, name: selected, note: '' }];
  $('minimax-voice').replaceChildren(...minimaxList.map((v) => new Option(v.name === v.id ? v.id : `${v.name} · ${v.id}`, v.id)));
  if (minimaxList.some((v) => v.id === selected)) $('minimax-voice').value = selected;
  showMinimaxNote();
}

// 选中的声音下面显示它的一句介绍
function showMinimaxNote() {
  const chosen = minimaxList.find((v) => v.id === $('minimax-voice').value);
  $('minimax-note').textContent = chosen
    ? chosen.note || '这个声音没有介绍,点下面的按钮听听看。'
    : '填了 Key 之后,这里会列出能用的声音,英文的排在前面。';
}

let elevenList = []; // ElevenLabs 的声音列表,打开设置页时去拿

async function loadElevenVoices(selected) {
  try {
    elevenList = await elevenVoices($('eleven-key').value.trim());
  } catch {
    // 拿不到列表(比如没网)就只留已经选好的那个,免得保存时把它弄丢
    elevenList = selected ? [{ id: selected, name: '已经选好的声音', gender: '', accent: '', sample: '' }] : [];
  }
  const sex = { male: '男', female: '女' };
  const label = (v) => [v.name, sex[v.gender], v.accent].filter(Boolean).join(' · ');
  $('eleven-voice').replaceChildren(...elevenList.map((v) => new Option(label(v), v.id)));
  if (elevenList.some((v) => v.id === selected)) $('eleven-voice').value = selected;
}

// 设置页里"语音和电话"现在填的内容
function readVoice(saved) {
  return {
    ...saved,
    provider: $('voice-provider').value,
    apiKey: $('voice-key').value.trim(),
    voice: $('voice-voice').value,
    grok: { apiKey: $('grok-key').value.trim(), voice: $('grok-voice').value },
    minimax: {
      apiKey: $('minimax-key').value.trim(),
      voiceId: $('minimax-voice').value,
      model: $('minimax-model').value,
    },
    eleven: {
      apiKey: $('eleven-key').value.trim(),
      voiceId: $('eleven-voice').value,
      model: $('eleven-model').value,
    },
  };
}

// 用设置页里现在选的声音念一句,不用先保存
async function testVoice() {
  $('voice-result').textContent = '合成中…';
  try {
    const config = readVoice((await brain.loadSettings()).voice);
    // 没单独填硅基流动的 Key 时,借用设置页里那条硅基流动线路的
    const sameProvider = readLines().find((line) => line.apiBaseUrl === config.apiBaseUrl && line.apiKey);
    if (!config.apiKey && sameProvider) config.apiKey = sameProvider.apiKey;
    config.grok.apiKey = grokKey();

    const context = new AudioContext();
    context.resume();
    const sound = await synthesize(config, "Hey, it's me. Did you eat yet?");
    $('voice-result').textContent = '在放了。';
    await new Player(context).play(sound);
    context.close();
  } catch (err) {
    $('voice-result').textContent = `不行:${err.message}`;
  }
}

async function exportBackup() {
  const data = await store.exportAll();
  // 人设总是写进备份。换一台设备导入时,那边的默认人设可能不一样
  data.kv.persona = await brain.getPersona();
  // 备份里不带任何 Key,这样备份文件发给别人或存网盘也不怕
  if (data.kv.settings) {
    delete data.kv.settings.apiKey;
    for (const line of data.kv.settings.lines || []) delete line.apiKey;
    const { voice } = data.kv.settings;
    if (voice) delete voice.apiKey;
    if (voice && voice.eleven) delete voice.eleven.apiKey;
    if (voice && voice.minimax) delete voice.minimax.apiKey;
    if (voice && voice.grok) delete voice.grok.apiKey;
  }
  const day = new Date().toLocaleDateString('sv-SE');
  const file = new File([JSON.stringify(data)], `小手机备份-${day}.json`, { type: 'application/json' });

  // 手机上走系统的分享面板(可以存到"文件"或发给自己),电脑上直接下载
  const onPhone = matchMedia('(pointer: coarse)').matches;
  if (onPhone && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.version !== 1 || !Array.isArray(data.messages) || typeof data.kv !== 'object') throw new Error();
  } catch {
    alert('这个文件不是小手机的备份。');
    return;
  }
  const ok = confirm(
    `备份里有 ${data.messages.length} 条消息。导入会覆盖这台设备上现在的 ${messages.length} 条,确定吗?`,
  );
  if (!ok) return;

  // 备份里不含 Key,所以同一条线路保留这台设备上已经填好的
  const before = await brain.loadSettings();
  const keys = Object.fromEntries(before.lines.map((line) => [line.id, line.apiKey]));
  await store.importAll(data);
  const settings = await brain.loadSettings();
  for (const line of settings.lines) line.apiKey = keys[line.id] || '';
  settings.voice.apiKey = before.voice.apiKey;
  settings.voice.eleven.apiKey = before.voice.eleven.apiKey;
  settings.voice.minimax.apiKey = before.voice.minimax.apiKey;
  settings.voice.grok.apiKey = before.voice.grok.apiKey;
  await brain.saveSettings(settings);
  location.reload();
}

async function clearChat() {
  const ok = confirm(
    `确定清空这台设备上的 ${messages.length} 条聊天记录和他的全部记忆吗?他的名字和人设会保留。清空后无法恢复。`,
  );
  if (!ok) return;
  await store.clearMessages();
  await store.set('memory', null);
  await store.set('archive', []);
  messages = [];
  render();
  $('settings').hidden = true;
}

// ---------- 启动 ----------

$('input').addEventListener('input', resizeInput);
$('input').addEventListener('keydown', (event) => {
  // 回车发送,Shift+回车换行。拼音还没选字时的回车不算
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  send();
});
$('send').addEventListener('click', send);
$('earlier').addEventListener('click', () => {
  const before = $('chat').scrollHeight;
  shown += PAGE;
  render();
  $('chat').scrollTop += $('chat').scrollHeight - before;
});

$('open-memory').addEventListener('click', openMemory);
$('close-memory').addEventListener('click', () => ($('memory').hidden = true));
$('memory-run').addEventListener('click', runMemoryNow);
$('pin-add').addEventListener('click', addPin);
$('pin-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) addPin();
});

$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => ($('settings').hidden = true));
$('save-settings').addEventListener('click', saveSettings);
$('open-call').addEventListener('click', () => {
  startCall({
    messages,
    name: $('name').textContent,
    addMessage,
    setName: (name) => ($('name').textContent = name),
    // 挂断后重画一遍聊天页:电话里那几句的中文翻译是后来才补上的
    ended: () => {
      render();
      scrollToBottom();
      maintainQuietly();
    },
  });
});
$('voice-test').addEventListener('click', testVoice);
$('voice-provider').addEventListener('change', showVoiceProvider);
$('grok-key').addEventListener('change', () => loadGrokVoices($('grok-voice').value));
$('minimax-key').addEventListener('change', () => loadMinimaxVoices($('minimax-voice').value));
$('minimax-voice').addEventListener('change', showMinimaxNote);
$('eleven-key').addEventListener('change', () => loadElevenVoices($('eleven-voice').value));
$('eleven-sample').addEventListener('click', () => {
  const chosen = elevenList.find((v) => v.id === $('eleven-voice').value);
  if (chosen && chosen.sample) new Audio(chosen.sample).play();
});
$('add-line').addEventListener('click', () => {
  addLineCard(brain.newLine());
  fillRoutes();
});
$('reset-persona').addEventListener('click', async () => ($('persona').value = await brain.defaultPersona()));
$('export').addEventListener('click', exportBackup);
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (event) => {
  if (event.target.files[0]) importBackup(event.target.files[0]);
  event.target.value = '';
});
$('clear').addEventListener('click', clearChat);

addEventListener('online', runReply);

// 开着的时候每分钟看一眼,切回来的时候也看一眼:有没有聊完该整理的记忆
setInterval(maintainQuietly, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) maintainQuietly();
});

async function init() {
  // 请浏览器不要自动清理这里的数据
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  messages = await store.allMessages();
  $('name').textContent = (await store.get('name')) || '小手机'; // 他还没起名字时先这么显示
  render();
  scrollToBottom();

  const line = await brain.lineFor('chat');
  if (!line.apiKey) showNotice('先去设置里填 API Key,就能开始聊了。', '去设置', openSettings);
  else runReply(); // 上次你发了他还没回的,接着回
  maintainQuietly();

  // 装到主屏幕后断网也能打开。在电脑上本地调试时不启用,免得改了代码看不到
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !local) {
    // 已经装过旧版的话,新版下载好之后页面会自动刷新一次换成新版。第一次安装不刷新
    const hadVersion = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadVersion) location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((registration) => registration.update());
  }
}

init();
