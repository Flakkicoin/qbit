// js/pcm-worklet.js — AudioWorklet that converts mic float samples to
// 16-bit little-endian PCM and posts them to the main thread.
//
// Runs on the audio thread, so no allocation churn beyond the transfer buffer.
// Loaded via `new URL('./pcm-worklet.js', import.meta.url)`.
'use strict';

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 512 frames at 16 kHz = 32 ms, inside the 20–40 ms window the Live API
    // best-practices doc recommends. Bigger buffers add turn latency; the
    // chunk-size figures elsewhere in the docs (1024–2048) are for the
    // transcription endpoint, not live conversation.
    this._buffer = new Int16Array(512);
    this._offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp then scale — NaN or out-of-range samples would wrap on cast.
      const s = channel[i] < -1 ? -1 : channel[i] > 1 ? 1 : channel[i];
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset === this._buffer.length) {
        // Copy out: the buffer is reused next round.
        this.port.postMessage(this._buffer.slice(0));
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
