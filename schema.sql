-- Games table
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  player1_id TEXT NOT NULL,
  player1_name TEXT,
  player2_id TEXT,
  player2_name TEXT,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Animations table
CREATE TABLE IF NOT EXISTS animations (
  label TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_unique_id TEXT,
  added_by TEXT,
  added_at INTEGER NOT NULL
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);