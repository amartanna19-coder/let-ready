'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const auth = require('./auth');
const compliance = require('./compliance');
const files = require('./files');
const { HttpError } = require('./errors');
const { RateLimiter } = require('./rate-limit');
const { matchRoute } = require('./routes');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// Attempts allowed per window. The window is 15 minutes unless noted.
const DEFAULT_LIMITS = {
  loginByEmail: { limit: 10, windowMs: 15 * 60 * 1000 },
  loginByIp: { limit: 100, windowMs: 15 * 60 * 1000 },
  register: { limit: 10, windowMs: 60 * 60 * 1000 },
  forgotByEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
  forgotByIp: { limit: 20, windowMs: 60 * 60 * 1000 },
  resetByIp: { limit: 20, windowMs: 60 * 60 * 1000 },
};

function createLimiters(overrides = {}, now) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  return Object.fromEntries(
    Object.entries(limits).map(([name, settings]) => [name, new RateLimiter({ ...settings, now })]),
  );
}

function createServer({ db, config = {}, today = compliance.todayInLondon, now = Date.now, limits = {} }) {
  const settings = { secureCookies: false, trustProxy: false, appUrl: 'http://localhost:3000', ...config };
  const limiters = createLimiters(limits, now);

  const server = http.createServer((req, res) => {
    handle(req, res, { db, config: settings, today, now, limiters }).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message }, error.headers);
        return;
      }
      console.error('Unhandled error:', error);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    });
  });

  // Protects against slow-loris style clients holding connections open.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  return server;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

async function handle(req, res, context) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(req, res, url.pathname);
    return;
  }

  const { route, params } = matchRoute(req.method, url.pathname);
  const token = auth.readSessionToken(req);
  const user = route.requiresAuth ? requireUser(context.db, token, context.now()) : null;
  const ip = clientIp(req, context.config.trustProxy);

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > route.maxBytes) throw new HttpError(413, 'Request is too large.');
  const body = req.method === 'GET' ? {} : await readJsonBody(req, route.maxBytes);

  const result = await route.handler({ ...context, body, params, user, token, ip });
  if (result.raw) {
    sendRaw(res, result.raw);
    return;
  }
  sendJson(res, result.status || 200, result.body, result.headers);
}

function requireUser(db, token, now) {
  const user = auth.findSessionUser(db, token, now);
  if (!user) throw new HttpError(401, 'Please log in.');
  return user;
}

async function readJsonBody(req, maxBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Requests must be sent as JSON.');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return parsed;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');

  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found.');

  let content;
  try {
    content = await fs.readFile(file);
  } catch {
    throw new HttpError(404, 'Not found.');
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

function sendJson(res, status, body = {}, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendRaw(res, { contentType, filename, data }) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Content-Disposition': files.contentDisposition(filename),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

module.exports = { createServer };
