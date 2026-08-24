# Gambit

3D medieval chess game. Play solo against an AI opponent at three difficulty levels, or challenge a friend in a private match using a room code. No download, no sign-up required — runs entirely in the browser.

## Features

- 3D board with animated piece combat and a cinematic camera on every capture
- Three AI difficulty levels — from beginner to full-strength
- Private multiplayer rooms with optional passwords
- Timed and untimed matches
- Ranked games with a leaderboard and full replays

## Playing

Coming soon at [daniyalzia.co.uk/gambit](https://daniyalzia.co.uk/gambit).

## Project structure

```
client/   — Three.js frontend (Vite)
server/   — Node.js backend (Express + Socket.io)
```

## Assets

Character models in `client/public/models/` (Cleric, Monk, Rogue, Warrior, Wizard) are from Quaternius's "RPG Character Pack," [CC0 licensed](https://creativecommons.org/publicdomain/zero/1.0/) — free for personal and commercial use, no attribution required. Source: [quaternius.com](https://quaternius.com/packs/rpgcharacters.html).
