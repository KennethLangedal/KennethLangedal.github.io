# Yatzy with friends

The original solitaire games and solver remain available at `/yatzy/`, `/maxi/`, and `/yahtzee/`. Online two-player games live at `/multiplayer/` and reuse the original scoring rules, including Maxi roll banking and the Yahtzee joker rule.

## Run locally

Install Node.js 22 or later, then run:

```sh
npm start
```

Open http://localhost:3000/multiplayer/, enter your name, and create a room. Send the invite link to your friend. The creator plays first; each player rolls up to three times, keeps dice, and chooses a category. Scores and dice update live on both screens. A zero is a valid score. A new game uses a new room.

If `npm` is unavailable but Node.js is installed, run `node server/index.js` instead. There are no packages to install.

For two devices on the same Wi-Fi, open the server computer's LAN address (for example `http://192.168.1.20:3000/multiplayer/`) on both devices instead of localhost. Allow inbound TCP port 3000 on your computer's firewall if needed. Invite links use the address you opened. A localhost link only works on your own computer.

## Play over the internet

GitHub Pages only serves static files, so it cannot run the multiplayer server. Deploy **this repository as a Node web service**, then both players open that service's HTTPS address. The personal homepage and the original games can also be served by that service. There is no database, account system, npm dependency, or solver dependency for multiplayer.

Use these settings on a Node-capable host:

- Runtime: Node.js 22 or later.
- Build command: none (or `npm install` if required by your host).
- Start command: `npm start`.
- Port: the server reads the host's `PORT` environment variable, defaulting to 3000.
- Instances: exactly **one**, because rooms live in memory.
- Enable HTTPS and streaming responses. A reverse proxy must allow long-running `/api/rooms/*/events` requests, disable buffering, and use a read timeout above 20 seconds. The server sends a heartbeat every 20 seconds.

After deployment, replace the `/multiplayer/` links on the GitHub Pages homepage and solo game with the deployed service's full HTTPS multiplayer URL if you want to keep the original site on GitHub Pages. The multiplayer page and its API must run on the same origin; uploading these files to GitHub Pages alone does not enable multiplayer. Do not point invites at GitHub Pages.

## Sessions and limits

- Share the room link only with your friend. Anyone holding the link can claim the second seat before they join.
- Player credentials are random, saved in the browser's local storage, and excluded from invite links and shared game state. Refreshing or reconnecting in the same browser restores the seat. Clearing browser storage loses that seat. Use separate browser profiles or devices to test two players; tabs in the same profile share the saved seat.
- The server owns dice generation, turn order, scoring, and action revisions. It rejects out-of-turn, stale, and illegal moves.
- A dropped connection disables controls and reconnects automatically. The other player can still finish their current turn. Rooms are removed after 24 hours without a move or join; a server restart or sleeping host also loses rooms. There is no durable save or automatic seat replacement.
- The server caps rooms, streams per room, request size, and mutation requests per IP. For a public high-traffic service, add infrastructure rate limiting and persistent shared storage before scaling. Avoid logging event-stream query strings, which contain player credentials.

## How multiplayer works

The original solo game's robot and expected-value hints call a separate solver configured in `shared/config.js`. Multiplayer does not call that service or require access to its source code. The browser and multiplayer server both reuse `shared/rules.js` for the existing variants.

`server/game.js` owns each room's dice, turns, and score sheets. `server/index.js` accepts player actions and broadcasts the resulting state over Server-Sent Events. `multiplayer/client.js` displays that state and sends roll, hold, and scoring requests; players cannot submit their own dice values or scores.

## Verify

```sh
npm test
```

Alternatively, run `node --test` directly.

Tests cover server-authoritative turns, scoring, complete games, variant rules, token isolation, invalid requests, rejoining, and live state delivery. For a manual check, use two browser profiles, create and join a room, keep a die, roll, score, refresh, and temporarily disconnect one browser.
