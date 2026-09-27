// js/cloud.js — recovery codes + sync client
//
// v0.1 normalised codes on read but not on write: the client stripped dashes
// before GET /api/profile/, while POST /api/sync sent the dashed code and the
// server hashed it verbatim. Save and restore used different keys, so a
// restore always missed. Both sides now funnel through normalizeCode() and
// server.js applies the identical rule before hashing.
'use strict';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;

/** Strip everything outside the alphabet and upper-case. Mirrors server.js. */
export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('');
}

export function isValidCode(raw) {
  return /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(String(raw || '').toUpperCase());
}

/** 16 chars = 80 bits of entropy. 32 divides 256, so the index is unbiased. */
export function generateRecoveryCode() {
  const bytes = new Uint8Array(CODE_GROUPS * CODE_GROUP_LEN);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return Array.from({ length: CODE_GROUPS }, (_, i) =>
    chars.slice(i * CODE_GROUP_LEN, i * CODE_GROUP_LEN + CODE_GROUP_LEN).join('')
  ).join('-');
}

/** Accepts a pasted code in any formatting and re-renders it canonically. */
export function formatCode(raw) {
  const clean = normalizeCode(raw);
  return Array.from({ length: CODE_GROUPS }, (_, i) =>
    clean.slice(i * CODE_GROUP_LEN, i * CODE_GROUP_LEN + CODE_GROUP_LEN)
  )
    .filter(Boolean)
    .join('-');
}

const base = (url) => (url || window.location.origin).replace(/\/$/, '');

export async function syncToCloud(code, profileData, serverBaseUrl) {
  const canonical = formatCode(code);
  if (!isValidCode(canonical)) throw new Error('Recovery code must be XXXX-XXXX-XXXX-XXXX');

  const response = await fetch(`${base(serverBaseUrl)}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: canonical, profile: profileData }),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Sync failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function loadFromCloud(code, serverBaseUrl) {
  // Normalise first, so a pasted code without dashes still resolves.
  const canonical = formatCode(code);
  if (!isValidCode(canonical)) throw new Error('Recovery code must be XXXX-XXXX-XXXX-XXXX');

  const response = await fetch(`${base(serverBaseUrl)}/api/profile/${canonical}`);
  if (response.status === 404) throw new Error('No profile stored for that code');
  if (!response.ok) throw new Error(`Restore failed (HTTP ${response.status})`);

  const data = await response.json();
  return data.profile;
}
