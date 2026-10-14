// 声音:把文字念成他的声音、把你说的话听写成文字、放声音、麦克风收音和断句
// 他的声音有三家可选:MiniMax(国内,自然)、ElevenLabs(国外)、硅基流动。听写你说的话固定用硅基流动
import { loadSettings } from './brain.js';

const MINIMAX = 'https://api.minimax.cn/v1';
const ELEVEN = 'https://api.elevenlabs.io/v1';
export const GROK = 'https://api.x.ai/v1';

// Grok 的声音列表要有 Key 才拿得到。拿不到时先给这几个常见的
const GROK_FALLBACK = ['eve', 'ara', 'rex', 'sal', 'leo'].map((id) => ({ id, name: id }));

export async function grokVoices(apiKey) {
  if (!apiKey) return GROK_FALLBACK;
  try {
    const res = await fetch(`${GROK}/tts/voices`, { headers: { authorization: `Bearer ${apiKey}` } });
    const { voices } = await res.json();
    return voices.map((voice) => ({ id: voice.voice_id, name: voice.name || voice.voice_id }));
  } catch {
    return GROK_FALLBACK;
  }
}

// MiniMax 的几个模型。2.8 能念出笑声、叹气这类语气声
export const MINIMAX_MODELS = [
  ['speech-2.8-hd', '最自然,能笑能叹气'],
  ['speech-2.8-turbo', '快一点,能笑能叹气'],
  ['speech-2.6-hd', '上一代'],
  ['speech-2.6-turbo', '上一代,快'],
];

// MiniMax 账号下能用的声音。要填了 Key 才拿得到。每项:{ id, name, note }
export async function minimaxVoices(apiKey) {
  if (!apiKey) return [];
  const res = await fetch(`${MINIMAX}/get_voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ voice_type: 'all' }),
  });
  const data = await res.json();
  const own = [...(data.voice_cloning || []), ...(data.voice_generation || [])];
  const all = [...own, ...(data.system_voice || [])].map((voice) => ({
    id: voice.voice_id,
    name: voice.voice_name || voice.voice_id,
    note: (voice.description && voice.description[0]) || '',
  }));
  // 你自己做的声音排最前,然后是英文的,其他的在后面
  const rank = (voice) => (own.some((v) => v.voice_id === voice.id) ? 0 : /^English/i.test(voice.id) ? 1 : 2);
  return all.sort((a, b) => rank(a) - rank(b));
}

// 这套配置的声音能不能念出 (laughs) (sighs) 这类语气声
export const supportsSounds = (config) => config.provider === 'minimax' && config.minimax.model.startsWith('speech-2.8');

// 把语气声标签从文字里拿掉:显示给你看的字幕里不要,念不了的声音也不要
export const stripSounds = (text) => text.replace(/\((laughs|chuckle|sighs|breath|emm|humming)\)\s*/gi, '').trim();

// ElevenLabs 的几个模型:前两个快,适合打电话;后两个更有感情,但慢一些、贵一些
export const ELEVEN_MODELS = [
  ['eleven_flash_v2_5', '最快'],
  ['eleven_turbo_v2_5', '快'],
  ['eleven_multilingual_v2', '更自然,慢一点'],
  ['eleven_v3', '最有感情,最慢'],
];

// ElevenLabs 现成的声音列表。不填 Key 也能拿到;填了 Key 还会带上你账号里自己收藏的声音
// 每项:{ id, name, gender, accent, sample }。sample 是一段免费试听的网址
export async function elevenVoices(apiKey) {
  let res = await fetch(`${ELEVEN}/voices`, apiKey ? { headers: { 'xi-api-key': apiKey } } : {});
  if (!res.ok && apiKey) res = await fetch(`${ELEVEN}/voices`); // Key 填错了也先把公开的列表拿回来
  const { voices } = await res.json();
  return voices
    .map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      gender: (voice.labels && voice.labels.gender) || '',
      accent: (voice.labels && voice.labels.accent) || '',
      sample: voice.preview_url,
    }))
    .sort((a, b) => (a.gender === 'male' ? 0 : 1) - (b.gender === 'male' ? 0 : 1));
}

// 硅基流动自带的八个音色:[编号, 名字]。说中文还行,说英文口音重
export const VOICES = [
  ['charles', '磁性男声'],
  ['alex', '沉稳男声'],
  ['benjamin', '低沉男声'],
  ['david', '欢快男声'],
  ['anna', '沉稳女声'],
  ['bella', '激情女声'],
  ['claire', '温柔女声'],
  ['diana', '欢快女声'],
];

// 现在生效的语音配置。没单独填语音的 Key,就借用线路里同一家的 Key
export async function voiceConfig() {
  const settings = await loadSettings();
  const config = { ...settings.voice, grok: { ...settings.voice.grok } };
  const keyOf = (base) => (settings.lines.find((line) => line.apiBaseUrl === base && line.apiKey) || {}).apiKey || '';
  if (!config.apiKey) config.apiKey = keyOf(config.apiBaseUrl);
  if (!config.grok.apiKey) config.grok.apiKey = keyOf(GROK);
  return config;
}

// 打电话前检查该填的有没有填,缺什么就说清楚
export function checkVoice(config) {
  if (config.provider === 'grok') {
    // Grok 自己听、自己想、自己说,只要它的 Key
    if (!config.grok.apiKey) throw new Error('还没填 Grok 的 Key。在设置里加一条 Grok 线路,或者在"语音和电话"里填');
    return;
  }
  if (!config.apiKey) throw new Error('还没填硅基流动的 Key(听写你说的话要用)。去设置里的"语音和电话"填上');
  const chosen = { minimax: ['MiniMax', config.minimax], elevenlabs: ['ElevenLabs', config.eleven] }[config.provider];
  if (!chosen) return;
  const [label, account] = chosen;
  if (!account.apiKey) throw new Error(`还没填 ${label} 的 Key。去设置里的"语音和电话"填上`);
  if (!account.voiceId) throw new Error('还没选他的声音。去设置里的"语音和电话"选一个');
}

const endpoint = (config, path) => `${config.apiBaseUrl.replace(/\/$/, '')}/${path}`;

// 把对面报的错翻成一句人话。两家的报错格式不一样,都试着读一下
async function failure(res) {
  if (res.status === 401) return new Error('语音的 API Key 不对');
  const body = await res.text();
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail =
      (parsed.detail && (parsed.detail.message || parsed.detail)) ||
      parsed.message ||
      (parsed.error && parsed.error.message) ||
      body;
  } catch {}
  return new Error(`语音接口报错 ${res.status}:${String(detail).slice(0, 160)}`);
}

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error('连不上语音接口,检查网络');
  }
  if (!res.ok) throw await failure(res);
  return res;
}

// 文字 -> 他的声音。返回一段 mp3 数据
export async function synthesize(config, spoken) {
  const text = supportsSounds(config) ? spoken : stripSounds(spoken);

  if (config.provider === 'minimax') {
    const { apiKey, voiceId, model } = config.minimax;
    if (!apiKey) throw new Error('还没填 MiniMax 的 Key');
    if (!voiceId) throw new Error('还没选声音');
    const res = await request(`${MINIMAX}/t2a_v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
        language_boost: 'auto',
      }),
    });
    // MiniMax 出错时也回"成功",真正的结果写在 base_resp 里;声音是一长串十六进制字符
    const data = await res.json();
    const status = data.base_resp || {};
    if (status.status_code !== 0 || !data.data || !data.data.audio) {
      if (/login fail/i.test(status.status_msg || '')) throw new Error('MiniMax 的 Key 不对');
      throw new Error(`MiniMax 报错:${status.status_msg || '没有返回声音'}`);
    }
    const hex = data.data.audio;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes.buffer;
  }

  if (config.provider === 'grok') {
    if (!config.grok.apiKey) throw new Error('还没填 Grok 的 Key');
    const res = await request(`${GROK}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.grok.apiKey}` },
      body: JSON.stringify({ text, voice_id: config.grok.voice, language: 'en' }),
    });
    return res.arrayBuffer();
  }

  if (config.provider === 'elevenlabs') {
    const { apiKey, voiceId, model } = config.eleven;
    if (!apiKey) throw new Error('还没填 ElevenLabs 的 Key');
    if (!voiceId) throw new Error('还没选声音');
    const res = await request(`${ELEVEN}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({ text, model_id: model }),
    });
    return res.arrayBuffer();
  }

  if (!config.apiKey) throw new Error('还没填硅基流动的 Key');
  // 自带音色要写成"模型名:音色名";自己上传的音色本身就是完整编号
  const voice = config.voice.includes(':') ? config.voice : `${config.ttsModel}:${config.voice}`;
  const res = await request(endpoint(config, 'audio/speech'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.ttsModel,
      input: text,
      voice,
      response_format: 'mp3',
      speed: config.speed,
    }),
  });
  return res.arrayBuffer();
}

// 你说的话(WAV 录音)-> 文字
export async function transcribe(config, wav) {
  const form = new FormData();
  form.append('file', wav, 'speech.wav');
  form.append('model', config.asrModel);
  if (!config.apiKey) throw new Error('还没填硅基流动的 Key');
  const res = await request(endpoint(config, 'audio/transcriptions'), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: form,
  });
  const { text } = await res.json();
  // 有的听写模型会在文字里夹 <|zh|> 这样的标记,去掉
  return (text || '').replace(/<\|[^|]*\|>/g, '').trim();
}

// 放他的声音。一次放一段,play 要等这段放完才结束
export class Player {
  constructor(context) {
    this.context = context;
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.source = null;
  }

  set muted(value) {
    this.gain.gain.value = value ? 0 : 1;
  }

  async play(audio) {
    const buffer = await this.context.decodeAudioData(audio);
    await new Promise((resolve) => {
      this.source = this.context.createBufferSource();
      this.source.buffer = buffer;
      this.source.connect(this.gain);
      this.source.onended = resolve;
      this.source.start();
    });
    this.source = null;
  }

  stop() {
    if (this.source) this.source.stop();
  }
}

// 断句用的几个数。觉得他老是抢话就把 SILENCE_MS 调大,觉得他反应慢就调小
const SPEECH_CHUNKS = 3; // 连着这么多块有声音,才算你开始说话(一块约 0.04 秒)
const SILENCE_MS = 1100; // 你停顿这么久,算一句话说完
const MIN_SPEECH_MS = 300; // 比这还短的声音当成杂音丢掉
const MAX_SPEECH_MS = 30000; // 一句话最长录这么久
const PREROLL_CHUNKS = 8; // 开口前的这一小段也留着,免得第一个字被切掉
const MIN_LEVEL = 0.012; // 比这还小的声音一律算安静

// 听你说话:一直收麦克风的声音,等你说完一句,交出这句的录音
export class Listener {
  constructor(context, stream) {
    this.context = context;
    this.stream = stream;
    this.resolve = null;
    this.noise = 0.005; // 环境底噪,边听边估
    this.isPaused = false;
    this.reset();
  }

  async start() {
    await this.context.audioWorklet.addModule('mic-worklet.js');
    const tap = new AudioWorkletNode(this.context, 'mic-tap');
    tap.port.onmessage = (event) => this.feed(event.data);
    // 接到一个音量为零的出口上:不出声,但浏览器会保持它一直运转
    const silent = this.context.createGain();
    silent.gain.value = 0;
    this.context.createMediaStreamSource(this.stream).connect(tap).connect(silent).connect(this.context.destination);
  }

  reset() {
    this.preroll = [];
    this.speech = [];
    this.loudRun = 0;
    this.voiced = 0;
    this.quiet = 0;
    this.speaking = false;
  }

  // 麦克风关掉时不收音
  set paused(value) {
    this.isPaused = value;
    this.reset();
  }

  // 等你说完一句话。返回这句话的录音;被 cancel 打断时返回 null
  listen() {
    this.reset();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  cancel() {
    this.finish(null);
  }

  finish(result) {
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve) resolve(result);
  }

  feed(chunk) {
    if (!this.resolve || this.isPaused) return;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const level = Math.sqrt(sum / chunk.length);
    const loud = level > Math.max(MIN_LEVEL, this.noise * 3);
    const chunkMs = (chunk.length / this.context.sampleRate) * 1000;

    if (!this.speaking) {
      if (!loud) this.noise = this.noise * 0.95 + level * 0.05;
      this.preroll.push(chunk);
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= SPEECH_CHUNKS) {
        this.speaking = true;
        this.speech = this.preroll;
        this.voiced = this.loudRun;
      }
      return;
    }

    this.speech.push(chunk);
    if (loud) {
      this.voiced++;
      this.quiet = 0;
    } else {
      this.quiet++;
    }
    const done = this.quiet * chunkMs >= SILENCE_MS || this.speech.length * chunkMs >= MAX_SPEECH_MS;
    if (!done) return;
    if (this.voiced * chunkMs < MIN_SPEECH_MS) return this.reset();
    this.finish(encodeWav(this.speech, this.context.sampleRate));
  }
}

// 降采样:把麦克风的声音(一般是 48000Hz)换成接口要的采样率。原来的几个采样点取平均,合成一个
export function resample(input, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    output[i] = sum / (to - from);
  }
  return output;
}

// 浮点声音 -> 16 位整数声音,接口一般收这种
export function toPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
  return pcm;
}

// 把收到的声音打包成 16000Hz 单声道的 WAV 文件,听写接口都认这个格式
export function encodeWav(chunks, fromRate) {
  const RATE = 16000;
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const input = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }

  const pcm = toPcm16(resample(input, fromRate, RATE));
  const samples = pcm.length;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([view], { type: 'audio/wav' });
}
