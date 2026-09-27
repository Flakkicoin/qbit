// tools/protocol-test.mjs — drives GeminiLiveClient against a mock socket
// and asserts it speaks the current Live API protocol. Run: node tools/protocol-test.mjs
//
// The app's js/*.js are ES modules for the browser, but package.json declares
// "type": "commonjs" so server.js can use require(). Node would therefore
// refuse to import them by path, so we load the source directly as a module.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'js', 'gemini-live.js'), 'utf8');
const { GeminiLiveClient } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
);

const OPEN = 1;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** Minimal WebSocket stand-in that records what the client sends. */
class MockWS {
  static OPEN = OPEN;
  static last = null;
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; MockWS.last = this; }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  addEventListener() {}
  removeEventListener() {}
  // test helpers
  emit(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  open() { this.readyState = 1; this.onopen?.(); }
  get toolResponses() { return this.sent.filter((m) => m.toolResponse).map((m) => m.toolResponse); }
}

globalThis.WebSocket = MockWS;

const events = [];
const client = new GeminiLiveClient({
  apiKey: 'TESTKEY',
  voice: 'Puck',
  onTranscript: (role, text, final) => events.push(['transcript', role, text, final]),
  onAudioData: (pcm, rate) => events.push(['audio', rate, pcm.length]),
  onStatusChange: (s, d) => events.push(['status', s, d]),
  onToolCall: (c) => events.push(['tool', c.name, c.args]),
});

console.log('=== connection ===');
client.connect();
const ws = MockWS.last;
ws.open();

ok('endpoint is v1beta, not v1alpha', ws.url.includes('v1beta') && !ws.url.includes('v1alpha'), ws.url);
ok('api key is url-encoded into the ws url', ws.url.includes('key=TESTKEY'));

const setup = ws.sent[0].setup;
ok('first message is setup', !!setup);
ok('model is a current Live model', /^models\/gemini-3\.[\w.-]+$/.test(setup.model), setup.model);
ok('AUDIO modality requested', setup.generationConfig?.responseModalities?.includes('AUDIO'));
ok('voice set via speechConfig', setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName === 'Puck');
ok('inputAudioTranscription enabled', !!setup.inputAudioTranscription);
ok('outputAudioTranscription enabled', !!setup.outputAudioTranscription);
ok('tools declared', Array.isArray(setup.tools?.[0]?.functionDeclarations));
ok('contextWindowCompression set (15 min cap otherwise)', !!setup.contextWindowCompression);

console.log('=== server routing ===');
ws.emit({ setupComplete: {} });
ok('CONNECTED fires on setupComplete', events.some((e) => e[0] === 'status' && e[1] === 'CONNECTED'));

ws.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] } } });
ok('24 kHz audio in -> 24 kHz audio out', events.some((e) => e[0] === 'audio' && e[1] === 24000));

ws.emit({ serverContent: { interimInputTranscription: { text: 'I build rus' } } });
ws.emit({ serverContent: { inputTranscription: { text: 'I build rust CLIs' } } });
const t = events.filter((e) => e[0] === 'transcript');
ok('interim transcript marked non-final', t.some((e) => e[3] === false));
ok('final transcript marked final', t.some((e) => e[3] === true));

ws.emit({ serverContent: { outputTranscription: { text: 'Noted.' } } });
ok('output transcript routed as qbit', events.some((e) => e[0] === 'transcript' && e[1] === 'qbit'));

ws.emit({ serverContent: { interrupted: true } });
ok('interrupted surfaces for barge-in', events.some((e) => e[0] === 'status' && e[1] === 'INTERRUPTED'));

ws.emit({ serverContent: { generationComplete: true } });
ws.emit({ serverContent: { turnComplete: true } });
ok('turn lifecycle surfaced', events.some((e) => e[1] === 'GENERATING_DONE') && events.some((e) => e[1] === 'TURN_DONE'));

console.log('=== tool calls (the v0.2 bug) ===');
// Top-level toolCall. This is how the server actually sends it.
ws.emit({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'record_profile', args: { text: 'Ships Rust CLIs', kind: 'skill' } }] } });
const toolEv = events.find((e) => e[0] === 'tool');
ok('top-level toolCall is handled', !!toolEv, 'client ignored it');
ok('tool args parsed from JSON string', toolEv?.[2]?.text === 'Ships Rust CLIs');
ok('toolResponse sent back, keyed by call id', ws.toolResponses[0]?.functionResponses?.[0]?.id === 'fc-1');
ok('toolResponse uses the toolResponse envelope', !!ws.sent.at(-1).toolResponse);

ws.emit({ toolCall: { functionCalls: [{ id: 'fc-2', name: 'record_profile', args: 'not-json' }] } });
ok('malformed args still get a response (model stays unblocked)', ws.toolResponses.length === 2);

console.log('=== client → server audio ===');
client.sendAudioChunk('AAAA', 16000);
const last = ws.sent.at(-1);
ok('audio uses realtimeInput.audio (not mediaChunks)', !!last.realtimeInput?.audio && !last.realtimeInput?.mediaChunks);
ok('mimeType declares the sample rate', last.realtimeInput.audio.mimeType === 'audio/pcm;rate=16000');
client.sendText('hello');
ok('text uses realtimeInput.text', ws.sent.at(-1).realtimeInput?.text === 'hello');

console.log('=== resilience ===');
ws.emit({ error: { message: 'API key not valid' } });
ok('error message surfaced', events.some((e) => e[0] === 'status' && e[1] === 'ERROR'));
ws.emit({ goAway: {} });
ok('goAway surfaced as disconnect', events.some((e) => e[1] === 'DISCONNECTED' && String(e[2]).includes('server')));

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
