// Grok 实时通话:你的声音一边说一边传给 Grok,他的声音一边生成一边传回来
// 和另外几家的对讲式不同,这里你随时可以开口打断他,他会停下来听你说
// 建议戴耳机:外放的话,他的声音可能被麦克风收进去,他会以为你在说话
import { GROK, resample, toPcm16 } from './voice.js';

const MODEL = 'grok-voice-latest';
const RATE = 24000; // 来回的声音都用 24000Hz 的 16 位 PCM,这是 Grok 的默认格式

function toBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export class GrokCall {
  // events 是通话页给的几个回调:
  //   status(text)   状态那一行显示什么
  //   heard(text)    听清了你说的一句话
  //   said(text)     他说完了一句话(英文原话)
  //   failed(text)   通话出了问题
  constructor({ apiKey, voice, instructions, opening, context, stream, events }) {
    Object.assign(this, { apiKey, voice, instructions, opening, context, stream, events });
    this.active = false;
    this.micOn = true;
    this.saying = ''; // 他正在说的这句话,一边说一边拼
    this.playhead = 0; // 他已经排好、要放到的时间点
    this.sources = new Set();
    this.gain = context.createGain();
    this.gain.connect(context.destination);
  }

  set muted(value) {
    this.gain.gain.value = value ? 0 : 1;
  }

  async start() {
    // 1. 用你的 Key 换一张 5 分钟有效的临时通行证。网页连通话服务时没法带 Key,只能带这个
    let res;
    try {
      res = await fetch(`${GROK}/realtime/client_secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ expires_after: { seconds: 300 } }),
      });
    } catch {
      throw new Error('连不上 Grok,检查网络');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Grok 的 Key 不对');
    if (!res.ok) throw new Error(`Grok 报错 ${res.status}:${(await res.text()).slice(0, 120)}`);
    const { value } = await res.json();

    // 2. 接通
    this.ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${MODEL}`, [`xai-client-secret.${value}`]);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('连不上 Grok 的通话服务'));
    });
    this.active = true;
    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') this.handle(JSON.parse(event.data));
    };
    this.ws.onclose = () => {
      if (this.active) this.events.failed('通话断了');
      this.active = false;
    };

    // 3. 告诉他是谁、用什么声音、声音是什么格式。turn_detection 让 Grok 自己判断你什么时候说完
    this.send({
      type: 'session.update',
      session: {
        voice: this.voice,
        instructions: this.instructions,
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: RATE } },
          output: { format: { type: 'audio/pcm', rate: RATE } },
        },
      },
    });

    // 4. 打开麦克风,收到的声音一小块一小块地传过去
    await this.context.audioWorklet.addModule('mic-worklet.js');
    const tap = new AudioWorkletNode(this.context, 'mic-tap');
    tap.port.onmessage = (event) => this.listen(event.data);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    this.context.createMediaStreamSource(this.stream).connect(tap).connect(silent).connect(this.context.destination);

    // 5. 让他先开口
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: this.opening }] },
    });
    this.send({ type: 'response.create' });
    this.events.status('接通中…');
  }

  // 中途换一套说明(比如你说了安全词):他马上停下正在说的,按新说明接着说
  redirect(instructions, cue) {
    this.hush();
    this.send({ type: 'response.cancel' });
    this.send({ type: 'session.update', session: { instructions } });
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: cue }] },
    });
    this.send({ type: 'response.create' });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  listen(chunk) {
    if (!this.active || !this.micOn) return;
    const pcm = toPcm16(resample(chunk, this.context.sampleRate, RATE));
    this.send({ type: 'input_audio_buffer.append', audio: toBase64(pcm) });
  }

  // 他的声音一段段地来,排着队接在上一段后面放
  play(base64) {
    const pcm = fromBase64(base64);
    const buffer = this.context.createBuffer(1, pcm.length, RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const at = Math.max(this.context.currentTime, this.playhead);
    source.start(at);
    this.playhead = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  // 你一开口,他排好还没放完的声音全部停掉
  hush() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.playhead = 0;
  }

  // 他说完、声音也放完之后,状态才变回"在听你说"
  whenQuiet() {
    const left = Math.max(0, this.playhead - this.context.currentTime);
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      if (this.active && !this.sources.size) this.events.status('在听你说…');
    }, left * 1000 + 100);
  }

  handle(event) {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.hush();
        this.events.status('在听你说…');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.events.status('他在想…');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript && event.transcript.trim()) this.events.heard(event.transcript.trim());
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.events.status('他在说话');
        this.play(event.delta);
        break;
      case 'response.output_audio_transcript.delta':
        this.saying += event.delta || '';
        break;
      case 'response.output_audio_transcript.done': {
        const text = (event.transcript || this.saying).trim();
        this.saying = '';
        if (text) this.events.said(text);
        break;
      }
      case 'response.done':
        this.whenQuiet();
        break;
      case 'error':
        this.events.status(`Grok 报错:${(event.error && event.error.message) || '未知错误'}`);
        break;
    }
  }

  stop() {
    this.active = false;
    clearTimeout(this.quietTimer);
    this.hush();
    if (this.ws) this.ws.close();
  }
}
