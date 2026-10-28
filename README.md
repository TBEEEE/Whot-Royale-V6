# WHOT Royale v0.5

Real-time Nigerian WHOT for 2–6 players. No accounts, no installs: open the link, pick a nickname, share a room code.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm test        # 51 tests: rules, and multiplayer over real Socket.IO connections
npm start       # http://localhost:3000
```

Open the page in two or more browser windows (or phones on the same Wi-Fi using your computer's address) to play.

## Deploy (free, ~10 minutes)

Use a host that keeps a Node process running, such as **Render** or **Railway**. Serverless hosts (Vercel, Netlify) are not suitable: Socket.IO needs a long-lived server.

1. Create a free GitHub account and a new empty repository.
2. Upload every file in this folder to it (all files are at the top level; no folders).
3. On https://render.com choose **New → Blueprint**, connect the repository. `render.yaml` sets everything up. (Manual setup: Web Service, build `npm ci --omit=dev`, start `npm start`, health check `/health`.)
4. When the deploy finishes you get an `https://….onrender.com` address. That is your public game link.
5. Keep **one instance**. Rooms are held in memory, so scaling to several instances would split players across servers.

Render's free tier sleeps after ~15 minutes without visitors, and the first load afterwards takes about 30–60 seconds. Open the link once shortly before a demo or judging. Restarting the server ends games in progress.

### Check the live site

```bash
npm i -D playwright && npx playwright install chromium
node browser.cjs https://your-game.onrender.com
```

This opens three independent browser sessions (two desktop, one phone-sized), plays a full round through the real page, reloads one player mid-round, runs a rematch and checks chat. Screenshots go to `shots`.

## How it plays

- 2–6 players, five cards each, clockwise. Match the top card's shape or number. If you can't or don't want to play, draw one card and your turn ends.
- **1 Hold On**: play again. **2 Pick Two**: next player draws 2 and loses their turn. **5 Pick Three**: next player draws 3 and loses their turn. **8 Suspension**: next player is skipped. **14 General Market**: everyone else draws 1. **20 WHOT**: wild; you choose the next shape.
- First to empty their hand wins the round and scores the value of everyone else's remaining cards (WHOT counts 20). Scores carry across rounds. Any player can start the next round.
- This is a house variant: no stacking of Pick Two/Three. Rules differ between families; they live in `engine.js`.

## Features

- Private rooms by 6-character code or invite link (`/?room=CODE`).
- **Quick match**: strangers are paired into a public room that starts automatically 15 s after two players are present (immediately at six). The host of a private room can also list it for quick match.
- Reconnection: a refresh or dropped connection returns you to your seat and hand. A player who is away has their turn auto-played after 8 s; an idle connected player after 45 s (`TURN_SECONDS`).
- Leaving mid-round returns your cards to the pile; if only one player is left they win by forfeit.
- Live chat with quick replies, synthesised sound effects (no audio files), turn timer, scoreboard, responsive layout for phones, tablets and desktops.

## Architecture and security

- Flat layout (no folders, so it uploads to GitHub from a browser): `engine.js` pure rules; `app.js` rooms, sessions, timers, Socket.IO; `server.js` entry point; `index.html`, `style.css`, `client.js` the browser client; `*.test.js` and `helpers.js` the tests; `browser.cjs` the real-browser check.
- The server is authoritative: every move is validated server-side, and each player is only ever sent their own hand (other players' card counts only). Tests assert this.
- Malformed or hostile events cannot crash the server (v0.4 could be crashed by a single `join` with a `null` payload); per-socket flood limiting; chat is length-limited, rate-limited and rendered as text.
- Identity is a random per-browser token in localStorage (not an account). Anyone holding the token can resume that seat.

## Tests

| Suite | What it covers |
|---|---|
| `engine.test.js`, `security.test.js` | Deck integrity, card conservation (from v0.4) |
| `rules.test.js` | Every action card, WHOT shape choice, illegal moves, scoring, pile rebuild, leaving, 40 random full games |
| `multiplayer.test.js` | Real server + real Socket.IO clients: create/join, 6-player capacity, hidden hands, illegal moves, chat, malformed input, reconnection, quick match, host transfer, leave/forfeit, disconnect and idle timers, a complete 6-client round, rematch |
| `browser.cjs` | Real browsers (see above) |

## Known limitations

- State is in memory (see deployment note). Add Redis and the Socket.IO Redis adapter before running more than one instance.
- Not yet checked on physical iOS/Android devices. The phone check so far is an emulated 390×844 touch browser.
- Quick match is first-available matching, not skill-based. No spectators, no accounts, no chat moderation beyond the limits above.
- Card artwork is drawn in code (vector shapes); it does not use a separate artwork sheet.
