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

const USER_AGENT = 'MIAU-Exam-Panel/1.0 (+https://panel-miau.onrender.com)';

/* ---------- ROTACJA HOSTÓW DISCORD ---------- */
const DISCORD_HOSTS = [
  'https://discord.com',
  'https://canary.discord.com',
  'https://ptb.discord.com'
];

/* ---------- FUNKCJA fetch z rotacją hostów i backoffem ---------- */
async function fetchDiscord(endpoint, options = {}, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const host = DISCORD_HOSTS[attempt % DISCORD_HOSTS.length];
    const url = `${host}${endpoint}`;
    
    try {
      console.log(`🌐 Próba ${attempt + 1}/${maxRetries}: ${url}`);
      
      const response = await fetch(url, options);
      
      // Sukces
      if (response.ok || response.status < 500) {
        return response;
      }
      
      // Błąd 429 (rate limit) - sprawdź nagłówek Retry-After
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') || 
                          response.headers.get('x-ratelimit-reset-after') || 
                          '5';
        const waitTime = parseInt(retryAfter) * 1000;
        
        console.warn(`⚠️ Rate limit (429). Czekam ${waitTime}ms przed kolejną próbą...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        lastError = response;
        continue;
      }
      
      // Inne błędy 4xx - zwróć od razu
      return response;
      
    } catch (err) {
      console.error(`❌ Błąd sieci (próba ${attempt + 1}):`, err.message);
      lastError = err;
      
      // Krótka przerwa przed kolejną próbą
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  throw lastError || new Error('Wszystkie próby połączenia z Discord API nie powiodły się');
}

/* ---------- DEBUG ENV ---------- */
console.log('=== DEBUG ENV ===');
console.log('CLIENT_ID:', CLIENT_ID ? CLIENT_ID.slice(0, 6) + '...' : 'BRAK ❌');
console.log('CLIENT_SECRET:', CLIENT_SECRET ? 'USTAWIONE ✅' : 'BRAK ❌');
console.log('REDIRECT_URI:', REDIRECT_URI || 'BRAK ❌');
console.log('SESSION_SECRET:', process.env.SESSION_SECRET ? 'USTAWIONE ✅' : 'BRAK ❌');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'USTAWIONE ✅' : 'BRAK ❌');
console.log('=================');

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
      console.log(`✅ Zasiano ${seedData.length} pytań.`);
    } else {
      console.log(`✅ Baza już zawiera ${res.rows[0].count} pytań.`);
    }
  } catch (err) {
    console.error('❌ Błąd inicjalizacji bazy:', err.message);
  }
}
initDb();

/* ---------- MIDDLEWARE ---------- */
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);

app.use(cookieSession({
  name: 'miau_session',
  keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
  maxAge: 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

app.use(express.static(path.join(__dirname, 'public')));

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
    /* ---------- 1. WYMIANA KODU NA TOKEN ---------- */
    console.log('=== TOKEN EXCHANGE - START ===');

    const tokenRes = await fetchDiscord('/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    const rawText = await tokenRes.text();
    console.log('Status:', tokenRes.status);
    console.log('Content-Type:', tokenRes.headers.get('content-type'));
    console.log('Body (first 500 chars):', rawText.slice(0, 500));

    let tokenData;
    try {
      tokenData = JSON.parse(rawText);
    } catch (e) {
      console.error('❌ Nie udało się sparsować odpowiedzi jako JSON');
      return res.redirect('/?error=token_failed');
    }

    if (!tokenData.access_token) {
      console.error('❌ Brak access_token w odpowiedzi:', tokenData);
      return res.redirect('/?error=token_failed');
    }
    console.log('✅ Token uzyskany');

    /* ---------- 2. POBIERANIE DANYCH UŻYTKOWNIKA ---------- */
    const userRes = await fetchDiscord('/api/v10/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });

    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error('❌ Błąd pobierania danych użytkownika:', userRes.status, errText.slice(0, 300));
      return res.redirect('/?error=auth_failed');
    }
    const user = await userRes.json();
    console.log('✅ Pobrano użytkownika:', user.username, `(${user.id})`);

    /* ---------- 3. WERYFIKACJA CZŁONKOSTWA I ROLI ---------- */
    const memberRes = await fetchDiscord(
      `/api/v10/users/@me/guilds/${GUILD_ID}/member`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'Accept': 'application/json',
          'User-Agent': USER_AGENT
        }
      }
    );

    if (!memberRes.ok) {
      const errText = await memberRes.text();
      console.warn(`⚠️ User ${user.id} nie należy do gildii ${GUILD_ID} (status ${memberRes.status})`);
      console.warn('Body:', errText.slice(0, 200));
      return res.redirect('/?error=not_in_guild');
    }

    const member = await memberRes.json();
    console.log('Role użytkownika:', member.roles);

    if (!Array.isArray(member.roles) || !member.roles.includes(REQUIRED_ROLE_ID)) {
      console.warn(`⚠️ User ${user.id} nie ma wymaganej roli ${REQUIRED_ROLE_ID}`);
      return res.redirect('/?error=missing_role');
    }

    /* ---------- 4. SUKCES - ZAPIS SESJI ---------- */
    const isAdmin = user.id === SUPER_ADMIN_ID;
    req.session.user = {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      isAdmin
    };

    console.log(`✅ Zalogowany: ${user.username} (${user.id}) admin=${isAdmin}`);
    res.redirect('/');
  } catch (err) {
    console.error('=== OAUTH AUTH FAILED ===');
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
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

    if (category) {
      conds.push(`category = $${params.length + 1}`);
      params.push(category);
    }
    if (rank) {
      conds.push(`rank_min <= $${params.length + 1} AND rank_max >= $${params.length + 2}`);
      params.push(Number(rank), Number(rank));
    }
    if (conds.length) query += ' WHERE ' + conds.join(' AND ');
    query += ' ORDER BY category, rank_min, id';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('API questions error:', err.message);
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
    console.error('API add question error:', err.message);
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
    console.error('API update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/questions/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('API delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/questions/export', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT category, rank_min, rank_max, question, answer FROM questions');
    res.setHeader('Content-Disposition', 'attachment; filename="questions.json"');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/questions/import', requireAdmin, async (req, res) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Oczekiwano tablicy' });
    for (const r of rows) {
      await pool.query(
        'INSERT INTO questions (category, rank_min, rank_max, question, answer) VALUES ($1, $2, $3, $4, $5)',
        [r.category, r.rank_min ?? 1, r.rank_max ?? 13, r.question, r.answer]
      );
    }
    res.json({ ok: true, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- STRONA ADMINA ---------- */
app.get('/admin', requireAuth, (req, res) => {
  if (req.session.user.id !== SUPER_ADMIN_ID) return res.redirect('/?error=no_admin');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* ---------- START ---------- */
app.listen(PORT, () => {
  console.log(`🚀 Serwer działa na porcie ${PORT}`);
  console.log(`🌍 URL: https://panel-miau.onrender.com`);
});
