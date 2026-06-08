const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json({ limit: '20mb' }));

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
      'SELECT id, user_id, username, stroke_data, z_index, created_at FROM strokes ORDER BY z_index ASC, id ASC'
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
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/strokes', async (req, res) => {
  try {
    const { stroke_data } = req.body;
    // New layers land on top of the stack: next z_index above the current max.
    const { rows } = await pool.query(
      `INSERT INTO strokes (user_id, username, stroke_data, z_index)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(z_index), 0) + 1 FROM strokes))
       RETURNING id, z_index, created_at`,
      [req.user.id, req.user.username, JSON.stringify(stroke_data)]
    );
    const result = { ok: true, id: rows[0].id, z_index: rows[0].z_index, created_at: rows[0].created_at };
    res.json(result);
    broadcast('stroke', {
      id: rows[0].id,
      user_id: req.user.id,
      username: req.user.username,
      stroke_data,
      z_index: rows[0].z_index,
      created_at: rows[0].created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a layer's position (stroke_data) and/or z-order. Any collaborator
// may edit any layer (shared board, matching clear-all). Last write wins.
app.patch('/api/strokes/:id', async (req, res) => {
  try {
    const { stroke_data, z_index } = req.body;

    let bringToFront = false;
    let sendToBack = false;
    let zValue = z_index;
    // Allow symbolic z-order requests so clients don't need to know the
    // current extremes. {z_index: 'front'} / 'back' resolve server-side.
    if (z_index === 'front') { bringToFront = true; zValue = undefined; }
    else if (z_index === 'back') { sendToBack = true; zValue = undefined; }

    if (bringToFront) {
      const { rows } = await pool.query('SELECT COALESCE(MAX(z_index), 0) + 1 AS z FROM strokes');
      zValue = rows[0].z;
    } else if (sendToBack) {
      const { rows } = await pool.query('SELECT COALESCE(MIN(z_index), 0) - 1 AS z FROM strokes');
      zValue = rows[0].z;
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (stroke_data !== undefined) {
      sets.push(`stroke_data = $${i++}`);
      vals.push(JSON.stringify(stroke_data));
    }
    if (zValue !== undefined && zValue !== null) {
      sets.push(`z_index = $${i++}`);
      vals.push(zValue);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE strokes SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, stroke_data, z_index`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true, id: rows[0].id, z_index: rows[0].z_index });
    broadcast('update', { id: rows[0].id, stroke_data: rows[0].stroke_data, z_index: rows[0].z_index });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete any layer (object eraser / select-tool delete). No ownership check —
// the shared board lets anyone remove a layer, matching clear-all below.
app.delete('/api/strokes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM strokes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
    broadcast('undo', { id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/strokes', async (req, res) => {
  try {
    await pool.query('DELETE FROM strokes');
    res.json({ ok: true });
    broadcast('clear', {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Comment threads ---

// All threads with their replies. Threads ordered oldest-first; each thread's
// replies ordered oldest-first (the first reply is the opening comment).
app.get('/api/threads', async (req, res) => {
  try {
    const threadsQ = await pool.query(
      'SELECT id, user_id, username, x, y, anchor_stroke_id, anchor_dx, anchor_dy, created_at FROM comment_threads ORDER BY created_at ASC, id ASC'
    );
    const repliesQ = await pool.query(
      'SELECT id, thread_id, user_id, username, body, created_at FROM comment_replies ORDER BY created_at ASC, id ASC'
    );
    const byThread = new Map();
    for (const r of repliesQ.rows) {
      if (!byThread.has(r.thread_id)) byThread.set(r.thread_id, []);
      byThread.get(r.thread_id).push(r);
    }
    const threads = threadsQ.rows.map(t => ({ ...t, replies: byThread.get(t.id) || [] }));
    res.json({ threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/threads', async (req, res) => {
  const client = await pool.connect();
  try {
    const { x, y, anchor_stroke_id, anchor_dx, anchor_dy, body } = req.body;
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Comment body is required' });
    }
    if (typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ error: 'x and y are required' });
    }
    await client.query('BEGIN');
    const threadQ = await client.query(
      `INSERT INTO comment_threads (user_id, username, x, y, anchor_stroke_id, anchor_dx, anchor_dy)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, username, x, y, anchor_stroke_id, anchor_dx, anchor_dy, created_at`,
      [
        req.user.id, req.user.username, x, y,
        anchor_stroke_id != null ? anchor_stroke_id : null,
        anchor_dx != null ? anchor_dx : null,
        anchor_dy != null ? anchor_dy : null
      ]
    );
    const thread = threadQ.rows[0];
    const replyQ = await client.query(
      `INSERT INTO comment_replies (thread_id, user_id, username, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, thread_id, user_id, username, body, created_at`,
      [thread.id, req.user.id, req.user.username, body.trim()]
    );
    await client.query('COMMIT');
    const full = { ...thread, replies: [replyQ.rows[0]] };
    res.json(full);
    broadcast('thread', full);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/threads/:id/replies', async (req, res) => {
  try {
    const { body } = req.body;
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Reply body is required' });
    }
    const exists = await pool.query('SELECT id FROM comment_threads WHERE id = $1', [req.params.id]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    const { rows } = await pool.query(
      `INSERT INTO comment_replies (thread_id, user_id, username, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, thread_id, user_id, username, body, created_at`,
      [req.params.id, req.user.id, req.user.username, body.trim()]
    );
    res.json(rows[0]);
    broadcast('reply', rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/threads/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM comment_threads WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true, deleted: result.rowCount });
    if (result.rowCount > 0) {
      broadcast('thread-delete', { id: parseInt(req.params.id) });
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
    CREATE TABLE IF NOT EXISTS strokes (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      stroke_data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Explicit z-order column. Reordering must persist independently of
  // creation time, so we can't lean on created_at for stacking anymore.
  await pool.query('ALTER TABLE strokes ADD COLUMN IF NOT EXISTS z_index INTEGER');
  // Backfill existing rows so today's creation-order stacking is preserved
  // exactly on first load (id is monotonic with creation order).
  await pool.query('UPDATE strokes SET z_index = id WHERE z_index IS NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS strokes_z_idx ON strokes (z_index)');
  // Comment threads pinned to world coordinates, optionally anchored to a
  // stroke. ON DELETE SET NULL detaches a thread when its stroke is removed
  // (undo / clear) without deleting the conversation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_threads (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      x DOUBLE PRECISION NOT NULL,
      y DOUBLE PRECISION NOT NULL,
      anchor_stroke_id INTEGER REFERENCES strokes(id) ON DELETE SET NULL,
      anchor_dx DOUBLE PRECISION,
      anchor_dy DOUBLE PRECISION,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_replies (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
