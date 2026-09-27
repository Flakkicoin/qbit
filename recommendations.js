// js/recommendations.js — playbook generation via Gemini 3.1 Pro
//
// This file did not exist in v0.1. js/app.js did `import { generateRecommendations }
// from './recommendations.js'`, the static server answered the missing request
// with index.html and a 200, and the browser rejected it as an unsupported MIME
// type — taking the entire module graph down with it. The app rendered a blank
// screen with no error a user could act on.
//
// Model: gemini-3.1-pro-preview. Note it has no free tier on the Gemini API,
// so this call fails with a billing error until the project is set up. That is
// surfaced verbatim in the UI rather than swallowed.
'use strict';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const DEFAULT_PRO_MODEL = 'gemini-3.1-pro-preview';

const SYSTEM = `You turn what someone has told you about themselves into concrete,
specific things they can actually do to make money or build a reputation.

You are not a career coach and not a motivational speaker. You are a sharp
operator who has read their profile and is naming the obvious play they are
walking past.

Rules:
- Ground every recommendation in something the user actually said. If the profile
  is thin, propose the single highest-information conversation to have instead of
  inventing a background for them.
- "Why" must cite the specific fact that triggered the idea. Not "because you have
  experience" — "because you said you already maintain a Rust crate with real usage".
- "Next step" must be doable this week, by one person, with no budget.
- Be specific about the artifact: the thing they would build, write, or ship.
- No motivational filler, no "leverage your unique strengths", no emoji.
- Tiers mean real effort, not optimism:
    quick    - hours, ships in a day, near-zero risk
    build    - a few weeks, real product surface, some risk
    moonshot - months, high variance, outsized upside`;

const SCHEMA = {
  type: 'object',
  properties: {
    playbooks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: ['quick', 'build', 'moonshot'] },
          title: { type: 'string', description: 'Short, concrete, no hype. Max 60 chars.' },
          why: { type: 'string', description: 'The reasoning, citing the user fact that triggered it.' },
          nextStep: { type: 'string', description: 'One action, doable this week.' },
        },
        required: ['tier', 'title', 'why', 'nextStep'],
      },
    },
  },
  required: ['playbooks'],
};

export class RecommendationError extends Error {}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.brief           plaintext profile from ProfileStore.toBrief()
 * @param {string} [options.model]
 * @param {'low'|'medium'|'high'} [options.thinkingLevel]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{tier:string,title:string,why:string,nextStep:string}>>}
 */
export async function generateRecommendations({
  apiKey,
  brief,
  model = DEFAULT_PRO_MODEL,
  thinkingLevel = 'high',
  signal,
}) {
  if (!apiKey) throw new RecommendationError('Add a Gemini API key in Settings first');

  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${brief}\n\nGive me 6 playbooks: 3 quick, 2 build, 1 moonshot.`,
          },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: SYSTEM }] },
    generationConfig: {
      thinkingConfig: { thinkingLevel },
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new RecommendationError('Network error reaching the Gemini API');
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const message = detail?.error?.message || `HTTP ${response.status}`;
    throw new RecommendationError(friendlyError(response.status, message));
  }

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';

  if (!text) {
    const block = payload.promptFeedback?.blockReason;
    throw new RecommendationError(
      block ? `Blocked by safety filter: ${block}` : 'Gemini returned an empty response'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecommendationError('Could not parse the model response as JSON');
  }

  const list = Array.isArray(parsed.playbooks) ? parsed.playbooks : [];
  if (!list.length) throw new RecommendationError('Model returned no playbooks');

  return list.map((p) => ({
    tier: ['quick', 'build', 'moonshot'].includes(p.tier) ? p.tier : 'quick',
    title: String(p.title || '').slice(0, 120),
    why: String(p.why || ''),
    nextStep: String(p.nextStep || ''),
  }));
}

/** Turn raw API errors into something a person can act on. */
function friendlyError(status, message) {
  if (status === 400 && /billing|paid tier|payment/i.test(message)) {
    return `${DEFAULT_PRO_MODEL} has no free tier — enable billing on the project, or switch the thinking model in Settings.`;
  }
  if (status === 400 && /API key not valid/i.test(message)) {
    return 'Gemini rejected that API key.';
  }
  if (status === 404) {
    return 'That model id does not exist. Check the thinking model in Settings.';
  }
  if (status === 429) {
    return 'Rate limited by the Gemini API. Wait a moment and try again.';
  }
  if (status >= 500) {
    return `Gemini is having trouble (HTTP ${status}). Try again shortly.`;
  }
  return message.slice(0, 200);
}
