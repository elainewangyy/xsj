// 打电话:通话页面,和"他说 -> 你说 -> 他说"的循环
// 大多数声音是对讲式的:你说完停一下,他才开始想、开始说,不能中途打断他
// 选 Grok 时换成真正的实时通话(realtime.js),可以随时打断
import * as brain from './brain.js';
import { putMessage } from './store.js';
import { GrokCall } from './realtime.js';
import {
  voiceConfig,
  checkVoice,
  supportsSounds,
  stripSounds,
  synthesize,
  transcribe,
  Player,
  Listener,
} from './voice.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let call = null; // 正在进行的这通电话。没在打就是 null

export const inCall = () => call !== null;

// 一个气泡。zh 有内容时是上下两行:上面原话,下面中文
export function bubbleNode(role, content, zh) {
  const bubble = document.createElement('div');
  bubble.className = `msg ${role}`;
  bubble.textContent = content;
  if (zh) {
    const translation = document.createElement('div');
    translation.className = 'msg-zh';
    translation.textContent = zh;
    bubble.append(translation);
  }
  return bubble;
}

const clock = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

function setStatus(text) {
  $('call-status').textContent = text;
}

function showBubble(role, content, zh) {
  const bubble = bubbleNode(role, content, zh);
  $('call-log').append(bubble);
  $('call-log').scrollTop = $('call-log').scrollHeight;
  return bubble;
}

function showName(name) {
  $('call-name').textContent = name;
  $('call-avatar').textContent = name.slice(0, 1);
}

function showToggle(id, on, label) {
  $(id).classList.toggle('off', !on);
  $(id).querySelector('span').textContent = `${label}${on ? '已开' : '已关'}`;
}

// 把麦克风、声音、计时都关掉。可以重复调用
function cleanup(state) {
  clearInterval(state.timer);
  if (state.grok) state.grok.stop();
  if (state.listener) state.listener.cancel();
  if (state.player) state.player.stop();
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  if (state.context && state.context.state !== 'closed') state.context.close();
}

// 开始打电话。host 是聊天页给的:{ messages, name, addMessage(role, content, extra), setName(name), ended() }
export async function startCall(host) {
  if (call) return;
  const state = (call = { host, active: true, startedAt: 0, micOn: true });

  $('call-log').replaceChildren();
  $('call-clock').textContent = '';
  showName(host.name);
  showToggle('call-mic', true, '麦克风');
  showToggle('call-sound', true, '扬声器');
  setStatus('接通中…');
  $('call').hidden = false;

  try {
    const config = await voiceConfig();
    checkVoice(config);
    if (!navigator.mediaDevices) throw new Error('这个网址用不了麦克风(要 https 开头的网址才行)');
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      throw new Error('没拿到麦克风。在浏览器里允许这个页面用麦克风,再打一次');
    }
    state.context = new AudioContext();
    state.context.resume();
    const startClock = () => {
      state.startedAt = Date.now();
      state.timer = setInterval(() => ($('call-clock').textContent = clock(Date.now() - state.startedAt)), 1000);
    };

    if (config.provider === 'grok') {
      await startGrok(state, config);
      if (!state.active) return cleanup(state); // 还没接通你就挂了
      startClock();
      return;
    }

    state.player = new Player(state.context);
    state.listener = new Listener(state.context, state.stream);
    await state.listener.start();
    if (!state.active) return cleanup(state); // 还没接通你就挂了

    startClock();
    await converse(state, config);
  } catch (err) {
    // 出错了就停在通话页上把原因显示出来,等你自己点挂断
    cleanup(state);
    if (state.active) setStatus(err.message);
  }
}

// Grok 实时通话。你说的和他说的都会进聊天记录;他说的英文另外翻成中文做字幕
async function startGrok(state, config) {
  const { host } = state;
  const setup = await brain.realtimeSetup(host.messages);
  host.setName(setup.name);
  showName(setup.name);

  state.grok = new GrokCall({
    apiKey: config.grok.apiKey,
    voice: config.grok.voice,
    instructions: setup.instructions,
    opening: setup.opening,
    context: state.context,
    stream: state.stream,
    events: {
      status: setStatus,
      heard: async (text) => {
        showBubble('user', text);
        await host.addMessage('user', text, { call: true });
        // 你说了安全词:他立刻停下,换回不带深夜设定的说明
        if (await brain.noteSafeword(host.messages)) {
          const fresh = await brain.realtimeSetup(host.messages);
          state.grok.redirect(fresh.instructions, '(ta 刚刚说了安全词。立刻停下,温柔地确认 ta 还好吗。)');
        }
      },
      said: async (text) => {
        const bubble = showBubble('assistant', text);
        const msg = await host.addMessage('assistant', text, { call: true });
        // 翻译慢一点没关系,先显示英文,中文到了再补上
        try {
          const zh = (await brain.translate(text)).trim();
          bubble.append(bubbleNode('assistant', '', zh).lastChild);
          msg.zh = zh;
          await putMessage(msg);
        } catch {}
      },
      failed: (text) => setStatus(text),
    },
  });
  await state.grok.start();
}

async function converse(state, config) {
  const { host } = state;
  let opening = true;

  while (state.active) {
    // 轮到他说
    setStatus(opening ? '接通中…' : '他在想…');
    let items = [];
    try {
      const result = await brain.callReply(host.messages, { opening, sounds: supportsSounds(config) });
      items = result.items;
      host.setName(result.name);
      showName(result.name);
    } catch (err) {
      setStatus(`他没接上话:${err.message}`);
      await sleep(2500);
    }
    opening = false;
    if (!state.active) return;

    // 几句话同时去合成声音,再按顺序放,这样等得短一点
    const sounds = items.map((item) => synthesize(config, item.en).catch((err) => err));
    for (const [i, item] of items.entries()) {
      const sound = await sounds[i];
      if (!state.active) return;
      // 念的时候带着 (laughs) 这类语气声,字幕和聊天记录里不留
      const shown = stripSounds(item.en);
      showBubble('assistant', shown, item.zh);
      await host.addMessage('assistant', shown, { zh: item.zh, call: true });
      if (sound instanceof Error) {
        setStatus(`声音没出来:${sound.message}`);
        await sleep(2500);
        continue;
      }
      setStatus('他在说话');
      await state.player.play(sound);
      if (!state.active) return;
    }

    // 轮到你说
    await sleep(250); // 等他的尾音散掉,免得被麦克风当成你在说话
    let text = '';
    while (state.active && !text) {
      setStatus(state.micOn ? '在听你说…' : '麦克风关着,他听不到你');
      const wav = await state.listener.listen();
      if (!state.active || !wav) continue;
      setStatus('听到了…');
      try {
        text = await transcribe(config, wav);
      } catch (err) {
        setStatus(`没听清:${err.message}`);
        await sleep(2500);
      }
    }
    if (!state.active) return;
    showBubble('user', text);
    await host.addMessage('user', text, { call: true });
  }
}

export async function endCall() {
  const state = call;
  if (!state) return;
  state.active = false;
  call = null;
  cleanup(state);
  $('call').hidden = true;
  if (state.startedAt) await state.host.addMessage('note', `语音通话 ${clock(Date.now() - state.startedAt)}`);
  state.host.ended();
}

$('call-end').addEventListener('click', endCall);

$('call-mic').addEventListener('click', () => {
  if (!call) return;
  call.micOn = !call.micOn;
  if (call.listener) call.listener.paused = !call.micOn;
  if (call.grok) call.grok.micOn = call.micOn;
  showToggle('call-mic', call.micOn, '麦克风');
  if (/在听你说|麦克风关着/.test($('call-status').textContent)) {
    setStatus(call.micOn ? '在听你说…' : '麦克风关着,他听不到你');
  }
});

$('call-sound').addEventListener('click', () => {
  const speaker = call && (call.grok || call.player);
  if (!speaker) return;
  const on = $('call-sound').classList.contains('off');
  speaker.muted = !on;
  showToggle('call-sound', on, '扬声器');
});
