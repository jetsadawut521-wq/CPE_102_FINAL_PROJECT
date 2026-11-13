// lib/schema.ts — โครงสร้างตารางทั้งหมด (SQLite)
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

-- เก็บ "แฮชของ token" ไม่ใช่ token จริง ต่อให้ไฟล์ DB หลุดก็เอาไปสวมรอยไม่ได้
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ข้อมูลของผู้ใช้แต่ละคน แยกตาม key: "playlists", "history" (เก็บเป็น JSON ตรงกับที่ frontend ใช้อยู่)
CREATE TABLE IF NOT EXISTS user_data (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
`;
