const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'games.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'sql', 'schema.sql');

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db = null;
function initDb() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db = new Database(DB_PATH);
  db.exec(schema);
}
initDb();

function insertGameStmt() {
  return db.prepare(`INSERT INTO games (id, type, status, player1_id, player1_name, player2_id, player2_name, state_json, created_at, updated_at) VALUES (@id, @type, @status, @player1_id, @player1_name, @player2_id, @player2_name, @state_json, @created_at, @updated_at)`);
}
function getGameByIdStmt() { return db.prepare('SELECT * FROM games WHERE id = ?'); }
function updateGameStmt() { return db.prepare(`UPDATE games SET status = @status, player2_id = @player2_id, player2_name = @player2_name, state_json = @state_json, updated_at = @updated_at WHERE id = @id`); }
function listWaitingByTypeStmt() { return db.prepare('SELECT * FROM games WHERE status = ? AND type = ?'); }
function listWaitingAllStmt() { return db.prepare('SELECT * FROM games WHERE status = ?'); }
function listActiveGamesStmt() { return db.prepare("SELECT * FROM games WHERE status != 'finished'"); }

function insertAnimationStmt() { return db.prepare(`INSERT OR REPLACE INTO animations (label, file_id, file_type, file_unique_id, added_by, added_at) VALUES (@label, @file_id, @file_type, @file_unique_id, @added_by, @added_at)`); }
function getAnimationStmt() { return db.prepare('SELECT * FROM animations WHERE label = ?'); }
function listAnimationsStmt() { return db.prepare('SELECT * FROM animations ORDER BY label'); }

function upsertSettingStmt() { return db.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value`); }
function getSettingStmt() { return db.prepare('SELECT value FROM settings WHERE key = ?'); }

module.exports = {
  DB_PATH,
  createGame: (game) => { insertGameStmt().run(game); },
  getGame: (id) => {
    const row = getGameByIdStmt().get(id);
    if (!row) return null;
    row.state = JSON.parse(row.state_json);
    return row;
  },
  saveGame: (updates) => { updateGameStmt().run(updates); },
  findWaitingGames: (type) => { if (type) return listWaitingByTypeStmt().all('waiting', type); return listWaitingAllStmt().all('waiting'); },
  listActiveGames: () => { return listActiveGamesStmt().all(); },
  saveAnimation: ({ label, file_id, file_type, file_unique_id, added_by }) => {
    insertAnimationStmt().run({ label, file_id, file_type, file_unique_id, added_by, added_at: Date.now() });
  },
  getAnimation: (label) => { return getAnimationStmt().get(label) || null; },
  listAnimations: () => { return listAnimationsStmt().all(); },
  setSetting: (key, value) => { upsertSettingStmt().run({ key, value }); },
  getSetting: (key) => { const row = getSettingStmt().get(key); return row ? row.value : null; },
  _close: () => { try { if (db) db.close(); } catch (e) {} },
  reload: () => { try { if (db) db.close(); } catch (e) {} initDb(); }
};