require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const { Pool } = require('pg');
const seedData = require('./seed-data');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- KONFIGURACJA ---------- */
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

const GUILD_ID = '1543543212310929498';
const REQUIRED_ROLE_ID = '1543889096408178728';
const SUPER_ADMIN_ID = '224984031471730688';

/* ---------- BAZA DANYCH POSTGRES ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        rank_min INTEGER NOT NULL DEFAULT 1,
        rank_max INTEGER NOT NULL DEFAULT 13,
        question TEXT NOT NULL,
        answer TEXT NOT NULL
      );
    `);
    
    const res = await pool.query('SELECT COUNT(*) FROM questions');
    if (parseInt(res.rows[0].count) === 0) {
      console.log('Baza pusta. Zasiewanie danymi...');
      const insertQuery = 'INSERT INTO questions (category, rank_min, rank_max, question, answer) VALUES ($1, $2, $3, $4, $5)';
      for (const q of seedData) {
        await pool.query(insertQuery, [q.category, q.rank_min, q.rank_max, q.question, q.answer]);
      }
      console.log(`Zasiano ${seedData.length} pytań.`);
    }
  } catch (err) {
    console.error('Błąd inicjalizacji bazy:', err);
  }
}
initDb();

/* ---------- MIDDLEWARE ---------- */
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);

app.use(cookieSession({
  name: 'miau_session',
  keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
  maxAge: 24 * 60 * 60 * 1000, // 24 godziny
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

app.use(express.static(path.join(__dirname, 'miau-exam', 'public')));

/* ---------- AUTORYZACJA ---------- */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.id !== SUPER_ADMIN_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

/* ---------- OAUTH2 DISCORD ---------- */
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=token_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();

    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!memberRes.ok) return res.redirect('/?error=not_in_guild');
    const member = await memberRes.json();
    
    if (!Array.isArray(member.roles) || !member.roles.includes(REQUIRED_ROLE_ID)) {
      return res.redirect('/?error=missing_role');
    }

    const isAdmin = user.id === SUPER_ADMIN_ID;
    req.session.user = {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      isAdmin
    };

    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ user: null });
  res.json({ user: req.session.user });
});

/* ---------- API PYTANIA ---------- */
app.get('/api/questions', requireAuth, async (req, res) => {
  try {
    const { category, rank } = req.query;
    let query = 'SELECT * FROM questions';
    const conds = [];
    const params = [];
    
    if (category) { conds.push(`category = $${params.length + 1}`); params.push(category); }
    if (rank) {
      conds.push(`rank_min <= $${params.length + 1} AND rank_max >= $${params.length + 2}`);
      params.push(Number(rank), Number(rank));
    }
    if (conds.length) query += ' WHERE ' + conds.join(' AND ');
    query += ' ORDER BY category, rank_min, id';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/questions', requireAdmin, async (req, res) => {
  try {
    const { category, rank_min, rank_max, question, answer } = req.body;
    const result = await pool.query(
      'INSERT INTO questions (category, rank_min, rank_max, question, answer) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [category, Number(rank_min) || 1, Number(rank_max) || 13, question, answer]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/questions/:id', requireAdmin, async (req, res) => {
  try {
    const { category, rank_min, rank_max, question, answer } = req.body;
    await pool.query(
      'UPDATE questions SET category=$1, rank_min=$2, rank_max=$3, question=$4, answer=$5 WHERE id=$6',
      [category, Number(rank_min), Number(rank_max), question, answer, Number(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/questions/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- STRONA ADMINA ---------- */
app.get('/admin', requireAuth, (req, res) => {
  if (req.session.user.id !== SUPER_ADMIN_ID) return res.redirect('/?error=no_admin');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => console.log(`🚀 Serwer działa na porcie ${PORT}`));
