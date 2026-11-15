'use strict';

/**
 * API admin untuk aplikasi lain (mis. GPS-Dashboard, dipanggil dari SISI SERVER).
 *
 * Autentikasi (salah satu):
 *   - Basic Auth ADMIN_USER/ADMIN_PASSWORD (manusia / curl)
 *   - Authorization: Bearer <token ber-scope "admin">
 * Tanpa ADMIN_PASSWORD di server, seluruh API ini nonaktif (503), termasuk token admin.
 *
 * Pembatasan token admin (supaya token yang bocor tidak bisa memperluas aksesnya sendiri):
 *   - tidak bisa membuat token ber-scope "admin"
 *   - tidak bisa menghapus token ber-scope "admin"
 *
 * Semua respons JSON. Error: { "error": "pesan" }; error server selalu generik (detail di log).
 */

const { log, clearHistory, getDevices, seedDevice } = require('./logger');
const { sendJson, readJsonBody, getBearerToken, isCrossSiteWrite, streamEvents } = require('./httpUtil');
const auth = require('./auth');
const tokens = require('./tokens');
const registry = require('./registry');
const db = require('./db');

const MAX_PG_INT = 2147483647;

/** @returns {Promise<{via: 'basic'|'token', tokenId?: number}|null>} null = respons 401/503 sudah dikirim */
async function authenticate(req, res) {
  if (!auth.isEnabled()) {
    sendJson(res, 503, { error: 'Akses admin dinonaktifkan: ADMIN_PASSWORD belum diset di server' });
    return null;
  }

  const header = req.headers.authorization || '';
  if (/^Bearer\s/i.test(header)) {
    const verified = await tokens.verifyToken(getBearerToken(req));
    if (verified && verified.scope === 'admin') return { via: 'token', tokenId: verified.id };
  } else if (auth.checkCredentials(req)) {
    return { via: 'basic' };
  }

  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  // Tantangan Basic hanya bila klien belum mengirim kredensial apa pun (agar browser memunculkan login).
  if (!header) headers['WWW-Authenticate'] = 'Basic realm="GT06 Decode Admin", charset="UTF-8"';
  res.writeHead(401, headers);
  res.end(JSON.stringify({ error: 'Autentikasi admin diperlukan' }));
  return null;
}

/** Body JSON berupa objek, atau null (400 sudah dikirim). */
async function getBody(req, res) {
  try {
    const body = await readJsonBody(req);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch (err) {
    // jatuh ke respons 400 di bawah
  }
  sendJson(res, 400, { error: 'Body JSON tidak valid (harus objek)' });
  return null;
}

/** decodeURIComponent yang tidak melempar; string kosong (ditolak validasi IMEI) kalau % rusak. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return '';
  }
}

function actorOf(ctx) {
  return ctx.via === 'token' ? `token#${ctx.tokenId}` : 'admin(basic)';
}

function tokenView(t) {
  return {
    id: t.id,
    label: t.label,
    tokenPrefix: t.token_prefix,
    scope: t.scope,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
  };
}

// ---------- handler ----------

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
}

route('GET', '/api/admin/info', async ({ res }) => {
  const list = getDevices();
  sendJson(res, 200, {
    imeiEnforce: registry.MODE,
    registry: registry.stats(),
    devices: { total: list.length, online: list.filter((d) => d.connected).length },
  });
});

// Snapshot device live (memori) + status registrasinya.
route('GET', '/api/admin/devices', async ({ res }) => {
  sendJson(res, 200, getDevices().map((d) => ({ ...d, registration: registry.statusOf(d.imei) })));
});

// SSE: event log, device, clear (khusus admin; berbeda dari /api/external/events).
route('GET', '/api/admin/events', async ({ req, res }) => streamEvents(req, res, { includeLogs: true }));

route('DELETE', '/api/admin/logs', async ({ res, ctx }) => {
  clearHistory();
  log('info', `[i] Log dashboard direset oleh ${actorOf(ctx)}`);
  res.writeHead(204).end();
});

route('POST', '/api/admin/reload-devices', async ({ res, ctx }) => {
  const rows = await db.getAllDevices();
  for (const row of rows) seedDevice(row.imei, row);
  log('info', `[i] Reload manual oleh ${actorOf(ctx)}: ${rows.length} device dimuat ulang dari database`);
  sendJson(res, 200, { reloaded: rows.length });
});

// ----- token -----
route('GET', '/api/admin/tokens', async ({ res }) => {
  sendJson(res, 200, (await tokens.listTokens()).map(tokenView));
});

route('POST', '/api/admin/tokens', async ({ req, res, ctx }) => {
  const body = await getBody(req, res);
  if (!body) return;

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) return sendJson(res, 400, { error: 'label wajib diisi' });
  if (label.length > 100) return sendJson(res, 400, { error: 'label maksimal 100 karakter' });

  const scope = body.scope === undefined ? 'external' : body.scope;
  if (!tokens.SCOPES.includes(scope)) return sendJson(res, 400, { error: 'scope harus "external" atau "admin"' });
  if (scope === 'admin' && ctx.via !== 'basic') {
    return sendJson(res, 403, { error: 'Token admin hanya dapat dibuat dengan Basic Auth admin' });
  }

  const created = await tokens.createToken(label, scope);
  log('info', `[i] Token API (${scope}) dibuat oleh ${actorOf(ctx)}: "${label}" (${created.token_prefix}...)`);
  sendJson(res, 201, { ...tokenView(created), token: created.token });
});

route('DELETE', '/api/admin/tokens/(\\d+)', async ({ res, ctx, params }) => {
  const id = Number(params[0]);
  if (!Number.isSafeInteger(id) || id > MAX_PG_INT) return sendJson(res, 404, { error: 'Token tidak ditemukan' });

  if (ctx.via !== 'basic') {
    const scope = await tokens.getScope(id);
    if (scope === null) return sendJson(res, 404, { error: 'Token tidak ditemukan' });
    if (scope === 'admin') return sendJson(res, 403, { error: 'Token admin hanya dapat dihapus dengan Basic Auth admin' });
  }

  if (!(await tokens.deleteToken(id))) return sendJson(res, 404, { error: 'Token tidak ditemukan' });
  log('info', `[i] Token API id=${id} dihapus oleh ${actorOf(ctx)}`);
  res.writeHead(204).end();
});

// ----- registry IMEI -----
route('GET', '/api/admin/registry', async ({ res }) => {
  sendJson(res, 200, await registry.list());
});

route('POST', '/api/admin/registry', async ({ req, res, ctx }) => {
  const body = await getBody(req, res);
  if (!body) return;
  const imei = registry.parseImei(body.imei);
  if (imei.error) return sendJson(res, 400, { error: imei.error });
  const label = registry.parseLabel(body.label);
  if (label.error) return sendJson(res, 400, { error: label.error });

  const row = await registry.create(imei.value, label.value);
  if (!row) return sendJson(res, 409, { error: 'IMEI sudah terdaftar' });
  log('info', `[REG] IMEI ${row.imei} didaftarkan oleh ${actorOf(ctx)}`);
  sendJson(res, 201, row);
});

route('POST', '/api/admin/registry/import-seen', async ({ res, ctx }) => {
  const imported = await registry.importSeen();
  log('info', `[REG] ${imported} IMEI yang pernah terlihat didaftarkan oleh ${actorOf(ctx)}`);
  sendJson(res, 200, { imported });
});

route('PATCH', '/api/admin/registry/([^/]+)', async ({ req, res, ctx, params }) => {
  const imei = registry.parseImei(safeDecode(params[0]));
  if (imei.error) return sendJson(res, 400, { error: imei.error });
  const body = await getBody(req, res);
  if (!body) return;

  const patch = {};
  if (body.label !== undefined) {
    const label = registry.parseLabel(body.label);
    if (label.error) return sendJson(res, 400, { error: label.error });
    patch.label = label.value;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled harus boolean' });
    patch.enabled = body.enabled;
  }
  if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: 'Tidak ada perubahan (isi label dan/atau enabled)' });

  const row = await registry.update(imei.value, patch);
  if (!row) return sendJson(res, 404, { error: 'IMEI tidak ditemukan' });
  log('info', `[REG] IMEI ${row.imei} diubah oleh ${actorOf(ctx)} (${Object.keys(patch).join(', ')})`);
  sendJson(res, 200, row);
});

route('DELETE', '/api/admin/registry/([^/]+)', async ({ res, ctx, params }) => {
  const imei = registry.parseImei(safeDecode(params[0]));
  if (imei.error) return sendJson(res, 400, { error: imei.error });
  if (!(await registry.remove(imei.value))) return sendJson(res, 404, { error: 'IMEI tidak ditemukan' });
  log('info', `[REG] IMEI ${imei.value} dihapus dari daftar oleh ${actorOf(ctx)}`);
  res.writeHead(204).end();
});

async function handle(req, res, url, pathname) {
  res.setHeader('Cache-Control', 'no-store');

  const ctx = await authenticate(req, res);
  if (!ctx) return;
  // Kredensial Basic dikirim otomatis oleh browser, jadi tolak tulis lintas-situs. Token Bearer tidak
  // dikirim otomatis, jadi tidak terpengaruh.
  if (ctx.via === 'basic' && isCrossSiteWrite(req)) {
    return sendJson(res, 403, { error: 'Origin permintaan tidak diizinkan' });
  }

  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    return r.handler({ req, res, url, ctx, params: m.slice(1) });
  }
  if (pathMatched) return sendJson(res, 405, { error: 'Metode tidak didukung' });
  return sendJson(res, 404, { error: 'Endpoint tidak ditemukan' });
}

module.exports = { handle };
