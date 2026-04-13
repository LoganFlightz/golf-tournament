# Golf Tournament Leaderboard

Real-time scramble tournament leaderboard. Three views:
- **`/`** Spectator view — public live leaderboard + feed
- **`/captain`** Captain view — team captains enter scores with a 6-char code
- **`/admin`** Admin view — set up tournament, add teams, edit anything

PWA enabled — visitors can "Add to Home Screen" on their phones for an app-like experience.

## Local dev

```bash
npm install
# Postgres running locally with a 'golf' db:
DATABASE_URL=postgresql://localhost:5432/golf ADMIN_PASSWORD=changeme npm start
```

Open http://localhost:3000

## Deploy to Render

### Option A: One-click via render.yaml (recommended)

1. Push this folder to a **GitHub repo**.
2. In Render: **New +** → **Blueprint** → connect the repo.
3. Render reads `render.yaml` and offers to create:
   - A web service (`golf-tournament`)
   - A Postgres database (`golf-db`, free tier)
4. When prompted, set `ADMIN_PASSWORD` to a strong password you'll remember.
5. Click **Apply**. First deploy takes ~3 min.
6. Visit your URL → go to `/admin` → log in → create tournament + add teams.

### Option B: Manual setup

1. **Create Postgres** in Render: New + → PostgreSQL → free plan → name `golf-db`.
2. Copy the **Internal Database URL**.
3. **Create Web Service** → connect repo → settings:
   - Build: `npm install`
   - Start: `node server.js`
   - Plan: **Starter ($7/mo)** so it stays warm during the tournament. Free tier sleeps after 15 min of inactivity (~30s cold start).
4. Add env vars:
   - `DATABASE_URL` = paste internal URL
   - `SESSION_SECRET` = any long random string (or click "Generate")
   - `ADMIN_PASSWORD` = your admin password
5. Deploy.

## Tournament day flow

1. **Day before:** admin logs in at `/admin`, creates tournament with course pars + handicap rankings, adds all teams. Each team gets a 6-character captain code — text/email it to the captains.
2. **During the round:** captains open `/captain` on their phones, log in once with the code (session persists 30 days), tap "Install" when prompted to add the app to their home screen. They tap their current hole, enter strokes, optionally post photos/notes.
3. **Spectators** open `/` — leaderboard updates instantly as scores come in. The "Live Feed" tab shows birdies, eagles, photos, and position changes in real time.
4. **Admin** can correct any score from `/admin` if a captain typos.

## Net scoring (scramble)

Net = gross − strokes. Each team's handicap allocates strokes to the hardest holes:
- Team handicap of 8 → 1 stroke on holes ranked 1–8 in difficulty
- Team handicap of 20 → 1 stroke on every hole + an extra stroke on holes ranked 1 and 2

The handicap **rank** per hole (1 = hardest, 18 = easiest) is set by you in admin per the course's scorecard.
