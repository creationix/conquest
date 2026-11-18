# Conquest

A family-friendly strategy game inspired by **Lords of Conquest** (Electronic Arts, 1986), the
strategy classic of land, wealth and war. Claim territories, mine gold, iron,
coal and timber, breed horses, build weapons, boats and cities, make (and
break) deals with your family, and be the first lord with three cities.

**Play:** https://conquest.creationix.com/

- **Pass and play** on one phone, tablet or laptop.
- **Play together on Wi-Fi:** every device joins the same game. Each device
  plays the lords it claimed and watches everyone else's turns. One device can
  hold several lords, so pass-and-play and multiple devices mix freely.
- **Computer lords** fill empty seats.
- **Installable and offline:** add it to your home screen; it works without a
  network connection (single-device games).
- Synthesized **sound effects** and optional **background music** (calm modal
  tunes for peaceful phases, a march for conquest). Sound and music each have
  Off / Soft / Full.
- Runs on devices as old as an **iPad mini 4** (iPadOS 15).

## Rules

The rules follow the original EA manual: four levels (Beginner, Intermediate,
Advanced with boats, Expert with unit shipment), three chance levels, 3 to 6
cities to win, scarce/normal/plentiful resources, random maps in three sizes,
and the hand-drawn map from the 2010 version of this project. Each year runs
Development, Production, Trading, Shipment and Conquest. Battles count land,
horses (1), cities (2), weapons (3) and boats (2); third parties with forces
nearby choose a side. Open **How to play** in the game for the full summary.

Where the manual is silent, the engine picks simple defaults: when chance is
Medium or High, production, trading and shipment are each skipped 25% of the
time. You may bring one extra force per attack. Unclaimed leftover lands
defend themselves with 1 point plus 1 for each unclaimed neighbor.

## Playing on several devices

Browsers can't host games for each other, so one computer on your Wi-Fi runs
a small server (Node.js 22.18 or newer):

```bash
npm install
npm start
```

It prints addresses like `http://192.168.1.20:8080/`. Open that address on
every device and choose **Play with other devices**. One person hosts. Everyone
else joins and taps **That's me** on their lord. Seats nobody claims are
played on the host's device. The server keeps playing if a device sleeps or
reloads. Rejoin from the games list. Games are saved in `server/saves/`, so
they survive a server restart.

Pages served from a plain `http://` LAN address can't install a service
worker. Devices still play fine, and you can still add the page to the home
screen, but offline mode is only for single-device games from the public site.

## Development

```bash
npm install
npm run dev       # Vite dev server for the client (single-device games)
npm test          # engine tests, including full computer-vs-computer games
npm run build     # type-check and build to dist/
npm run serve     # LAN server for an existing build (port 8080, or --port N)
```

| Path | What |
| --- | --- |
| `src/engine/` | Pure TypeScript rules shared by browser and server: `rules.ts` (state reducer), `map.ts` (grid maps, generator, seas), `ai.ts`, `host.ts` (applies actions, paces computer turns), `protocol.ts` |
| `src/client/` | `renderer.ts` (canvas map, cached board layer, animations, pinch/pan, portrait rotation), `game-ui.ts` (HUD and phase panels), `setup-ui.ts`, `session.ts` (local and network sessions), `audio.ts` + `music.ts` (Web Audio) |
| `server/server.ts` | Static file server and WebSocket game host; Node runs the TypeScript directly |
| `public/` | Manifest, service worker, icons, CNAME |
| `legacy/` | The original 2010 prototype this grew from |

The game state is plain JSON and every change goes through
`apply(state, action)`, so the same engine runs pass-and-play in the browser
and authoritative multi-device games on the server.

### Deploying

`.github/workflows/pages.yml` tests, builds and publishes `dist/` to GitHub
Pages on every push to `master` or `main`. In the repository settings, set
**Pages → Build and deployment → Source** to **GitHub Actions** (one time).
