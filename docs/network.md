# Network play: architecture

Goals, in order:

1. **Never stuck.** A device that sleeps, crashes or walks away must not stop
   the game for everyone else.
2. **Lords are not devices.** Any lord can be played by a device at the table,
   by the computer, or by nobody yet; this can change at any time.
3. **Come and go freely.** Devices can join at any time (with the game code),
   take over a lord, give it up, or leave.
4. **No special device.** The host is just whichever device currently keeps the
   official copy of the game. Hosting can be handed to another device, and if
   the host disappears another device takes over automatically.
5. **Nothing to set up.** A four-letter code, no server of our own.

## Pieces

```
 ┌──────────── UI (GameScreen, lobby) ────────────┐
 │  NetSession: state, controls(seat), dispatch    │
 └───────────────────────┬─────────────────────────┘
                         │ intents / snapshots
 ┌───────────────────────┴─────────────────────────┐
 │ NetGame (runtime): host role or client role,    │
 │ switches role on handoff / failover, persists   │
 │ the latest snapshot, runs computer turns (host) │
 └───────────────────────┬─────────────────────────┘
                         │
 ┌───────────────────────┴─────────────────────────┐
 │ Room (pure): devices, seats, game, rev/epoch,   │
 │ reduce(room, from, intent) → room | error       │
 └───────────────────────┬─────────────────────────┘
                         │
 ┌───────────────────────┴─────────────────────────┐
 │ Channel: PeerJS signaling + WebRTC data channel,│
 │ chunked JSON, heartbeats every 2 s              │
 └─────────────────────────────────────────────────┘
```

### Room (`src/net/room.ts`, pure, tested in `tests/room.test.ts`)

The whole shared world is one JSON value:

- `code`: the four-letter game code.
- `host`: the device id that currently hosts; `epoch` counts host changes.
- `rev`: increases with every change. Snapshots are ordered by
  `(epoch, rev)`; a device ignores anything older than what it has.
- `devices`: every device that has joined, in join order (this is also the
  succession order), with its name and whether it is online.
- `seats`: one controller per lord: `device <id>`, `computer` or `open`.
- `lobby`: the setup (players and rules) and `game`: the engine state.

All changes go through `reduce(room, fromDevice, intent)`, which checks
permissions, so the rules live in one tested place:

| Intent | Who | Effect |
| --- | --- | --- |
| `setup` | host, before start | change players and rules |
| `start` | host | create the game; open human seats go to the host |
| `seat me` | anyone | take a lord that is computer, open, or whose device is offline (the host may take any lord) |
| `seat computer` / `seat open` | the lord's device, or the host | give the lord to the computer / free it |
| `action` | the device controlling that lord | a game move |
| `kick` | host | remove a device; its lords go to the computer |
| `handoff` | host | make another online device the host |
| `leave` | anyone | leave; your lords go to the computer |

The engine's per-player `ai` flag always mirrors "seat is `computer`".

### Liveness

WebRTC does not reliably report a device that vanished (phone locked, tab
killed). So everyone sends a tiny heartbeat every 2 seconds:

- The host marks a device **offline** after 7 s of silence.
- A client considers the **host lost** after 7 s of silence.

### Never stuck: autopilot

When the game waits on a lord whose device is offline (or that is open),
the host shows who it is waiting for. After 25 seconds the computer plays
**that turn** for them (autopilot). The seat stays theirs: when the device
comes back it simply continues. The host (or a newcomer taking the seat) can
also act at once.

### Hosting, handoff and failover

- The host's device registers the code with the signaling service
  (`conquest-v2-<CODE>`), so connecting to the code always reaches the
  current host.
- Every device keeps the latest snapshot (in memory and in local storage),
  so **any device can become the host** without losing the game.
- **Handoff** (planned): the host sends `handoff` to everyone, naming the new
  host and including the latest snapshot. The old host releases the code; the
  new host claims it and bumps `epoch`; everyone else reconnects to the code
  and lands on the new host.
- **Failover** (host vanished): each client waits, ranked by succession order
  among devices still online: the first waits ~2 s, the next 15 s longer, and
  so on, then tries to claim the code. If the code is still taken (the old host
  is still registered, or another device won), it reconnects as a client. The
  new host marks the old host offline; its lords go on autopilot until it
  returns. A returning old host finds the code taken, joins as a client and
  adopts the newer snapshot.
- **Everyone left**: any device can reopen the game from its saved snapshot
  ("Continue network game") and becomes the host with the same code.

### Runtime and channel (`src/net/net.ts`)

One `NetGame` per device, in the host role or the client role, switching on
handoff and failover. PeerJS for signaling (free public service, or
`?signal=host:port`), WebRTC data channels for traffic (with PeerJS's relay
fallback), JSON messages split into 15 KB pieces for older Safari, and the
heartbeat. The host also runs the autopilot: once it has played a turn for an
absent lord, it keeps playing that lord at computer pace until its device is
back. `?fastnet` shortens the waits for automated tests.

## Limits

- At most the move in flight when a host vanishes can be lost.
- Failover after a crash waits until the signaling service releases the old
  host's registration (usually seconds, up to about a minute).
- An internet connection is needed to connect devices; single-device games
  work offline.
