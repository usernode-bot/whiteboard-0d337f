const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

let clientIdCounter = 0;
const sseClients = new Map(); // clientId -> { res, username }
const connectedUsers = new Map(); // username -> { color, count }
const cursorMap = new Map(); // username -> { x, y, idleTimer }

const REACTION_ALLOWLIST = new Set(['🔥', '✨', '💥', '👏', '🌀']);

function usernameToColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

function broadcastAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res } of sseClients.values()) {
    res.write(msg);
  }
}

function broadcastExceptUsername(event, data, excludeUsername) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res, username } of sseClients.values()) {
    if (username !== excludeUsername) res.write(msg);
  }
}

function getPresenceList() {
  return [...connectedUsers.entries()].map(([username, { color }]) => ({ username, color }));
}

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

app.get('/api/strokes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, stroke_data, created_at FROM strokes ORDER BY created_at ASC, id ASC'
    );
    res.json({ strokes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/strokes/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');

  const clientId = ++clientIdCounter;
  const username = req.user.username;
  const color = usernameToColor(username);

  sseClients.set(clientId, { res, username });

  if (connectedUsers.has(username)) {
    connectedUsers.get(username).count++;
  } else {
    connectedUsers.set(username, { color, count: 1 });
  }
  broadcastAll('presence', { users: getPresenceList() });

  req.on('close', () => {
    sseClients.delete(clientId);

    if (cursorMap.has(username)) {
      clearTimeout(cursorMap.get(username).idleTimer);
      cursorMap.delete(username);
    }

    const user = connectedUsers.get(username);
    if (user) {
      user.count--;
      if (user.count <= 0) {
        connectedUsers.delete(username);
        broadcastAll('cursor_leave', { username });
        broadcastAll('presence', { users: getPresenceList() });
      }
    }
  });
});

app.post('/api/strokes', async (req, res) => {
  try {
    const { stroke_data } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO strokes (user_id, username, stroke_data) VALUES ($1, $2, $3) RETURNING id, created_at',
      [req.user.id, req.user.username, JSON.stringify(stroke_data)]
    );
    const result = { ok: true, id: rows[0].id, created_at: rows[0].created_at };
    res.json(result);
    broadcastAll('stroke', { id: rows[0].id, user_id: req.user.id, username: req.user.username, stroke_data, created_at: rows[0].created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/strokes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM strokes WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
    broadcastAll('undo', { id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/strokes/:id', async (req, res) => {
  try {
    const { stroke_data } = req.body;
    const { rows } = await pool.query(
      'UPDATE strokes SET stroke_data = $1 WHERE id = $2 AND user_id = $3 RETURNING id, user_id, username, created_at',
      [JSON.stringify(stroke_data), req.params.id, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Not found or not authorized' });
    }
    res.json({ ok: true });
    broadcastAll('update', { id: rows[0].id, user_id: rows[0].user_id, username: rows[0].username, stroke_data, created_at: rows[0].created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/strokes', async (req, res) => {
  try {
    await pool.query('DELETE FROM strokes');
    res.json({ ok: true });
    broadcastAll('clear', {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cursor', (req, res) => {
  const { x, y } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  const username = req.user.username;
  const color = usernameToColor(username);

  if (cursorMap.has(username)) {
    clearTimeout(cursorMap.get(username).idleTimer);
  }
  const idleTimer = setTimeout(() => {
    cursorMap.delete(username);
    broadcastAll('cursor_leave', { username });
  }, 15000);
  cursorMap.set(username, { x, y, idleTimer });

  broadcastExceptUsername('cursor', { username, color, x, y }, username);
  res.json({ ok: true });
});

app.post('/api/reaction', (req, res) => {
  const { emoji, x, y } = req.body;
  if (!REACTION_ALLOWLIST.has(emoji)) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }
  if (typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  const username = req.user.username;
  broadcastAll('reaction', { username, emoji, x, y });
  res.json({ ok: true });
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
    CREATE TABLE IF NOT EXISTS strokes (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      stroke_data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
