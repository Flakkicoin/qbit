// server.js — zero-dependency static server + REST sync API for Q bit
//
// Fixes over v0.1:
//  - recovery codes are normalised the same way on write AND read
//    (v0.1 hashed the dashed code on POST but the dash-stripped code on GET,
//     so every retrieve was a guaranteed 404)
//  - real path-traversal guard using path.relative, not a string prefix
//  - missing assets return 404 instead of silently serving index.html with a
//    200, which is what made a missing .js fail as a MIME/module error
//  - profile writes are serialised, so two concurrent syncs can't lose one
//  - binds to loopback by default; this store holds personal data
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const MAX_BODY = 2 * 1024 * 1024; // 2 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_FILE)) {
  fs.writeFileSync(PROFILES_FILE, '{}', 'utf8');
}

// ── Recovery codes ─────────────────────────────────────────────────
// Crockford Base32: no I, L, O, U — unambiguous when read aloud or retyped.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Single source of truth for code shape. Used by the client too. */
function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/** Accepts any formatting; the shape check runs on the normalised form. */
function isWellFormedCode(code) {
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(normalizeCode(code));
}

// ── Store ──────────────────────────────────────────────────────────
let writeChain = Promise.resolve();

function readProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic single-file write: temp file + rename. */
function writeProfilesAtomic(data) {
  const tmp = `${PROFILES_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, PROFILES_FILE);
}

/**
 * Serialised read-modify-write. v0.1 read the file, mutated the object and
 * wrote it back without holding a lock — two overlapping syncs meant the
 * second write silently dropped the first.
 */
function updateProfile(hash, profile) {
  const next = writeChain.then(() => {
    const profiles = readProfiles();
    profiles[hash] = { profile, updatedAt: Date.now() };
    writeProfilesAtomic(profiles);
  });
  // Keep the chain alive even if this link rejects.
  writeChain = next.catch(() => {});
  return next;
}

// ── Helpers ────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Crude in-memory throttle — enough to stop a runaway client hammering
// a loopback-only store.
const hits = new Map();
function throttled(ip, key, max, windowMs) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.reset) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count += 1;
  if (hits.size > 500) hits.clear();
  return entry.count <= max;
}

// ── Static files ───────────────────────────────────────────────────
// Files that exist in the repo but have no business being fetched over HTTP.
const SERVER_ONLY = new Set([
  'server.js',
  'package.json',
  'package-lock.json',
  'vercel.json',
  'netlify.toml',
  'wrangler.toml',
  'Dockerfile',
  'create-zip.sh',
]);

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.resolve(ROOT, `.${rel}`);

  // path.relative handles `..`, sibling-prefix tricks (/srv/app-secrets vs
  // /srv/app) and symlink-free escapes that startsWith() lets through.
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  // Never serve the profile store, dotfiles, or server-side config/source.
  const top = relative.split(path.sep)[0];
  const base = path.basename(relative);
  if (top === 'data' || top.startsWith('.') || SERVER_ONLY.has(base)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Extension-bearing requests are assets: a real 404 is far easier to
      // debug than an HTML body arriving where a module was expected.
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      } else {
        serveFile(res, path.join(ROOT, 'index.html'), req);
      }
      return;
    }
    serveFile(res, filePath, req);
  });
}

function serveFile(res, filePath, req) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  };
  if (/\.(png|jpg|jpeg|svg|webp|ico|woff2)$/.test(ext)) {
    headers['Cache-Control'] = 'public, max-age=86400';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  fs.readFile(filePath, (readErr, content) => {
    if (readErr) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
      return;
    }
    headers['Content-Length'] = content.length;
    res.writeHead(200, headers);
    res.end(content);
  });
}

// ── Router ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }).end();
    return;
  }

  // Health
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'qbit-core-node',
      version: '0.2.0',
      timestamp: Date.now(),
    });
    return;
  }

  // Store / update a profile
  if (pathname === '/api/sync' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!throttled(ip, `sync:${ip}`, 60, 60_000)) {
      sendJson(res, 429, { error: 'Too many syncs — slow down' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req, MAX_BODY));
    } catch (err) {
      sendJson(res, err.code === 'TOO_LARGE' ? 413 : 400, {
        error: err.code === 'TOO_LARGE' ? `Payload too large (${MAX_BODY} bytes max)` : 'Invalid JSON body',
      });
      return;
    }

    const { code, profile } = payload || {};
    if (!code || !profile) {
      sendJson(res, 400, { error: 'Missing code or profile payload' });
      return;
    }
    if (!isWellFormedCode(code)) {
      sendJson(res, 400, { error: 'Recovery code must be XXXX-XXXX-XXXX-XXXX' });
      return;
    }
    if (typeof profile !== 'object' || Array.isArray(profile)) {
      sendJson(res, 400, { error: 'Profile must be an object' });
      return;
    }

    const hash = hashCode(code);
    try {
      await updateProfile(hash, profile);
      sendJson(res, 200, {
        success: true,
        fingerprint: hash.slice(0, 12),
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('[qbit] sync write failed:', err.message);
      sendJson(res, 500, { error: 'Failed to persist profile' });
    }
    return;
  }

  // Retrieve a profile
  if (pathname.startsWith('/api/profile/') && req.method === 'GET') {
    const raw = pathname.slice('/api/profile/'.length);
    if (!isWellFormedCode(raw)) {
      sendJson(res, 400, { error: 'Recovery code must be XXXX-XXXX-XXXX-XXXX' });
      return;
    }
    const record = readProfiles()[hashCode(raw)];
    if (record) {
      sendJson(res, 200, {
        success: true,
        profile: record.profile,
        updatedAt: record.updatedAt,
      });
    } else {
      sendJson(res, 404, { error: 'No profile stored for that code' });
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Unknown endpoint' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ⚡  Q bit Core Node`);
  console.log(`  ▸  http://${HOST}:${PORT}`);
  console.log(`  ▸  store: ${PROFILES_FILE}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  ⚠  bound to ${HOST} — sync codes and profiles are reachable from the network`);
  }
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
