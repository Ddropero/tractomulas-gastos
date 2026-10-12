-- ============================================================
-- Tractomulas Gastos - Auth schema (users + sessions)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  totp_secret    TEXT,
  totp_verified  INTEGER DEFAULT 0,
  nombre         TEXT,
  rol            TEXT DEFAULT 'admin',
  activo         INTEGER DEFAULT 1,
  creado_en      TEXT DEFAULT (datetime('now')),
  ultimo_login   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  tipo         TEXT DEFAULT 'full',
  expires_at   TEXT NOT NULL,
  creado_en    TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
