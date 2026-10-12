// 在浏览器的音频线程里跑:把麦克风的声音攒成一小块一小块,交给 voice.js 去判断你有没有在说话
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.block[this.filled++] = input[i];
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-tap', MicTap);
