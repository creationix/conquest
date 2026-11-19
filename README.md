# Conquest

A family-friendly strategy game inspired by **Lords of Conquest** (Electronic Arts, 1986), the
strategy classic of land, wealth and war. Claim territories, mine gold, iron,
coal and timber, breed horses, build weapons, boats and cities, make (and
break) deals with your family, and be the first lord with three cities.

**Play:** https://conquest.creationix.com/

- **Pass and play** on one phone, tablet or laptop.
- **Play on several devices:** one device taps **Host a game** and gets a
  four-letter code; the others tap **Join a game** and enter it. Each device
  plays the lords it claimed and watches everyone else's turns. One device can
  hold several lords, so pass-and-play and multiple devices mix freely. No
  server to set up.
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

One device hosts: it keeps the official copy of the game and relays it to the
others. Devices find each other through the free public
[PeerJS](https://peerjs.com/) signaling service using the game code, then talk
directly over WebRTC, or through a relay when a network blocks direct
connections. Only the introductions go through the signaling service; game
traffic is device to device. An internet connection is needed to connect.

Devices come and go freely:

- **Join any time** with the code (it is also in the in-game menu). A newcomer
  can take over a computer lord or the lord of a device that dropped off.
- **Never stuck:** if a device drops off, the game waits about 25 seconds and
  then the computer plays that lord's turns until the device comes back (or
  someone else takes the lord over).
- **Leave** from the menu: your lords go to the computer.
- The **host** can hand any lord to the computer, remove a device, or **make
  another device the host**. If the host leaves, hosting moves to another
  device; if the host's device vanishes, another device takes over by itself.
- Every device keeps a copy of the game. If everyone leaves, any of them can
  bring it back with **Continue network game** on the home screen, same code.

See [docs/network.md](docs/network.md) for the design.

To use your own signaling server instead of the public one, run a PeerJS
server (`npm run signal` starts one on port 9000) and open the game with
`?signal=your-host:9000`.

## Development

```bash
npm install
npm run dev       # Vite dev server for the client (single-device games)
npm test          # engine tests, including full computer-vs-computer games
npm run build     # type-check and build to dist/
npm run preview   # serve the build (port 8080)
npm run signal    # local PeerJS signaling server (port 9000), for testing
```

| Path | What |
| --- | --- |
| `src/engine/` | Pure TypeScript rules shared by browser and server: `rules.ts` (state reducer), `map.ts` (grid maps, generator, seas), `ai.ts`, `host.ts` (applies actions, paces computer turns), `protocol.ts` |
| `src/net/` | `room.ts` (the shared room of a network game and its permission rules, pure), `net.ts` (WebRTC runtime: hosting, joining, heartbeats, autopilot, handoff and failover) |
| `src/client/` | `renderer.ts` (canvas map, cached board layer, animations, pinch/pan, portrait rotation), `game-ui.ts` (HUD and phase panels), `setup-ui.ts`, `session.ts` (local and network sessions), `audio.ts` + `music.ts` (Web Audio) |
| `public/` | Manifest, service worker, icons, CNAME |
| `legacy/` | The original 2010 prototype this grew from |

The game state is plain JSON and every change goes through
`apply(state, action)`, so the same engine runs pass-and-play and, on the host's device,
multi-device games for everyone.

### Deploying

`.github/workflows/pages.yml` tests, builds and publishes `dist/` to GitHub
Pages on every push to `master` or `main`. In the repository settings, set
**Pages → Build and deployment → Source** to **GitHub Actions** (one time).
