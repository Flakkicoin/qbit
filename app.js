// js/app.js — application coordinator
//
// v0.1 rendered profile facts and playbook cards through innerHTML with
// model-supplied strings interpolated into template literals — a stored-XSS
// hole, and also the thing that broke when the template literals got mangled
// in export (the chips and facts rendered as bare text with no markup).
// Everything below builds nodes and sets textContent.
'use strict';

import { GeminiLiveClient, DEFAULT_LIVE_MODEL } from './gemini-live.js';
import { AudioManager } from './audio.js';
import { ProfileStore } from './profile.js';
import { generateRecoveryCode, syncToCloud, loadFromCloud, formatCode, isValidCode } from './cloud.js';
import { generateRecommendations, DEFAULT_PRO_MODEL } from './recommendations.js';

const KEY_API = 'qbit_api_key';
const KEY_VOICE = 'qbit_voice';
const KEY_LIVE_MODEL = 'qbit_live_model';
const KEY_PRO_MODEL = 'qbit_pro_model';
const KEY_CODE = 'qbit_recovery_code';

// Native-audio Live models accept the full prebuilt voice list.
const VOICES = [
  'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Autonoe',
  'Callirrhoe', 'Despina', 'Enceladus', 'Erinome', 'Gacrux', 'Iapetus',
  'Laomedeia', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager',
  'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zubenelgenubi',
];

const $ = (id) => document.getElementById(id);

/** Build an element with class, text and children. No innerHTML anywhere. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

class QBitApp {
  constructor() {
    this.profile = new ProfileStore();
    this.audio = new AudioManager();
    this.live = null;

    this.isListening = false;
    this.handsFree = false;
    this.busy = false;
    this.recs = [];
    this.tier = 'all';
    this.pendingInterim = null;

    this.#cacheDom();
    this.#bind();
    this.#hydrateSettings();
    this.profile.startSession();
    this.#renderProfile();
    this.#setStatus('idle', this.#apiKey() ? 'Idle' : 'No API key');
  }

  // ── Setup ────────────────────────────────────────────────────────
  #cacheDom() {
    this.dom = {
      mic: $('mic-btn'), push: $('push-btn'), hintSettings: $('hint-settings'),
      transcript: $('transcript'), input: $('text-input'), send: $('send-btn'),
      dot: $('conn-dot'), statusText: $('conn-text'), turn: $('turn-label'),

      statFacts: $('stat-facts'), statSkills: $('stat-skills'), statSessions: $('stat-sessions'),
      skills: $('skills-list'), skillsEmpty: $('skills-empty'),
      facts: $('facts-list'), factsEmpty: $('facts-empty'),
      clear: $('clear-profile'),

      gen: $('generate-recs'), recs: $('rec-content'),
      tabs: Array.from(document.querySelectorAll('.tab')),

      settings: $('settings-modal'), settingsBtn: $('settings-btn'),
      settingsClose: $('settings-close'), settingsCancel: $('settings-cancel'), settingsSave: $('settings-save'),
      apiKey: $('api-key'), voice: $('voice-select'), model: $('model-input'), proModel: $('pro-model-input'),

      sync: $('sync-modal'), syncOpen: $('sync-open'), syncClose: $('sync-close'),
      syncSave: $('sync-save'), syncLoad: $('sync-load'), syncStatus: $('sync-status'),
      code: $('recovery-code'), codeRoll: $('code-roll'), restore: $('restore-code'),

      toast: $('toast'),
    };
  }

  #bind() {
    // Push to talk — pointer events cover mouse, pen and touch, which
    // v0.1's mousedown/mouseup pair did not.
    const down = (e) => { e.preventDefault(); this.#startListening(); };
    const up = () => { if (!this.handsFree) this.#stopListening(); };
    this.dom.mic.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    this.dom.mic.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.#startListening(); }
    });
    this.dom.mic.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); up(); }
    });

    this.dom.push.addEventListener('click', () => {
      this.handsFree = !this.handsFree;
      this.dom.push.classList.toggle('is-active', this.handsFree);
      this.dom.push.setAttribute('aria-pressed', String(this.handsFree));
      this.handsFree ? this.#startListening() : this.#stopListening();
    });

    this.dom.send.addEventListener('click', () => this.#sendTyped());
    this.dom.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.#sendTyped(); }
    });

    this.dom.clear.addEventListener('click', () => {
      if (!confirm('Delete everything Q bit has learned about you? This cannot be undone.')) return;
      this.profile.clear();
      this.#renderProfile();
      this.#toast('Reflection cleared');
    });

    this.dom.gen.addEventListener('click', () => this.#generate());

    for (const tab of this.dom.tabs) {
      tab.addEventListener('click', () => {
        this.tier = tab.dataset.tier;
        for (const t of this.dom.tabs) {
          const on = t === tab;
          t.classList.toggle('is-active', on);
          t.setAttribute('aria-selected', String(on));
        }
        this.#renderRecs();
      });
    }

    // Modals
    const openModal = (m) => { m.hidden = false; };
    const closeModal = (m) => { m.hidden = true; };

    this.dom.settingsBtn.addEventListener('click', () => { this.#hydrateSettings(); openModal(this.dom.settings); });
    this.dom.hintSettings.addEventListener('click', () => { this.#hydrateSettings(); openModal(this.dom.settings); });
    this.dom.settingsCancel.addEventListener('click', () => closeModal(this.dom.settings));
    this.dom.settingsClose.addEventListener('click', () => closeModal(this.dom.settings));
    this.dom.settingsSave.addEventListener('click', () => this.#saveSettings());

    this.dom.syncOpen.addEventListener('click', () => { this.#hydrateCode(); openModal(this.dom.sync); });
    this.dom.syncClose.addEventListener('click', () => closeModal(this.dom.sync));
    this.dom.codeRoll.addEventListener('click', () => this.#hydrateCode(true));
    this.dom.syncSave.addEventListener('click', () => this.#doSync());
    this.dom.syncLoad.addEventListener('click', () => this.#doRestore());

    for (const m of [this.dom.settings, this.dom.sync]) {
      m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeModal(this.dom.settings);
      closeModal(this.dom.sync);
    });

    window.addEventListener('beforeunload', () => this.live?.disconnect());
  }

  #apiKey() { return localStorage.getItem(KEY_API) || ''; }

  #hydrateSettings() {
    this.dom.apiKey.value = this.#apiKey();
    this.dom.voice.replaceChildren(...VOICES.map((v) => new Option(v, v)));
    this.dom.voice.value = localStorage.getItem(KEY_VOICE) || 'Puck';
    this.dom.model.value = localStorage.getItem(KEY_LIVE_MODEL) || DEFAULT_LIVE_MODEL;
    this.dom.proModel.value = localStorage.getItem(KEY_PRO_MODEL) || DEFAULT_PRO_MODEL;
  }

  #saveSettings() {
    localStorage.setItem(KEY_API, this.dom.apiKey.value.trim());
    localStorage.setItem(KEY_VOICE, this.dom.voice.value);
    localStorage.setItem(KEY_LIVE_MODEL, this.dom.model.value.trim() || DEFAULT_LIVE_MODEL);
    localStorage.setItem(KEY_PRO_MODEL, this.dom.proModel.value.trim() || DEFAULT_PRO_MODEL);
    this.dom.settings.hidden = true;
    this.#toast('Settings saved');
    this.#setStatus('idle', this.#apiKey() ? 'Idle' : 'No API key');
  }

  // ── Session ──────────────────────────────────────────────────────
  async #ensureLive() {
    const apiKey = this.#apiKey();
    if (!apiKey) {
      this.dom.settings.hidden = false;
      this.#toast('Add a Gemini API key in Settings first', 'error');
      throw new Error('No API key');
    }
    if (this.live) return this.live;

    this.#setStatus('connecting', 'Connecting…');
    this.live = new GeminiLiveClient({
      apiKey,
      voice: localStorage.getItem(KEY_VOICE) || 'Puck',
      model: localStorage.getItem(KEY_LIVE_MODEL) || DEFAULT_LIVE_MODEL,
      onTranscript: (role, text, final) => this.#onTranscript(role, text, final),
      onAudioData: (pcm, rate) => {
        this.audio.playChunk(pcm, rate).catch((err) => console.warn('[qbit] playback:', err.message));
      },
      onStatusChange: (status, detail) => this.#onLiveStatus(status, detail),
      onToolCall: (call) => this.#onToolCall(call),
    });

    try {
      await this.live.connect();
    } catch (err) {
      this.live = null;
      this.#setStatus('error', 'Connection failed');
      this.#toast(err.message, 'error');
      throw err;
    }
    return this.live;
  }

  #onLiveStatus(status, detail) {
    switch (status) {
      case 'CONNECTED':
        this.#setStatus('live', 'Live');
        this.dom.turn.textContent = 'READY';
        break;

      case 'INTERRUPTED':
        // Barge-in: drop everything still queued for a turn nobody is
        // listening to. The Live best-practices doc is explicit that this
        // must happen immediately or the agent talks over the user.
        this.audio.stopPlayback();
        this.dom.turn.textContent = 'INTERRUPTED';
        break;

      case 'GENERATING_DONE':
        this.dom.turn.textContent = 'PLAYING';
        break;

      case 'TURN_DONE':
        this.dom.turn.textContent = this.isListening ? 'LISTENING' : 'READY';
        break;

      case 'DISCONNECTED':
        this.#stopListening();
        this.live = null;
        this.dom.turn.textContent = 'READY';
        this.#setStatus('idle', detail || 'Disconnected');
        break;

      case 'ERROR':
        this.#setStatus('error', detail || 'Error');
        break;
    }
  }

  #onToolCall({ name, args }) {
    if (name !== 'record_profile') return;
    if (this.profile.addFact(args)) {
      this.#renderProfile();
      this.#toast(`Learned: ${args.text}`);
    }
  }

  async #startListening() {
    if (this.isListening) return;
    try {
      const live = await this.#ensureLive();
      this.isListening = true;
      this.dom.mic.classList.add('is-live');
      this.#setStatus('listen', 'Listening 16 kHz');
      await this.audio.startCapture((chunk, rate) => live.sendAudioChunk(chunk, rate));
    } catch (err) {
      console.warn('[qbit] mic:', err.message);
      this.#stopListening();
    }
  }

  #stopListening() {
    if (!this.isListening) return;
    this.isListening = false;
    this.audio.stopCapture();
    this.dom.mic.classList.remove('is-live');
    this.#setStatus(this.live ? 'live' : 'idle', this.live ? 'Live' : 'Idle');
  }

  async #sendTyped() {
    const text = this.dom.input.value.trim();
    if (!text) return;
    this.dom.input.value = '';
    this.#appendMsg('user', text);

    try {
      const live = await this.#ensureLive();
      this.handsFree = true;
      this.dom.push.classList.add('is-active');
      this.dom.push.setAttribute('aria-pressed', 'true');
      if (!this.isListening) await this.#startListening();
      live.sendText(text);
    } catch {
      // Toast already shown by #ensureLive; the line stays visible.
    }
  }

  // ── Transcript ───────────────────────────────────────────────────
  #onTranscript(role, text, final) {
    if (!text?.trim()) return;
    if (!final) { this.#showInterim(role, text); return; }

    if (this.pendingInterim?.role === role) {
      this.dom.transcript.removeChild(this.pendingInterim.node);
      this.pendingInterim = null;
    }
    this.#appendMsg(role, text);
  }

  #showInterim(role, text) {
    if (!this.pendingInterim || this.pendingInterim.role !== role) {
      this.pendingInterim?.node.remove();
      this.pendingInterim = { role, node: this.#appendMsg(role, text, true) };
    } else {
      this.pendingInterim.node.querySelector('p').textContent = text;
    }
    this.#scroll();
  }

  #appendMsg(role, text, interim = false) {
    const wrap = el('div', `msg msg--${role}${interim ? ' msg--interim' : ''}`);
    wrap.appendChild(el('span', 'msg__role', role === 'user' ? 'You' : 'Q bit'));
    wrap.appendChild(el('p', null, text));
    this.dom.transcript.appendChild(wrap);
    this.#scroll();
    return wrap;
  }

  #scroll() {
    this.dom.transcript.scrollTop = this.dom.transcript.scrollHeight;
  }

  // ── Profile panel ────────────────────────────────────────────────
  #renderProfile() {
    const facts = this.profile.getFactList();
    const skills = this.profile.getSkillList();

    this.dom.statFacts.textContent = String(facts.length);
    this.dom.statSkills.textContent = String(skills.length);
    this.dom.statSessions.textContent = String(this.profile.getData().sessions || 0);

    this.dom.skills.replaceChildren(
      ...skills.map((s) => el('span', 'chip', s))
    );
    this.dom.skillsEmpty.hidden = skills.length > 0;

    this.dom.facts.replaceChildren(
      ...facts.slice(0, 30).map((f) => {
        const li = el('li');
        const t = new Date();
        li.appendChild(
          el('time', null, `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`)
        );
        li.appendChild(document.createTextNode(f));
        return li;
      })
    );
    this.dom.factsEmpty.hidden = facts.length > 0;
  }

  // ── Playbooks ────────────────────────────────────────────────────
  async #generate() {
    if (this.busy) return;
    if (this.profile.isEmpty()) {
      this.#toast('Talk to Q bit first — there is nothing to build a playbook from yet', 'error');
      return;
    }

    this.busy = true;
    this.dom.gen.disabled = true;
    this.dom.recs.replaceChildren(el('p', 'empty', 'Thinking… this runs on Gemini 3.1 Pro and can take 20–40 seconds.'));

    try {
      this.recs = await generateRecommendations({
        apiKey: this.#apiKey(),
        brief: this.profile.toBrief(),
        model: localStorage.getItem(KEY_PRO_MODEL) || DEFAULT_PRO_MODEL,
        thinkingLevel: 'high',
      });
      this.#renderRecs();
      this.#toast(`${this.recs.length} playbooks generated`);
    } catch (err) {
      this.dom.recs.replaceChildren(el('p', 'empty', err.message));
      this.#toast(err.message, 'error');
    } finally {
      this.busy = false;
      this.dom.gen.disabled = false;
    }
  }

  #renderRecs() {
    const list = this.tier === 'all' ? this.recs : this.recs.filter((r) => r.tier === this.tier);
    if (!list.length) {
      this.dom.recs.replaceChildren(
        el('p', 'empty', this.recs.length ? 'Nothing at this tier.' : 'No playbooks yet. Learn a few facts first, then generate.')
      );
      return;
    }

    this.dom.recs.replaceChildren(
      ...list.map((r) => {
        const card = el('article', 'card');
        card.dataset.tier = r.tier;
        card.appendChild(el('span', 'card__tag', r.tier));
        card.appendChild(el('h3', 'card__title', r.title));
        card.appendChild(el('p', 'card__why', r.why));
        if (r.nextStep) card.appendChild(el('p', 'card__next', `→ ${r.nextStep}`));
        return card;
      })
    );
  }

  // ── Sync ─────────────────────────────────────────────────────────
  #hydrateCode(regenerate = false) {
    let code = regenerate ? '' : localStorage.getItem(KEY_CODE);
    if (!code) {
      code = generateRecoveryCode();
      localStorage.setItem(KEY_CODE, code);
    }
    this.dom.code.textContent = code;
    this.dom.restore.value = '';
    this.dom.syncStatus.textContent = '';
  }

  async #doSync() {
    const code = this.dom.code.textContent;
    if (!isValidCode(code)) { this.#toast('Generate a valid recovery code first', 'error'); return; }
    this.dom.syncStatus.textContent = 'Saving…';
    try {
      await syncToCloud(code, this.profile.getData());
      this.dom.syncStatus.textContent = 'Saved. Restore it from any browser with this code.';
      this.#toast('Profile saved to server');
    } catch (err) {
      this.dom.syncStatus.textContent = err.message;
      this.#toast(err.message, 'error');
    }
  }

  async #doRestore() {
    const code = formatCode(this.dom.restore.value);
    if (!isValidCode(code)) { this.#toast('Enter a code in the form XXXX-XXXX-XXXX-XXXX', 'error'); return; }
    this.dom.syncStatus.textContent = 'Restoring…';
    try {
      const data = await loadFromCloud(code);
      this.profile.replace(data);
      this.#renderProfile();
      this.dom.restore.value = '';
      this.dom.syncStatus.textContent = 'Restored.';
      this.#toast('Reflection restored');
    } catch (err) {
      this.dom.syncStatus.textContent = err.message;
      this.#toast(err.message, 'error');
    }
  }

  // ── Chrome ───────────────────────────────────────────────────────
  #setStatus(state, text) {
    this.dom.dot.className = `dot ${
      { idle: '', connecting: 'dot--live', live: 'dot--live', listen: 'dot--listen', error: 'dot--error' }[state] || ''
    }`.trim();
    this.dom.statusText.textContent = text;
  }

  #toast(message, kind = 'info') {
    const t = this.dom.toast;
    t.textContent = message;
    t.dataset.kind = kind;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 2800);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.qbit = new QBitApp();
});
