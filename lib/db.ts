// lib/db.ts — เปิดฐานข้อมูล SQLite (ไฟล์ data/muverse.db) ใช้ได้เฉพาะฝั่งเซิร์ฟเวอร์ (Node runtime)
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA } from "./schema";

const g = globalThis as unknown as { muverseDb?: Database.Database };

function open(): Database.Database {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const conn = new Database(path.join(dir, "muverse.db"));
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  return conn;
}

// เก็บไว้ที่ globalThis กัน next dev เปิดไฟล์ซ้ำทุกครั้งที่ hot reload
export const db = (g.muverseDb ??= open());
