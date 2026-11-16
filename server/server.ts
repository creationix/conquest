// Conquest LAN server.
//
//   npm start            # build the app, then serve it on port 8080
//   node server/server.ts --port 9000
//
// Serves the built web app from dist/ and hosts games over WebSockets. Every
// device on the same Wi-Fi opens the printed address; each device claims one
// or more seats and acts only for those seats. The server runs the game
// engine, so it is the single source of truth and games survive reconnects
// and restarts (saved to server/saves/rooms.json).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameHost } from '../src/engine/host.ts';
import { createGame } from '../src/engine/rules.ts';
import { MAX_PLAYERS, type Action, type GameState } from '../src/engine/types.ts';
import type { ClientMessage, Lobby, RoomSummary, RoomView, ServerMessage } from '../src/engine/protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const saveDir = join(here, 'saves');
const saveFile = join(saveDir, 'rooms.json');

const args = process.argv.slice(2);
const argPort = args.indexOf('--port');
const port = Number(argPort >= 0 ? args[argPort + 1] : process.env.PORT || 8080);
const serverName = process.env.CONQUEST_NAME || hostname().replace(/\.local$/, '');

interface Room {
  id: string;
  name: string;
  host: string;
  lobby: Lobby;
  seats: Record<number, string>;
  names: Record<string, string>;
  game: GameHost | null;
  created: number;
}

interface Conn {
  ws: WebSocket;
  clientId: string;
  name: string;
  room: string | null;
}

const rooms = new Map<string, Room>();
const conns = new Set<Conn>();

// ---------------------------------------------------------------------------
// Persistence

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const data = [...rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      lobby: r.lobby,
      seats: r.seats,
      names: r.names,
      created: r.created,
      state: r.game?.state ?? null,
    }));
    try {
      await mkdir(saveDir, { recursive: true });
      await writeFile(saveFile, JSON.stringify(data));
    } catch (e) {
      console.warn('Could not save games:', (e as Error).message);
    }
  }, 500);
}

function load() {
  if (!existsSync(saveFile)) return;
  try {
    const data = JSON.parse(readFileSync(saveFile, 'utf8')) as (Omit<Room, 'game'> & { state: GameState | null })[];
    for (const r of data) {
      const room: Room = { ...r, game: null };
      if (r.state) attachGame(room, r.state);
      rooms.set(room.id, room);
    }
    console.log(`Restored ${rooms.size} game(s).`);
  } catch (e) {
    console.warn('Could not read saved games:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Rooms

function newRoomId(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let id = '';
    for (let i = 0; i < 4; i++) id += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(id)) return id;
  }
}

function attachGame(room: Room, state: GameState) {
  room.game?.stop();
  const host = new GameHost(state);
  host.subscribe((s) => {
    for (const c of conns) if (c.room === room.id) send(c, { t: 'state', state: s });
    scheduleSave();
  });
  room.game = host;
}

function view(room: Room): RoomView {
  const online = new Set([...conns].filter((c) => c.room === room.id).map((c) => c.clientId));
  const ids = new Set([...Object.values(room.seats), ...online, room.host]);
  return {
    id: room.id,
    name: room.name,
    host: room.host,
    lobby: room.lobby,
    seats: room.seats,
    clients: [...ids].map((id) => ({ id, name: room.names[id] || 'Device', online: online.has(id) })),
    state: room.game?.state ?? null,
  };
}

function summary(room: Room): RoomSummary {
  const s = room.game?.state;
  return {
    id: room.id,
    name: room.name,
    hostName: room.names[room.host] || 'Device',
    started: !!s,
    over: s?.phase === 'over',
    year: s?.year ?? 0,
    players: room.lobby.players.map((p, i) => ({ name: p.name, color: p.color, ai: p.ai, claimed: !!room.seats[i] })),
  };
}

function send(c: Conn, msg: ServerMessage) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcastRoom(room: Room) {
  const v = view(room);
  for (const c of conns) if (c.room === room.id) send(c, { t: 'room', room: v });
  broadcastList();
  scheduleSave();
}

function broadcastList() {
  const list = [...rooms.values()].sort((a, b) => b.created - a.created).map(summary);
  for (const c of conns) if (!c.room) send(c, { t: 'rooms', rooms: list });
}

function validLobby(lobby: Lobby): string | null {
  if (!lobby || !Array.isArray(lobby.players) || !lobby.settings) return 'Bad lobby';
  if (lobby.players.length < 2 || lobby.players.length > MAX_PLAYERS) return `Choose 2 to ${MAX_PLAYERS} players`;
  return null;
}

function handle(c: Conn, msg: ClientMessage) {
  const room = c.room ? rooms.get(c.room) : undefined;
  const isHost = room?.host === c.clientId;
  switch (msg.t) {
    case 'hello':
      c.clientId = String(msg.clientId).slice(0, 64);
      c.name = String(msg.name || 'Device').slice(0, 32);
      for (const r of rooms.values()) if (r.names[c.clientId] !== undefined) r.names[c.clientId] = c.name;
      send(c, { t: 'welcome', serverName });
      broadcastList();
      return;
    case 'list':
      send(c, { t: 'rooms', rooms: [...rooms.values()].map(summary) });
      return;
    case 'create': {
      const err = validLobby(msg.lobby);
      if (err) return send(c, { t: 'error', message: err });
      const r: Room = {
        id: newRoomId(),
        name: String(msg.name || `${c.name}'s game`).slice(0, 40),
        host: c.clientId,
        lobby: msg.lobby,
        seats: {},
        names: { [c.clientId]: c.name },
        game: null,
        created: Date.now(),
      };
      rooms.set(r.id, r);
      c.room = r.id;
      broadcastRoom(r);
      return;
    }
    case 'join': {
      const r = rooms.get(String(msg.room).toUpperCase());
      if (!r) return send(c, { t: 'error', message: 'That game is gone' });
      c.room = r.id;
      r.names[c.clientId] = c.name;
      broadcastRoom(r);
      return;
    }
    case 'leave': {
      c.room = null;
      send(c, { t: 'left' });
      if (room) broadcastRoom(room);
      else broadcastList();
      return;
    }
  }
  if (!room) return send(c, { t: 'error', message: 'Join a game first' });
  switch (msg.t) {
    case 'lobby': {
      if (!isHost || room.game) return send(c, { t: 'error', message: 'Only the host can change the setup' });
      const err = validLobby(msg.lobby);
      if (err) return send(c, { t: 'error', message: err });
      room.lobby = msg.lobby;
      // Drop claims on seats that no longer exist or became computer players.
      for (const k of Object.keys(room.seats)) {
        const seat = Number(k);
        if (!msg.lobby.players[seat] || msg.lobby.players[seat].ai) delete room.seats[seat];
      }
      broadcastRoom(room);
      return;
    }
    case 'claim': {
      const p = room.lobby.players[msg.seat];
      if (!p || p.ai) return send(c, { t: 'error', message: 'No such seat' });
      const holder = room.seats[msg.seat];
      if (msg.claim) {
        // A seat can move to another device; this keeps families flexible
        // (someone's phone dies, they pick up the iPad).
        room.seats[msg.seat] = c.clientId;
      } else if (holder === c.clientId || isHost) {
        delete room.seats[msg.seat];
      }
      broadcastRoom(room);
      return;
    }
    case 'start': {
      if (!isHost) return send(c, { t: 'error', message: 'Only the host can start' });
      if (room.game) return send(c, { t: 'error', message: 'Already started' });
      // Seats nobody claimed are played on the host's device (pass and play).
      room.lobby.players.forEach((p, i) => {
        if (!p.ai && !room.seats[i]) room.seats[i] = room.host;
      });
      try {
        attachGame(room, createGame(room.lobby.settings, room.lobby.players));
      } catch (e) {
        return send(c, { t: 'error', message: (e as Error).message });
      }
      broadcastRoom(room);
      return;
    }
    case 'action': {
      if (!room.game) return send(c, { t: 'error', message: 'The game has not started' });
      const action = msg.action as Action;
      const seat = action?.player;
      // A device may act for seats it claimed. Unclaimed human seats can be
      // played by anyone, so a forgotten claim never blocks the table.
      const holder = room.seats[seat];
      if (holder && holder !== c.clientId) return send(c, { t: 'error', message: 'That seat belongs to another device' });
      if (room.lobby.players[seat]?.ai) return send(c, { t: 'error', message: 'That is a computer player' });
      const error = room.game.dispatch(action);
      if (error) send(c, { t: 'error', message: error });
      return;
    }
    case 'close': {
      if (!isHost) return send(c, { t: 'error', message: 'Only the host can close the game' });
      room.game?.stop();
      rooms.delete(room.id);
      for (const other of conns) {
        if (other.room === room.id) {
          other.room = null;
          send(other, { t: 'left' });
        }
      }
      broadcastList();
      scheduleSave();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ app: 'conquest', serverName, addresses: lanAddresses() }));
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  let file = join(dist, path);
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(dist, 'index.html');
  }
  try {
    const body = await readFile(file);
    const hashed = /\/assets\//.test(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(existsSync(dist) ? 'Not found' : 'Run "npm run build" first (or "npm start").');
  }
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}/`);
  }
  return out;
}

load();
const server = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    res.writeHead(500).end();
  });
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const c: Conn = { ws, clientId: 'anon-' + Math.random().toString(36).slice(2), name: 'Device', room: null };
  conns.add(c);
  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    try {
      handle(c, msg);
    } catch (e) {
      console.error(e);
      send(c, { t: 'error', message: 'Server error' });
    }
  });
  ws.on('close', () => {
    conns.delete(c);
    const room = c.room ? rooms.get(c.room) : undefined;
    if (room) broadcastRoom(room);
  });
});
// Keep connections alive through Wi-Fi power saving.
setInterval(() => {
  for (const c of conns) if (c.ws.readyState === c.ws.OPEN) c.ws.ping();
}, 20000);

server.listen(port, () => {
  console.log(`\n  Conquest is running on "${serverName}".\n`);
  console.log(`  On this computer:  http://localhost:${port}/`);
  for (const a of lanAddresses()) console.log(`  On your Wi-Fi:     ${a}`);
  console.log('\n  Open one of these on every phone, tablet and laptop that will play.\n');
});
