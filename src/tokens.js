'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

function generateToken() {
  return 'gt06_' + crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createToken(label) {
  const token = generateToken();
  const { rows } = await pool.query(
    `INSERT INTO api_tokens (label, token_hash, token_prefix)
     VALUES ($1, $2, $3)
     RETURNING id, label, token_prefix, created_at, last_used_at`,
    [label, hashToken(token), token.slice(0, 12)]
  );
  return { ...rows[0], token };
}

async function listTokens() {
  const { rows } = await pool.query(
    `SELECT id, label, token_prefix, created_at, last_used_at
     FROM api_tokens ORDER BY created_at DESC`
  );
  return rows;
}

async function deleteToken(id) {
  const { rowCount } = await pool.query('DELETE FROM api_tokens WHERE id = $1', [id]);
  return rowCount > 0;
}

/** true kalau token valid; juga menandai last_used_at (fire-and-forget, tidak menghalangi request). */
async function verifyToken(token) {
  if (!token) return false;
  const { rows } = await pool.query('SELECT id FROM api_tokens WHERE token_hash = $1', [hashToken(token)]);
  if (rows.length === 0) return false;
  pool
    .query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [rows[0].id])
    .catch(() => {});
  return true;
}

module.exports = { createToken, listTokens, deleteToken, verifyToken };
