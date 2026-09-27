// js/audio.js — capture at 16 kHz, playback at 24 kHz
//
// v0.1 created ONE AudioContext at 24 kHz, captured from it, and shipped the
// result labelled `audio/pcm` (16 kHz on the wire). The model's VAD heard a
// slowed-down, pitch-dropped voice. It also wired the capture node straight to
// `destination`, which plays the mic through your speakers — instant feedback.
//
// Fix: two contexts. The browser resamples the mic down to 16 kHz for us on
// capture; the model's 24 kHz output gets its own context so it plays at the
// right pitch. Capture is muted with a zero-gain sink instead of reaching
// destination.
'use strict';

const CAPTURE_RATE = 16000; // Gemini Live input spec
const PLAYBACK_RATE = 24000; // Gemini Live output spec
const WORKLET_CHUNK = 512; // 32 ms at 16 kHz — inside the recommended 20–40 ms

/** base64 without blowing the argument limit on 1k+ element arrays. */
function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export class AudioManager {
  constructor() {
    this.captureCtx = null;
    this.playbackCtx = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.scriptNode = null;
    this.sink = null;
    this.playing = new Set();
    this.capturing = false;
  }

  get isCapturing() {
    return this.capturing;
  }

  // ── Capture ──────────────────────────────────────────────────────
  async startCapture(onChunk) {
    if (this.capturing) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not available in this browser');

    if (!this.captureCtx) this.captureCtx = new Ctx({ sampleRate: CAPTURE_RATE });
    if (this.captureCtx.state === 'suspended') await this.captureCtx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.source = this.captureCtx.createMediaStreamSource(this.stream);

    // Keeps the graph pulling without routing mic audio to the speakers.
    this.sink = this.captureCtx.createGain();
    this.sink.gain.value = 0;

    const emit = (int16) => onChunk(toBase64(int16), CAPTURE_RATE);

    try {
      await this.captureCtx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      this.worklet = new AudioWorkletNode(this.captureCtx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      this.worklet.port.onmessage = (e) => emit(e.data);
      this.source.connect(this.worklet);
      this.worklet.connect(this.sink);
    } catch {
      // Safari/Firefox without worklet support: ScriptProcessor still works,
      // it just runs on the main thread.
      this.#startScriptProcessorFallback(emit);
    }

    this.sink.connect(this.captureCtx.destination);
    this.capturing = true;
  }

  #startScriptProcessorFallback(emit) {
    const size = WORKLET_CHUNK;
    this.scriptNode = this.captureCtx.createScriptProcessor(size, 1, 1);
    this.scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i];
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      emit(out);
    };
    this.source.connect(this.scriptNode);
    this.scriptNode.connect(this.sink);
  }

  stopCapture() {
    this.capturing = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.source?.disconnect();
      this.worklet?.disconnect();
      if (this.scriptNode) {
        this.scriptNode.onaudioprocess = null;
        this.scriptNode.disconnect();
        this.scriptNode = null;
      }
      this.sink?.disconnect();
    } catch {
      /* graph already torn down */
    }
    this.source = null;
    this.worklet = null;
    this.sink = null;
  }

  // ── Playback ─────────────────────────────────────────────────────
  async #ensurePlayback() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!this.playbackCtx) this.playbackCtx = new Ctx({ sampleRate: PLAYBACK_RATE });
    if (this.playbackCtx.state === 'suspended') await this.playbackCtx.resume();
    return this.playbackCtx;
  }

  /**
   * @param {string} pcmBase64
   * @param {number} [rate] the rate carried in the inlineData mimeType
   */
  async playChunk(pcmBase64, rate = PLAYBACK_RATE) {
    const ctx = await this.#ensurePlayback();
    const binary = atob(pcmBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, rate);
    buffer.copyToChannel(float32, 0);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.onended = () => this.playing.delete(node);
    this.playing.add(node);
    node.start();
  }

  /**
   * Barge-in. The model flags `serverContent.interrupted` when the user
   * talks over it — everything still queued belongs to a turn nobody is
   * listening to, so drop it. v0.1 never did this and replies overlapped.
   */
  stopPlayback() {
    for (const node of this.playing) {
      try {
        node.onended = null;
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playing.clear();
  }

  async dispose() {
    this.stopCapture();
    this.stopPlayback();
    await this.captureCtx?.close().catch(() => {});
    await this.playbackCtx?.close().catch(() => {});
    this.captureCtx = null;
    this.playbackCtx = null;
  }
}

export { CAPTURE_RATE, PLAYBACK_RATE };
