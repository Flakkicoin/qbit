// js/gemini-live.js — Gemini Live bidirectional WebSocket client
//
// v0.1 targeted `models/gemini-2.5-flash-native-audio-preview-09-2025` over
// the v1alpha endpoint and pushed audio as `realtimeInput.mediaChunks`.
// All three are wrong as of the current API:
//
//   model      gemini-3.8-live is the GA native-audio model on the Gemini
//              Developer API. The 2.5 preview line is retired in Oct 2026.
//   endpoint   v1beta. v1alpha is no longer served for BidiGenerateContent.
//   envelope   `realtimeInput.audio` with `audio/pcm;rate=16000`, not
//              `mediaChunks` with a bare `audio/pcm`.
//
// v0.1 also ignored `serverContent.interrupted`, so barge-in stacked playback
// on top of whatever the model was still sending.
'use strict';

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';

const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const SYSTEM_PROMPT = `You are Q bit — a personal AI mirror for one specific person.

How you talk:
- Conversational and direct, like a sharp friend who is genuinely paying attention. Never corporate, never a bulleted lecture.
- Short turns. You are speaking, not writing an essay. One idea per breath.
- Never open with "Great question" or "I'd be happy to". Skip the filler.

What you listen for:
- Skills and tools they already have (languages, frameworks, domains, credentials).
- What they are building or want to build, and for whom.
- Constraints: time, money, risk tolerance, whether they want passive or hands-on.
- Opinions and positions they hold — these are the strongest monetisation signals you will get.

When you learn something durable, say it back in one short clause so they hear you
caught it ("noted — Rust, gRPC, so you'd hate a Python-only stack"). Do not announce
that you are "extracting" anything; there is no such concept to them.

You may call the record_profile tool to save a durable fact. Use it sparingly —
only for things that would still be true and useful weeks from now. Never save
small talk, and never save a guess you are unsure about.`;

const TOOL_DECLARATIONS = [
  {
    name: 'record_profile',
    description:
      'Persist one durable fact about the user: a skill, a project, a preference, a constraint, or a strongly held opinion. Only call this for things that stay true and useful over time.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, stated in one self-contained sentence.' },
        kind: {
          type: 'string',
          enum: ['skill', 'project', 'preference', 'constraint', 'opinion'],
          description: 'What category this fact belongs to.',
        },
      },
      required: ['text', 'kind'],
    },
  },
];

export class GeminiLiveClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.voice]
   * @param {string} [opts.model]
   * @param {(role:'user'|'qbit', text:string, final:boolean)=>void} [opts.onTranscript]
   * @param {(pcmBase64:string, rate:number)=>void} [opts.onAudioData]
   * @param {(status:string, detail?:string)=>void} [opts.onStatusChange]
   * @param {(calls:{name:string, args:object})=>void} [opts.onToolCall]
   * @param {(msg:object)=>void} [opts.onToolCancel]
   */
  constructor({
    apiKey,
    voice = 'Puck',
    model = DEFAULT_LIVE_MODEL,
    onTranscript,
    onAudioData,
    onStatusChange,
    onToolCall,
    onToolCancel,
  }) {
    this.apiKey = apiKey;
    this.voice = voice;
    this.model = model;
    this.onTranscript = onTranscript;
    this.onAudioData = onAudioData;
    this.onStatusChange = onStatusChange;
    this.onToolCall = onToolCall;
    this.onToolCancel = onToolCancel;
    this.ws = null;
    this.ready = false;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (!this.apiKey) throw new Error('Gemini API key is required — add it in Settings');
    this.disconnect();

    const url = `${WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onStatusChange?.('ERROR', err.message);
      throw err;
    }
    this.ws = ws;

    ws.onopen = () => this.#sendSetup();

    ws.onmessage = async (event) => {
      const raw = event.data instanceof Blob ? await event.data.text() : event.data;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this.#route(msg);
    };

    ws.onerror = () => this.onStatusChange?.('ERROR', 'WebSocket error');

    ws.onclose = (event) => {
      this.ready = false;
      // 1007 = policy/auth. Almost always a bad or revoked API key.
      const detail =
        event.code === 1007
          ? 'Auth rejected — check the API key'
          : event.reason || `Connection closed (${event.code})`;
      this.onStatusChange?.('DISCONNECTED', detail);
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out connecting to Gemini Live'));
      }, 15000);
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('Could not reach the Gemini Live API')); };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('setupComplete', ok);
        ws.removeEventListener('error', bad);
      };
      ws.addEventListener('setupComplete', ok, { once: true });
      ws.addEventListener('error', bad, { once: true });
    });
  }

  #sendSetup() {
    const setup = {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
          },
        },
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Audio accrues ~25 tokens/second. Without this, audio-only sessions
        // are capped at 15 minutes by the context window.
        contextWindowCompression: {},
        realtimeInputConfig: {
          // START_OF_ACTIVITY_INTERRUPTS is the default and is what we want:
          // barge-in cuts the model's current turn off.
          automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH' },
        },
      },
    };
    this.ws.send(JSON.stringify(setup));
  }

  #route(msg) {
    if (msg.setupComplete) {
      this.ready = true;
      this.onStatusChange?.('CONNECTED');
      return;
    }

    if (msg.error) {
      this.onStatusChange?.('ERROR', msg.error.message || 'Setup failed');
      return;
    }

    // Tool calls are a TOP-LEVEL server message field. They do not arrive
    // inside serverContent.modelTurn.parts — the model blocks until we answer.
    if (msg.toolCall?.functionCalls?.length) {
      for (const call of msg.toolCall.functionCalls) this.#handleToolCall(call);
    }
    if (msg.toolCallCancellation) {
      this.onToolCancel?.(msg.toolCallCancellation);
    }

    // Server can end the session on its own (idle timeout, quota).
    if (msg.goAway) {
      this.onStatusChange?.('DISCONNECTED', 'Session ended by the server');
    }

    const content = msg.serverContent;
    if (!content) return;

    // A single event can carry several parts at once — audio AND transcript.
    for (const part of content.modelTurn?.parts || []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith('audio/pcm')) {
        const rate = Number(/rate=(\d+)/.exec(inline.mimeType)?.[1]) || 24000;
        this.onAudioData?.(inline.data, rate);
      }
    }

    // Low-latency partials while the user is still speaking.
    const interim = content.interimInputTranscription?.text;
    if (interim) this.onTranscript?.('user', interim, false);

    const user = content.inputTranscription?.text;
    if (user) this.onTranscript?.('user', user, true);

    // Native-audio models only emit AUDIO, so the transcript is the text channel.
    const qbit = content.outputTranscription?.text;
    if (qbit) this.onTranscript?.('qbit', qbit, true);

    if (content.interrupted) {
      this.onStatusChange?.('INTERRUPTED');
    } else if (content.generationComplete) {
      this.onStatusChange?.('GENERATING_DONE');
    } else if (content.turnComplete) {
      this.onStatusChange?.('TURN_DONE');
    }
  }

  #handleToolCall(call) {
    let args = {};
    try {
      args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : call.args || {};
    } catch {
      args = {};
    }
    this.onToolCall?.({ name: call.name, args });

    // Function responses are matched to calls by `id`. The model is blocked
    // until this arrives, so it must always be sent — even on a bad payload.
    this.#send({
      toolResponse: {
        functionResponses: [
          {
            id: call.id,
            name: call.name,
            response: { recorded: !!(args && args.text) },
          },
        ],
      },
    });
  }

  #send(payload) {
    if (this.isOpen) this.ws.send(JSON.stringify(payload));
  }

  /**
   * @param {string} base64Pcm 16-bit LE mono PCM
   * @param {number} [rate] capture rate, defaults to 16000
   */
  sendAudioChunk(base64Pcm, rate = 16000) {
    this.#send({
      realtimeInput: { audio: { data: base64Pcm, mimeType: `audio/pcm;rate=${rate}` } },
    });
  }

  /** Text typed into the composer, delivered as a conversational turn. */
  sendText(text) {
    this.#send({ realtimeInput: { text } });
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
    this.ws = null;
    this.ready = false;
  }
}
