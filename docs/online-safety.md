# Online Safety Act — Gambit

Dated 2026-10-21. Accountable person: Daniyal Zia (see /terms#reporting on
daniyalzia.co.uk for the site-wide reporting process and NCA/CSEA duties
that apply to every service he runs, Gambit included).

Review this document yearly, and immediately before any change that adds
user-to-user content beyond what's listed below (chat, images, free-text
beyond a 20-character display name, etc).

## What Gambit is, for this purpose

A real-time multiplayer chess game. Two strangers can be matched through
the public "Open Games" lobby list and play a game together. The only
user-generated text visible to other users is:

- A guest display name (free text, up to 20 characters, set per-game, no
  account needed) or a registered username (3-20 chars, letters/numbers/
  underscore only — can't contain spaces or most special characters).
- Nothing else. No chat, no images, no free-text bios, no comments. Moves
  are chess moves; nothing else about a game is user-authored.

This makes Gambit very probably a user-to-user service under the Online
Safety Act (ss. 9, 20, 23, 35 duties apply), but a low-risk one — there's
no channel for the kinds of content those duties mostly worry about
(grooming, CSEA material, harassment via chat), because there's no chat.
The realistic risk is confined to what a player can put in a name.

## Illegal content risk assessment

**What could happen:** a player sets an abusive, threatening, or illegal
display name (slur, harassment, impersonation, an attempt to share illegal
contact details, etc). It would be visible to their opponent during a game,
and afterwards in the public leaderboard (registered usernames only) or
match history/replay (any name, guest or registered — see
`docs/online-safety.md`'s sibling concern in the privacy section below).

**Likelihood:** low. No reach beyond the matched opponent and anyone who
later looks at that specific game's public replay link or the leaderboard
— there's no broadcast, no search, no discovery surface for names beyond
those two.

**Controls in place:**
- "Report a player or name" link (mailto, pre-filled subject) on the Play
  Online menu and the leaderboard — reports go to mail@daniyalzia.co.uk,
  reviewed by Daniyal per the site-wide `/terms#reporting` process.
- `server/scripts/moderate.mjs` — rename or delete an account, or blank a
  guest name wherever it appears in game records, in one command. See that
  file's header for usage. A report can be actioned in minutes.
- No names are automatically scanned, filtered, or blocked — every check
  is a human reviewing a report, matching the site-wide `/terms` statement
  that content isn't automatically scanned. (Optional, not done: a small
  slur blocklist for new names — would need a site-wide `/terms`
  exception for that one automated check if added later.)

## Children's access assessment

No age verification or age assurance exists anywhere in Gambit — `/terms`
states the 13+ minimum for all of Daniyal's projects, and the register
form now says so and links to it (`client/index.html`'s `#auth-legal`),
but nothing enforces it. **Children can access the service**, including
the public Open Games lobby and the ability to be matched with an adult
stranger for a chess game. Given the complete absence of a messaging
channel, the realistic harm from that match is very low (a chess game and
a name, nothing else), but the access itself is real and should be named
rather than assumed away.

## Children's risk assessment

Same conclusion as the illegal-content assessment, scoped to a child
user: the only content a child could be exposed to from another user is a
display name. No chat, no images, no way for another player to send a
child anything beyond moving chess pieces. The primary child-safety risk
in a product like this — an adult using chat to groom a child met through
matchmaking — doesn't have a vector here because there's no chat. If chat,
images, or any other user-to-user content channel is ever added, this
assessment is void until redone (see the note at the top of this file).

## What's deliberately not covered here

Private multiplayer lobbies (room code, optional password) aren't public
matchmaking — a player only ends up in one by being given the code
directly by someone they already know it from, same trust model as
sharing a phone number. The daily puzzle and AI games are single-player;
no user-to-user content there at all.
