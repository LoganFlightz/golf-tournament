require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!DATABASE_URL) {
  console.error('DATABASE_URL env var required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ---------- Init ----------
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  // Seed admin password
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await pool.query(
    `INSERT INTO admin_config (id, password_hash) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [hash]
  );
  console.log('DB initialized');
}

// ---------- Middleware ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'admin auth required' });
}

// ---------- Scoring helpers ----------
// Scramble net scoring: team handicap allocates strokes to hardest holes.
// handicaps[i] is the difficulty rank (1 = hardest) of hole i+1.
function netScoreForHole(gross, holeIndex, handicaps, teamHandicap) {
  if (gross == null) return null;
  const rank = handicaps[holeIndex];
  let strokes = 0;
  if (teamHandicap >= rank) strokes += 1;
  if (teamHandicap >= rank + 18) strokes += 1; // very high handicaps
  return gross - strokes;
}

async function getLeaderboard(tournamentId) {
  const tRes = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
  if (!tRes.rows[0]) return null;
  const tournament = tRes.rows[0];

  const teamsRes = await pool.query(
    'SELECT id, name, players, handicap, current_hole FROM teams WHERE tournament_id = $1 ORDER BY id',
    [tournamentId]
  );
  const scoresRes = await pool.query(
    `SELECT s.team_id, s.hole, s.gross FROM scores s
     JOIN teams t ON t.id = s.team_id WHERE t.tournament_id = $1`,
    [tournamentId]
  );

  const scoresByTeam = {};
  for (const r of scoresRes.rows) {
    if (!scoresByTeam[r.team_id]) scoresByTeam[r.team_id] = {};
    scoresByTeam[r.team_id][r.hole] = r.gross;
  }

  const rows = teamsRes.rows.map(team => {
    const teamScores = scoresByTeam[team.id] || {};
    let grossTotal = 0, netTotal = 0, parThrough = 0, holesPlayed = 0;
    const holes = [];
    for (let i = 0; i < 18; i++) {
      const hole = i + 1;
      const gross = teamScores[hole] ?? null;
      const net = netScoreForHole(gross, i, tournament.handicaps, team.handicap);
      holes.push({ hole, gross, net, par: tournament.pars[i] });
      if (gross != null) {
        grossTotal += gross;
        netTotal += net;
        parThrough += tournament.pars[i];
        holesPlayed++;
      }
    }
    return {
      teamId: team.id,
      name: team.name,
      players: team.players,
      handicap: team.handicap,
      currentHole: team.current_hole,
      holesPlayed,
      grossTotal: holesPlayed ? grossTotal : null,
      netTotal: holesPlayed ? netTotal : null,
      toParGross: holesPlayed ? grossTotal - parThrough : null,
      toParNet: holesPlayed ? netTotal - parThrough : null,
      holes
    };
  });

  // Sort: by net to-par ascending; teams with no scores go last
  rows.sort((a, b) => {
    if (a.toParNet == null && b.toParNet == null) return 0;
    if (a.toParNet == null) return 1;
    if (b.toParNet == null) return -1;
    return a.toParNet - b.toParNet;
  });
  rows.forEach((r, i) => r.position = i + 1);

  return { tournament, teams: rows };
}

async function getEvents(tournamentId, limit = 50) {
  const r = await pool.query(
    `SELECT e.id, e.team_id, t.name as team_name, e.hole, e.type, e.message,
            CASE WHEN e.photo_data IS NOT NULL THEN true ELSE false END as has_photo,
            e.created_at
     FROM events e LEFT JOIN teams t ON t.id = e.team_id
     WHERE e.tournament_id = $1
     ORDER BY e.created_at DESC LIMIT $2`,
    [tournamentId, limit]
  );
  return r.rows;
}

function broadcast(tournamentId, eventName, payload) {
  io.to(`tournament:${tournamentId}`).emit(eventName, payload);
}

async function broadcastLeaderboard(tournamentId) {
  const lb = await getLeaderboard(tournamentId);
  broadcast(tournamentId, 'leaderboard', lb);
}

async function broadcastEvents(tournamentId) {
  const ev = await getEvents(tournamentId);
  broadcast(tournamentId, 'events', ev);
}

// ---------- Public routes ----------
app.get('/api/tournament/active', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, course_name, pars FROM tournaments WHERE active = true ORDER BY id DESC LIMIT 1');
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard/:tournamentId', async (req, res) => {
  try {
    const lb = await getLeaderboard(parseInt(req.params.tournamentId));
    if (!lb) return res.status(404).json({ error: 'not found' });
    res.json(lb);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/:tournamentId', async (req, res) => {
  try {
    res.json(await getEvents(parseInt(req.params.tournamentId)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/photo/:eventId', async (req, res) => {
  try {
    const r = await pool.query('SELECT photo_data FROM events WHERE id = $1', [parseInt(req.params.eventId)]);
    if (!r.rows[0] || !r.rows[0].photo_data) return res.status(404).end();
    const data = r.rows[0].photo_data;
    const match = data.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!match) return res.status(400).end();
    res.set('Content-Type', match[1]);
    res.set('Cache-Control', 'public, max-age=31536000');
    res.send(Buffer.from(match[2], 'base64'));
  } catch (e) { res.status(500).end(); }
});

// ---------- Captain routes ----------
app.post('/api/captain/login', async (req, res) => {
  try {
    const code = (req.body.code || '').trim().toUpperCase();
    const r = await pool.query(
      `SELECT t.id, t.name, t.tournament_id, t.handicap, t.current_hole, tour.pars
       FROM teams t JOIN tournaments tour ON tour.id = t.tournament_id
       WHERE t.captain_code = $1 AND tour.active = true`,
      [code]
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid code' });
    const team = r.rows[0];
    req.session.captainTeamId = team.id;
    const scores = await pool.query('SELECT hole, gross FROM scores WHERE team_id = $1', [team.id]);
    res.json({ team, scores: scores.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function requireCaptain(req, res, next) {
  if (req.session && req.session.captainTeamId) return next();
  res.status(401).json({ error: 'captain login required' });
}

app.post('/api/captain/score', requireCaptain, async (req, res) => {
  try {
    const teamId = req.session.captainTeamId;
    const { hole, gross } = req.body;
    if (!hole || hole < 1 || hole > 18) return res.status(400).json({ error: 'bad hole' });

    const teamRes = await pool.query('SELECT name, tournament_id, handicap FROM teams WHERE id = $1', [teamId]);
    const team = teamRes.rows[0];
    const tRes = await pool.query('SELECT pars, handicaps FROM tournaments WHERE id = $1', [team.tournament_id]);
    const { pars, handicaps } = tRes.rows[0];

    // Get prior position for movers feed
    const before = await getLeaderboard(team.tournament_id);
    const beforePos = before.teams.find(t => t.teamId === teamId)?.position;

    if (gross == null || gross === '') {
      await pool.query('DELETE FROM scores WHERE team_id = $1 AND hole = $2', [teamId, hole]);
    } else {
      const g = parseInt(gross);
      await pool.query(
        `INSERT INTO scores (team_id, hole, gross, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (team_id, hole) DO UPDATE SET gross = EXCLUDED.gross, updated_at = NOW()`,
        [teamId, hole, g]
      );

      // Generate event for notable scores
      const par = pars[hole - 1];
      const diff = g - par;
      let label = null;
      if (g === 1) label = '🎯 HOLE IN ONE';
      else if (diff <= -3) label = '🦅 Albatross';
      else if (diff === -2) label = '🦅 Eagle';
      else if (diff === -1) label = '🐦 Birdie';
      if (label) {
        await pool.query(
          `INSERT INTO events (tournament_id, team_id, hole, type, message)
           VALUES ($1, $2, $3, 'highlight', $4)`,
          [team.tournament_id, teamId, hole, `${team.name} — ${label} on hole ${hole}`]
        );
      }
    }

    // Compute new position and emit movers event
    const after = await getLeaderboard(team.tournament_id);
    const afterPos = after.teams.find(t => t.teamId === teamId)?.position;
    if (beforePos && afterPos && beforePos !== afterPos) {
      const dir = afterPos < beforePos ? 'up' : 'down';
      const delta = Math.abs(afterPos - beforePos);
      const arrow = dir === 'up' ? '▲' : '▼';
      await pool.query(
        `INSERT INTO events (tournament_id, team_id, hole, type, message)
         VALUES ($1, $2, $3, 'mover', $4)`,
        [team.tournament_id, teamId, hole, `${arrow} ${team.name} moved ${dir} ${delta} to #${afterPos}`]
      );
    }

    broadcast(team.tournament_id, 'leaderboard', after);
    await broadcastEvents(team.tournament_id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/captain/hole', requireCaptain, async (req, res) => {
  try {
    const teamId = req.session.captainTeamId;
    const hole = parseInt(req.body.hole);
    if (!hole || hole < 1 || hole > 18) return res.status(400).json({ error: 'bad hole' });
    const r = await pool.query(
      'UPDATE teams SET current_hole = $1 WHERE id = $2 RETURNING tournament_id',
      [hole, teamId]
    );
    await broadcastLeaderboard(r.rows[0].tournament_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/captain/note', requireCaptain, async (req, res) => {
  try {
    const teamId = req.session.captainTeamId;
    const { hole, message, photo } = req.body;
    const teamRes = await pool.query('SELECT name, tournament_id FROM teams WHERE id = $1', [teamId]);
    const team = teamRes.rows[0];
    const fullMsg = `${team.name}${hole ? ` (hole ${hole})` : ''}: ${message || ''}`.trim();
    await pool.query(
      `INSERT INTO events (tournament_id, team_id, hole, type, message, photo_data)
       VALUES ($1, $2, $3, 'note', $4, $5)`,
      [team.tournament_id, teamId, hole || null, fullMsg, photo || null]
    );
    await broadcastEvents(team.tournament_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/captain/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/captain/me', requireCaptain, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.name, t.tournament_id, t.handicap, t.current_hole, tour.pars
       FROM teams t JOIN tournaments tour ON tour.id = t.tournament_id
       WHERE t.id = $1`,
      [req.session.captainTeamId]
    );
    if (!r.rows[0]) { req.session.destroy(()=>{}); return res.status(401).json({ error: 'team gone' }); }
    const scores = await pool.query('SELECT hole, gross FROM scores WHERE team_id = $1', [r.rows[0].id]);
    res.json({ team: r.rows[0], scores: scores.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Admin routes ----------
app.post('/api/admin/login', async (req, res) => {
  try {
    const r = await pool.query('SELECT password_hash FROM admin_config WHERE id = 1');
    const ok = await bcrypt.compare(req.body.password || '', r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    req.session.isAdmin = true;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/admin/tournaments', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM tournaments ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/admin/tournament', requireAdmin, async (req, res) => {
  try {
    const { name, course_name, pars, handicaps } = req.body;
    if (!Array.isArray(pars) || pars.length !== 18) return res.status(400).json({ error: 'pars must be array of 18' });
    if (!Array.isArray(handicaps) || handicaps.length !== 18) return res.status(400).json({ error: 'handicaps must be array of 18' });
    await pool.query('UPDATE tournaments SET active = false');
    const r = await pool.query(
      `INSERT INTO tournaments (name, course_name, pars, handicaps, active)
       VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [name, course_name || '', pars.map(Number), handicaps.map(Number)]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/tournament/:id', requireAdmin, async (req, res) => {
  try {
    const { name, course_name, pars, handicaps, active } = req.body;
    const r = await pool.query(
      `UPDATE tournaments SET name = $1, course_name = $2, pars = $3, handicaps = $4, active = $5
       WHERE id = $6 RETURNING *`,
      [name, course_name, pars.map(Number), handicaps.map(Number), !!active, parseInt(req.params.id)]
    );
    await broadcastLeaderboard(r.rows[0].id);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

app.post('/api/admin/team', requireAdmin, async (req, res) => {
  try {
    const { tournament_id, name, players, handicap } = req.body;
    let code, attempts = 0;
    while (attempts++ < 10) {
      code = genCode();
      const exists = await pool.query('SELECT 1 FROM teams WHERE captain_code = $1', [code]);
      if (!exists.rows[0]) break;
    }
    const r = await pool.query(
      `INSERT INTO teams (tournament_id, name, players, captain_code, handicap)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [parseInt(tournament_id), name, players || '', code, parseInt(handicap) || 0]
    );
    await broadcastLeaderboard(parseInt(tournament_id));
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/team/:id', requireAdmin, async (req, res) => {
  try {
    const { name, players, handicap } = req.body;
    const r = await pool.query(
      `UPDATE teams SET name = $1, players = $2, handicap = $3 WHERE id = $4 RETURNING *`,
      [name, players, parseInt(handicap) || 0, parseInt(req.params.id)]
    );
    await broadcastLeaderboard(r.rows[0].tournament_id);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/team/:id', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING tournament_id', [parseInt(req.params.id)]);
    if (r.rows[0]) await broadcastLeaderboard(r.rows[0].tournament_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/teams/:tournamentId', requireAdmin, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM teams WHERE tournament_id = $1 ORDER BY name',
    [parseInt(req.params.tournamentId)]
  );
  res.json(r.rows);
});

app.put('/api/admin/score', requireAdmin, async (req, res) => {
  try {
    const { team_id, hole, gross } = req.body;
    if (gross == null || gross === '') {
      await pool.query('DELETE FROM scores WHERE team_id = $1 AND hole = $2', [team_id, hole]);
    } else {
      await pool.query(
        `INSERT INTO scores (team_id, hole, gross, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (team_id, hole) DO UPDATE SET gross = EXCLUDED.gross, updated_at = NOW()`,
        [team_id, hole, parseInt(gross)]
      );
    }
    const t = await pool.query('SELECT tournament_id FROM teams WHERE id = $1', [team_id]);
    await broadcastLeaderboard(t.rows[0].tournament_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Page routes ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/captain', (req, res) => res.sendFile(path.join(__dirname, 'public', 'captain.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- Sockets ----------
io.on('connection', (socket) => {
  socket.on('join', async (tournamentId) => {
    socket.join(`tournament:${tournamentId}`);
    const lb = await getLeaderboard(tournamentId);
    const ev = await getEvents(tournamentId);
    socket.emit('leaderboard', lb);
    socket.emit('events', ev);
  });
});

// ---------- Boot ----------
init().then(() => {
  server.listen(PORT, () => console.log(`Golf app on :${PORT}`));
}).catch(e => { console.error('Init failed', e); process.exit(1); });
