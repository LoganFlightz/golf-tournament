-- Run automatically by server.js on startup

CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  course_name TEXT,
  pars INTEGER[] NOT NULL DEFAULT ARRAY[4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],
  handicaps INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18],
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  players TEXT,
  captain_code TEXT NOT NULL UNIQUE,
  handicap INTEGER DEFAULT 0,
  current_hole INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scores (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  hole INTEGER NOT NULL CHECK (hole BETWEEN 1 AND 18),
  gross INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, hole)
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  hole INTEGER,
  type TEXT NOT NULL,
  message TEXT,
  photo_data TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  password_hash TEXT NOT NULL,
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE INDEX IF NOT EXISTS idx_events_tournament ON events(tournament_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_team ON scores(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_tournament ON teams(tournament_id);
