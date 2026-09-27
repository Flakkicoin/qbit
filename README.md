# Q bit — Personal AI Mirror

A browser-first personal AI companion. It listens to you over a live
bidirectional audio stream, learns your skills, projects and opinions, and
turns them into concrete monetisation playbooks.

Zero npm dependencies. Node 18+ for the local sync server; the frontend also
runs fine as pure static files.

```
node server.js
# → http://127.0.0.1:3000
```

Chrome or Edge. Those are the only browsers with microphone capture on
`localhost` working reliably plus AudioWorklet support (there is a
ScriptProcessor fallback for others, but don't count on it).

---

## What it does

| | |
|---|---|
| **Live conversation** | Gemini Live bidirectional WebSocket. Hold the mic, talk, get audio back. Barge-in works. |
| **Reflection** | The model calls a `record_profile` tool to save durable facts — skills, projects, constraints, stated opinions. |
| **Playbooks** | Gemini 3.1 Pro reads your profile and returns 6 tiered plays: 3 quick, 2 build, 1 moonshot. |
| **Sync** | A 16-character recovery code, hashed server-side, moves your profile between browsers. |

---

## ⚠️ Before you use it

**`gemini-3.1-pro-preview` has no free tier on the Gemini API.** Playbook
generation will fail with a billing error until you enable billing on your
Google AI project. The live conversation works on the free tier. This is
surfaced in the UI rather than swallowed — swap the thinking model in Settings
if you want something else.

Your API key lives in `localStorage`. It goes to Google and nowhere else. On a
shared machine that's still readable by anything with access to the browser
profile — treat the machine as the trust boundary.

The sync store is a plaintext JSON file on disk, keyed by SHA-256 hash. It
binds to `127.0.0.1` by default. If you set `HOST=0.0.0.0` you are putting
personal data on the network — don't, unless you know why.

---

## Models

| Slot | Model | Endpoint |
|---|---|---|
| Voice | `gemini-3.8-live` | `v1beta` BidiGenerateContent (WebSocket) |
| Playbooks | `gemini-3.1-pro-preview` | `v1beta` `:generateContent` (REST) |

Both are overridable in Settings. The voice model must support the Live API —
not every Gemini model does.

---

## Fixes in v0.2

v0.1 shipped a bundle that could not run. What was actually wrong:

**The app never started.**
`js/app.js` imported `./recommendations.js`, which was not in the bundle. The
static server answered missing files with `index.html` and a `200`, so the
browser rejected the import as an unsupported MIME type and took the whole
module graph down — blank screen, no actionable error. `js/recommendations.js`
now exists, and the server returns a real `404` for anything with a file
extension.

**Sync could never restore.**
The client stripped dashes from the recovery code before `GET /api/profile/`,
but the server hashed the raw dashed code on `POST /api/sync`. Writes and reads
used different keys, so every restore 404'd. Both sides now normalise through
the same rule before hashing.

**The API calls were aimed at a retired surface.**
- `gemini-2.5-flash-native-audio-preview-09-2025` — the 2.5 line retires October 2026
- `v1alpha` — no longer served for `BidiGenerateContent`
- `realtimeInput.mediaChunks` — the envelope is now `realtimeInput.audio` with `audio/pcm;rate=16000`

**The audio was wrong in a way that broke conversation.**
One `AudioContext` at 24 kHz was capturing and shipping the result labelled as
16 kHz PCM — the model heard slowed, pitch-dropped speech. Capture now runs in
its own 16 kHz context, playback in its own 24 kHz one. Capture is also muted
into a zero-gain sink: v0.1 wired it to `destination`, which is a microphone
feedback loop through your speakers. Capture moved to an `AudioWorklet`
(`js/pcm-worklet.js`) with a ScriptProcessor fallback.

**Barge-in stacked audio.**
`serverContent.interrupted` was ignored, so replies played on top of each other
after you interrupted. Now handled — the queue is flushed.

**Stored XSS.**
Profile facts and playbook cards were interpolated into `innerHTML`. Every
rendering path now builds nodes and sets `textContent`.

**The server had a weak traversal guard and lost writes.**
`filePath.startsWith(__dirname)` is a prefix check — it doesn't catch sibling
directories and is defeated by a trailing separator. Replaced with
`path.relative`. Profile writes are now serialised through a promise chain;
concurrent read-modify-write cycles previously dropped all but the last write.
`server.js`, `package.json` and `data/` are no longer served over HTTP.

**You were shown a stranger's life story.**
v0.1 shipped a hard-coded default profile — *"author of open-source Rust crates
with over 45k monthly downloads"*, *"targets Series B+ startups"*. It rendered
as your own learned facts. The profile now starts empty. `extractKnowledge()`
also no longer exists: it appended every raw utterance to the facts list, so
the panel was a chat log wearing a label.

**Accessiblity / input.** Push-to-talk is on `pointerdown`/`pointerup` (mouse,
pen and touch) with keyboard support, not `mousedown`/`mouseup`.

---

## Live API notes

Things that are easy to get wrong and are pinned by `tools/protocol-test.mjs`:

- **Tool calls are a top-level server message field.** They arrive as
  `{"toolCall": {"functionCalls": [...]}}` — *not* as a `functionCall` part
  inside `serverContent.modelTurn.parts`. The model blocks until you reply with
  a `toolResponse` keyed by the call `id`, so a missed tool call freezes the
  conversation, not just the tool.
- **Context window compression is not optional in practice.** Audio accrues ~25
  tokens/second; without `contextWindowCompression` an audio-only session is
  capped at ~15 minutes.
- **Barge-in is a server signal.** `serverContent.interrupted: true` means drop
  the client playback buffer immediately, or the agent talks over the user.
- **Chunk size for conversation is 20–40 ms**, not the 100 ms figure in the
  transcription docs. The worklet sends 512 frames at 16 kHz = 32 ms.
- **Live models only emit AUDIO.** There is no text modality to fall back on —
  the transcript from `outputAudioTranscription` *is* the text channel.
- **Enabling transcription costs extra.** Both transcription fields bill text
  tokens at the text output rate on top of the audio tokens.

---

## Layout

```
index.html            shell
styles.css            Quantum Reflection design system (DESIGN.md tokens)
server.js             static server + REST sync API, no dependencies
js/
  app.js              coordinator, all DOM rendering
  gemini-live.js      Live WebSocket client
  recommendations.js  Pro playbook generation
  audio.js            16 kHz capture / 24 kHz playback
  pcm-worklet.js      float → PCM16 on the audio thread
  profile.js          reflection store
  cloud.js            recovery codes + sync
tools/
  protocol-test.mjs   27 assertions against a mock Live socket
assets/
  qbit-mark.png       Q glyph, transparent
  qbit-logo.png       full lockup
  favicon.png
data/profiles.json    created at runtime, gitignored
```

`npm test` runs the protocol suite with no dependencies. It asserts the setup
message shape, the client→server audio and text envelopes, the server→client
transcription and barge-in routing, tool-call round trips and error handling
against a mock WebSocket. It is the reason the `toolCall` bug below was caught
rather than shipped.

---

## API

| Route | |
|---|---|
| `GET /api/health` | liveness |
| `POST /api/sync` | `{ code, profile }` — upsert |
| `GET /api/profile/:code` | retrieve |

Codes are Crockford Base32 (`0-9 A-H J K M N P-T V-Z` — no `I`, `L`, `O`, `U`),
normalised on both sides, then SHA-256'd before storage. The server never holds
the plaintext code, which also means it cannot reset it for you.

---

## Deploy

**Static only** (no sync — everything stays in the browser's localStorage):
Netlify, Cloudflare Pages, GitHub Pages, any static host. The `/api/*` routes
will 404, and the sync button will say so.

**With sync**, the store is an in-process file, so it only works on a host with
a persistent writable filesystem:

```bash
# Vercel — ephemeral FS, sync is effectively broken across cold starts
npx vercel --prod

# Docker / any VM with a disk
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data qbit
```

---

## Design

`DESIGN.md` is the source of truth for the visual system — Quantum Reflection:
OLED-black void, glassmorphism panels, quantum cyan `#00F2FE`, electric violet
`7F00FF`, neon emerald `#00F5A0`, Outfit / Inter / JetBrains Mono, 4px baseline.

The logo in `assets/` is derived from the supplied artwork: black plate removed
via a luminance-to-alpha ramp so the filaments keep their colour, `Q` cropped
for the mark and favicon, full lockup for the hero.
