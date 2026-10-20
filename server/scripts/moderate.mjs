#!/usr/bin/env node
// Takedown tool — see docs/online-safety.md. Run from server/ with
// `node scripts/moderate.mjs <command> ...args`. Uses the same db.js as the
// running server, so point GAMBIT_DB_PATH at the right file if this isn't
// run from the server's own directory (e.g. on the homelab).
//
// Commands:
//   rename-user <oldUsername> <newUsername>
//     Renames the account AND every past game record that names them
//     (white_name/black_name in games), so the old name doesn't linger in
//     match history/replays after a rename.
//   delete-user <username>
//     Deletes the account, its ratings and puzzle-solve history. Past games
//     are kept (deleting them would also break the opponent's own history),
//     but that seat's name is blanked to "[deleted user]" and unlinked from
//     the account (so it drops out of anything keyed on user id).
//   blank-guest-name <exact name>
//     Blanks a guest (no account) name to "[removed]" in every game where
//     it appears — only touches seats with no user_id, never a real account
//     (use rename-user/delete-user for those).
//
// Every command prints exactly what it changed before exiting. Names must
// match exactly — this doesn't do partial/fuzzy matching, so it can't
// accidentally touch more than intended.

import { db } from '../src/db.js';

function usageAndExit() {
  console.error(`Usage:
  node scripts/moderate.mjs rename-user <oldUsername> <newUsername>
  node scripts/moderate.mjs delete-user <username>
  node scripts/moderate.mjs blank-guest-name <exact name>`);
  process.exit(1);
}

function getUser(username) {
  return db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
}

function renameUser(oldUsername, newUsername) {
  const user = getUser(oldUsername);
  if (!user) { console.error(`No account named "${oldUsername}".`); process.exit(1); }
  if (getUser(newUsername)) { console.error(`"${newUsername}" is already taken.`); process.exit(1); }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newUsername, user.id);
    const w = db.prepare('UPDATE games SET white_name = ? WHERE white_user_id = ?').run(newUsername, user.id);
    const b = db.prepare('UPDATE games SET black_name = ? WHERE black_user_id = ?').run(newUsername, user.id);
    db.exec('COMMIT');
    console.log(`Renamed "${oldUsername}" -> "${newUsername}".`);
    console.log(`Updated ${w.changes} game(s) as White and ${b.changes} game(s) as Black.`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function deleteUser(username) {
  const user = getUser(username);
  if (!user) { console.error(`No account named "${username}".`); process.exit(1); }

  db.exec('BEGIN IMMEDIATE');
  try {
    const w = db.prepare('UPDATE games SET white_name = ?, white_user_id = NULL WHERE white_user_id = ?').run('[deleted user]', user.id);
    const b = db.prepare('UPDATE games SET black_name = ?, black_user_id = NULL WHERE black_user_id = ?').run('[deleted user]', user.id);
    db.prepare('DELETE FROM puzzle_solves WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM ratings WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    db.exec('COMMIT');
    console.log(`Deleted account "${username}" (id ${user.id}), its ratings and puzzle history.`);
    console.log(`Blanked and unlinked ${w.changes} game(s) as White and ${b.changes} game(s) as Black.`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function blankGuestName(name) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const w = db.prepare('UPDATE games SET white_name = ? WHERE white_name = ? AND white_user_id IS NULL').run('[removed]', name);
    const b = db.prepare('UPDATE games SET black_name = ? WHERE black_name = ? AND black_user_id IS NULL').run('[removed]', name);
    db.exec('COMMIT');
    console.log(`Blanked guest name "${name}" in ${w.changes} game(s) as White and ${b.changes} game(s) as Black.`);
    if (w.changes === 0 && b.changes === 0) console.log('(No matching guest-seat games found — check the name is exact.)');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === 'rename-user' && args.length === 2) renameUser(...args);
else if (command === 'delete-user' && args.length === 1) deleteUser(...args);
else if (command === 'blank-guest-name' && args.length === 1) blankGuestName(args[0]);
else usageAndExit();
