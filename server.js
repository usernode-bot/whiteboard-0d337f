const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/drawing', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, drawing_data, title, updated_at FROM drawings
       WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ drawing: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drawing', async (req, res) => {
  try {
    const { drawing_data, title } = req.body;
    const { rows } = await pool.query(
      `SELECT id FROM drawings WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (rows.length > 0) {
      await pool.query(
        `UPDATE drawings SET drawing_data = $1, title = $2, updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(drawing_data), title || 'Untitled', rows[0].id]
      );
      res.json({ ok: true, id: rows[0].id });
    } else {
      const ins = await pool.query(
        `INSERT INTO drawings (user_id, username, drawing_data, title)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.user.id, req.user.username, JSON.stringify(drawing_data), title || 'Untitled']
      );
      res.json({ ok: true, id: ins.rows[0].id });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drawings (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      drawing_data JSONB,
      title TEXT DEFAULT 'Untitled',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
