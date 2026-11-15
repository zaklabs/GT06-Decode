'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

// Cakupan token:
//   external : dipakai aplikasi lain untuk /api/external/*
//   admin    : dipakai GPS-Dashboard (sisi server) untuk /api/admin/*
const SCOPES = ['external', 'admin'];

function generateToken() {
  return 'gt06_' + crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createToken(label, scope = 'external') {
  if (!SCOPES.includes(scope)) throw new Error(`scope token tidak dikenal: ${scope}`);
  const token = generateToken();
  const { rows } = await pool.query(
    `INSERT INTO api_tokens (label, token_hash, token_prefix, scope)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, token_prefix, scope, created_at, last_used_at`,
    [label, hashToken(token), token.slice(0, 12), scope]
  );
  return { ...rows[0], token };
}

async function listTokens() {
  const { rows } = await pool.query(
    `SELECT id, label, token_prefix, scope, created_at, last_used_at
     FROM api_tokens ORDER BY created_at DESC`
  );
  return rows;
}

/** Scope token dengan id tertentu, atau null kalau tidak ada. */
async function getScope(id) {
  const { rows } = await pool.query('SELECT scope FROM api_tokens WHERE id = $1', [id]);
  return rows.length > 0 ? rows[0].scope : null;
}

async function deleteToken(id) {
  const { rowCount } = await pool.query('DELETE FROM api_tokens WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * { id, scope } kalau token valid, null kalau tidak. Juga menandai last_used_at
 * (fire-and-forget, tidak menghalangi request).
 */
async function verifyToken(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT id, scope FROM api_tokens WHERE token_hash = $1', [hashToken(token)]);
  if (rows.length === 0) return null;
  pool
    .query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [rows[0].id])
    .catch(() => {});
  return { id: rows[0].id, scope: rows[0].scope };
}

module.exports = { SCOPES, createToken, listTokens, getScope, deleteToken, verifyToken };
