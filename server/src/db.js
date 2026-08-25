import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GAMBIT_DB_PATH || join(__dirname, '..', 'data', 'gambit.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ratings (
    user_id INTEGER NOT NULL,
    time_control TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1200,
    games_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, time_control),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    white_user_id INTEGER,
    black_user_id INTEGER,
    white_name TEXT NOT NULL,
    black_name TEXT NOT NULL,
    time_control TEXT NOT NULL,
    result TEXT NOT NULL,
    winner TEXT,
    moves TEXT NOT NULL,
    rated INTEGER NOT NULL DEFAULT 0,
    white_rating_before INTEGER,
    black_rating_before INTEGER,
    white_rating_after INTEGER,
    black_rating_after INTEGER,
    ended_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_user_id);
  CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_user_id);
  CREATE INDEX IF NOT EXISTS idx_ratings_tc ON ratings(time_control, elo);
`);
