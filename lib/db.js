import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(config.dataDir, 'zammad-mobile.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,           -- Zammad-User-ID
    login TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    token_enc TEXT NOT NULL,
    token_id INTEGER,                 -- von der App erstellter Zammad-Token (zum Widerrufen)
    last_notif_id INTEGER NOT NULL DEFAULT 0,
    prefs TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,              -- sha256 des Cookie-Werts
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    keys TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
`);

export function getMeta(k) {
  return db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v;
}

export function setMeta(k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export const DEFAULT_PREFS = {
  types: {
    create: true,
    update: true,
    reminder_reached: true,
    escalation: true,
    escalation_warning: true,
  },
};

export function readPrefs(user) {
  let p = {};
  try { p = JSON.parse(user.prefs || '{}'); } catch { p = {}; }
  return { ...DEFAULT_PREFS, ...p, types: { ...DEFAULT_PREFS.types, ...(p.types || {}) } };
}
