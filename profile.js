// js/profile.js — the reflection store
//
// v0.1 shipped a hard-coded persona ("author of Rust crates with 45k monthly
// downloads", "targets Series B+ startups") as the default profile. Anyone
// opening the app saw a stranger's life story rendered as their own facts, and
// `extractKnowledge` never actually extracted — it appended every raw utterance
// to the facts list, so the "learned facts" panel was just a chat log.
//
// v0.2 starts empty. Facts arrive from the model's record_profile tool, and
// everything is deduplicated case-insensitively.
'use strict';

const STORAGE_KEY = 'qbit_profile_v2';
const MAX_FACTS = 60;
const MAX_SKILLS = 24;

const EMPTY = {
  facts: [],
  skills: [],
  domains: [],
  sessions: 0,
  createdAt: 0,
  updatedAt: 0,
};

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Crockford Base32 — no I/L/O/U, so codes survive being read aloud. */
const SKILL_TAXONOMY = {
  rust: 'Rust', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
  go: 'Go', golang: 'Go', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', 'c++': 'C++', 'c#': 'C#', csharp: 'C#', ruby: 'Ruby',
  php: 'PHP', scala: 'Scala', elixir: 'Elixir', haskell: 'Haskell', zig: 'Zig',
  react: 'React', vue: 'Vue', svelte: 'Svelte', angular: 'Angular',
  node: 'Node.js', nodejs: 'Node.js', nextjs: 'Next.js', next: 'Next.js',
  django: 'Django', flask: 'Flask', rails: 'Ruby on Rails', spring: 'Spring',
  grpc: 'gRPC', wasm: 'WebAssembly', webassembly: 'WebAssembly', docker: 'Docker',
  kubernetes: 'Kubernetes', k8s: 'Kubernetes', terraform: 'Terraform',
  aws: 'AWS', gcp: 'GCP', azure: 'Azure', linux: 'Linux', devops: 'DevOps',
  postgres: 'Postgres', postgresql: 'Postgres', mysql: 'MySQL', redis: 'Redis',
  mongodb: 'MongoDB', kafka: 'Kafka', graphql: 'GraphQL', rest: 'REST APIs',
  ml: 'Machine Learning', 'machine learning': 'Machine Learning',
  ai: 'AI/ML', llm: 'LLMs', pytorch: 'PyTorch', tensorflow: 'TensorFlow',
  security: 'Security', pentest: 'Security', crypto: 'Cryptography',
  figma: 'Figma', design: 'Design', 'product design': 'Product Design',
  seo: 'SEO', marketing: 'Marketing', sales: 'Sales', writing: 'Writing',
  devrel: 'Developer Relations', open_source: 'Open Source', opensource: 'Open Source',
};

export class ProfileStore {
  constructor() {
    this.data = this.#load();
  }

  #load() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          return {
            ...EMPTY,
            ...parsed,
            facts: Array.isArray(parsed.facts) ? parsed.facts : [],
            skills: Array.isArray(parsed.skills) ? parsed.skills : [],
            domains: Array.isArray(parsed.domains) ? parsed.domains : [],
            sessions: Number(parsed.sessions) || 0,
          };
        }
      }
    } catch {
      // Corrupt or unavailable localStorage — start clean rather than crash.
    }
    return { ...EMPTY, createdAt: Date.now() };
  }

  save() {
    this.data.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[qbit] could not persist profile:', err.message);
    }
  }

  getData() {
    return this.data;
  }

  #push(list, value, cap) {
    const clean = String(value || '').trim();
    if (!clean) return false;
    const key = norm(clean);
    if (list.some((x) => norm(x) === key)) return false;
    list.unshift(clean);
    if (list.length > cap) list.length = cap;
    return true;
  }

  /**
   * Called by the app when the Live session's record_profile tool fires.
   * @param {{text:string, kind:string}} fact
   * @returns {boolean} true if anything was stored
   */
  addFact({ text, kind }) {
    const clean = String(text || '').trim();
    if (clean.length < 4) return false;

    let changed = this.#push(this.data.facts, clean, MAX_FACTS);

    if (kind === 'skill') changed = this.#push(this.data.skills, clean, MAX_SKILLS) || changed;
    if (kind === 'opinion' || kind === 'preference') changed = this.#push(this.data.domains, clean, MAX_SKILLS) || changed;

    // Opportunistically harvest known skill names from the sentence.
    const lower = ` ${clean.toLowerCase()} `;
    for (const [needle, label] of Object.entries(SKILL_TAXONOMY)) {
      if (lower.includes(` ${needle} `) || lower.includes(` ${needle}.`) || lower.includes(` ${needle},`)) {
        this.#push(this.data.skills, label, MAX_SKILLS);
      }
    }

    if (changed) this.save();
    return changed;
  }

  /** Merged, de-duplicated list of "skill" facts and harvested tags. */
  getSkillList() {
    return this.data.skills;
  }

  getFactList() {
    return this.data.facts.filter((f) => typeof f === 'string');
  }

  isEmpty() {
    return this.getFactList().length === 0 && this.getSkillList().length === 0;
  }

  startSession() {
    this.data.sessions = (this.data.sessions || 0) + 1;
    this.save();
  }

  replace(data) {
    if (!data || typeof data !== 'object') return;
    this.data = {
      ...EMPTY,
      createdAt: data.createdAt || Date.now(),
      facts: Array.isArray(data.facts) ? data.facts.filter((f) => typeof f === 'string') : [],
      skills: Array.isArray(data.skills) ? data.skills.filter((s) => typeof s === 'string') : [],
      domains: Array.isArray(data.domains) ? data.domains.filter((s) => typeof s === 'string') : [],
      sessions: Number(data.sessions) || 0,
      updatedAt: Date.now(),
    };
    this.save();
  }

  clear() {
    this.data = { ...EMPTY, createdAt: Date.now() };
    this.save();
  }

  /** Plain-text brief handed to the thinking model. */
  toBrief() {
    const f = this.getFactList();
    if (!f.length) return 'The user has not shared anything yet. Do not invent a profile.';
    return [
      `Known facts (${f.length}):`,
      ...f.map((x) => `- ${x}`),
      this.getSkillList().length ? `\nSkill signals: ${this.getSkillList().join(', ')}` : '',
      this.data.domains.length ? `\nStated opinions and preferences: ${this.data.domains.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
