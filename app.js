// WHOT Royale multiplayer server (Express + Socket.IO). All rules live in engine.js;
// this file owns rooms, sessions, timers and what each client is allowed to see.
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import { randomBytes, randomUUID } from 'node:crypto';
import { makeGame, playCard, drawTurn, removeFromGame } from './engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_PLAYERS = 6;
const MAX_CHAT = 120;

const DEFAULTS = {
  turnMs: 45_000, // time a connected player has to act before auto-draw
  disconnectedTurnMs: 8_000, // time a disconnected player's turn waits
  lobbyGraceMs: 60_000, // disconnected lobby players are removed after this
  autoStartMs: 15_000, // public rooms start this long after 2+ players are present
  chatCooldownMs: 800,
  maxEventsPerSecond: 40,
};

const makeCode = () => randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const cleanName = (n) =>
  String(n ?? 'Player').replace(/[<>\x00-\x1F]/g, '').trim().slice(0, 18) || 'Player';

export function createGameServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { cors: { origin: false } });
  const rooms = new Map();

  app.disable('x-powered-by');
  // Flat layout: serve exactly the three client files, never the server source.
  const clientFile = (file) => (_req, res) => res.sendFile(path.join(ROOT, file));
  app.get(['/', '/index.html'], clientFile('index.html'));
  app.get('/style.css', clientFile('style.css'));
  app.get('/client.js', clientFile('client.js'));
  app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

  // ---------- state shaping: each player only ever receives their own hand ----------
  function publicState(room, id) {
    const g = room.game;
    return {
      code: room.code,
      host: room.host,
      public: room.public,
      auto: room.auto,
      started: !!g,
      me: id,
      now: Date.now(),
      startsAt: room.startsAt || null,
      deadline: room.deadline || null,
      turnStart: room.turnStart || null,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        cards: g?.hands[p.id]?.length ?? 0,
        score: g?.scores[p.id] ?? 0,
      })),
      game: g
        ? {
            top: g.discard.at(-1),
            chosenShape: g.chosenShape,
            turn: room.players[g.turn]?.id,
            phase: g.phase,
            winner: g.winner,
            pending: g.pending,
            round: g.round,
            hand: g.hands[id] || [],
            drawCount: g.draw.length,
            log: g.log.slice(-8),
          }
        : null,
      chat: room.chat.slice(-25),
    };
  }

  function broadcast(room) {
    for (const p of room.players) if (p.socket) io.to(p.socket).emit('state', publicState(room, p.id));
  }

  const fail = (socket, msg) => socket.emit('errorMessage', msg);

  // ---------- timers ----------
  function clearTurnTimer(room) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.deadline = null;
  }

  function scheduleTurn(room) {
    clearTurnTimer(room);
    const g = room.game;
    if (!g || g.phase !== 'playing') return;
    const current = room.players[g.turn];
    if (!current) return;
    const ms = current.connected ? cfg.turnMs : cfg.disconnectedTurnMs;
    room.turnStart = Date.now();
    room.deadline = room.turnStart + ms;
    room.turnTimer = setTimeout(() => {
      const gg = room.game;
      if (!gg || gg.phase !== 'playing' || room.players[gg.turn]?.id !== current.id) return;
      drawTurn(gg, room.players.map((p) => p.id), current.id, current.connected ? 'ran out of time and drew' : 'was away and drew');
      update(room);
    }, ms);
    room.turnTimer.unref?.();
  }

  function scheduleAutoStart(room) {
    clearTimeout(room.startTimer);
    room.startTimer = null;
    room.startsAt = null;
    if (!room.auto || room.game || room.players.length < 2) return;
    const ms = room.players.length >= MAX_PLAYERS ? 1500 : cfg.autoStartMs;
    room.startsAt = Date.now() + ms;
    room.startTimer = setTimeout(() => {
      if (!room.game && room.players.length >= 2) startGame(room);
    }, ms);
    room.startTimer.unref?.();
  }

  function startGame(room) {
    clearTimeout(room.startTimer);
    room.startsAt = null;
    room.game = makeGame(room.players);
    update(room);
  }

  /** Call after any change: re-arm timers and push fresh state to everyone. */
  function update(room) {
    if (room.game) scheduleTurn(room);
    else scheduleAutoStart(room);
    broadcast(room);
  }

  function destroyRoom(room) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.startTimer);
    for (const p of room.players) clearTimeout(p.dropTimer);
    rooms.delete(room.code);
  }

  // ---------- players and sessions ----------
  const createPlayer = (name) => ({
    id: randomUUID(),
    token: randomBytes(24).toString('hex'),
    name: cleanName(name),
    socket: null,
    connected: false,
    dropTimer: null,
  });

  function attach(socket, room, p) {
    if (p.socket && p.socket !== socket.id) {
      const old = io.sockets.sockets.get(p.socket);
      if (old) {
        old.data = {};
        old.leave(room.code);
        old.emit('replaced', 'This session was opened on another device or tab.');
      }
    }
    clearTimeout(p.dropTimer);
    p.socket = socket.id;
    p.connected = true;
    socket.data = { id: p.id, code: room.code };
    socket.join(room.code);
    socket.emit('identity', { id: p.id, token: p.token, code: room.code });
    update(room);
  }

  function newRoom(host, isPublic) {
    let code;
    do code = makeCode();
    while (rooms.has(code));
    const room = {
      code,
      host: host.id,
      players: [host],
      game: null,
      chat: [],
      created: Date.now(),
      public: isPublic,
      auto: isPublic, // quick-match rooms auto-start so strangers aren't waiting on an idle host
      turnTimer: null,
      startTimer: null,
      deadline: null,
      startsAt: null,
    };
    rooms.set(code, room);
    return room;
  }

  const canJoin = (room) => !room.game || room.game.phase === 'finished';

  function removePlayer(room, id) {
    const index = room.players.findIndex((p) => p.id === id);
    if (index < 0) return;
    const order = room.players.map((p) => p.id);
    const [gone] = room.players.splice(index, 1);
    clearTimeout(gone.dropTimer);
    if (room.game) removeFromGame(room.game, order, id);
    if (!room.players.length) return destroyRoom(room);
    if (room.host === id) room.host = (room.players.find((p) => p.connected) || room.players[0]).id;
    update(room);
  }

  function leaveRoom(socket) {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const id = socket.data.id;
    socket.leave(room.code);
    socket.data = {};
    socket.emit('left');
    removePlayer(room, id);
  }

  // ---------- socket handlers ----------
  io.on('connection', (socket) => {
    socket.data = {};
    let windowStart = Date.now();
    let count = 0;
    // Drop floods of events from a single socket.
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > cfg.maxEventsPerSecond) return next(new Error('rate limited'));
      next();
    });
    socket.on('error', () => {});

    // Every handler gets a safe payload object and can never crash the process.
    const on = (event, handler) =>
      socket.on(event, (payload) => {
        try {
          handler(payload && typeof payload === 'object' ? payload : {}, payload);
        } catch (err) {
          console.error(`handler ${event} failed:`, err);
          fail(socket, 'Something went wrong');
        }
      });

    const inRoom = () => rooms.get(socket.data.code);

    on('create', ({ name }) => {
      if (socket.data.code) return fail(socket, 'Already in a room. Leave it first.');
      const room = newRoom(createPlayer(name), false);
      attach(socket, room, room.players[0]);
    });

    on('join', ({ code, name }) => {
      if (socket.data.code) return fail(socket, 'Already in a room. Leave it first.');
      const room = rooms.get(String(code ?? '').trim().toUpperCase());
      if (!room) return fail(socket, 'Room not found');
      if (!canJoin(room)) return fail(socket, 'Game already started. Reconnect if you were playing.');
      if (room.players.length >= MAX_PLAYERS) return fail(socket, 'Room full');
      const p = createPlayer(name);
      room.players.push(p);
      attach(socket, room, p);
    });

    on('quickJoin', ({ name }) => {
      if (socket.data.code) return fail(socket, 'Already in a room. Leave it first.');
      const open = [...rooms.values()]
        .filter((r) => r.public && !r.game && r.players.length < MAX_PLAYERS)
        .sort((a, b) => b.players.length - a.players.length)[0];
      const p = createPlayer(name);
      if (open) {
        open.players.push(p);
        attach(socket, open, p);
      } else {
        attach(socket, newRoom(p, true), p);
      }
    });

    on('reconnectPlayer', ({ code, id, token }) => {
      if (socket.data.code) return;
      const room = rooms.get(String(code ?? '').toUpperCase());
      const p = room?.players.find((x) => x.id === id && x.token === token && typeof token === 'string');
      if (!p) return fail(socket, 'Saved session expired');
      attach(socket, room, p);
    });

    on('leave', () => leaveRoom(socket));

    on('setPublic', (_p, raw) => {
      const room = inRoom();
      if (!room || room.host !== socket.data.id || room.game) return;
      room.public = raw === true;
      if (!room.public) room.auto = false;
      update(room);
    });

    on('start', () => {
      const room = inRoom();
      if (!room || room.host !== socket.data.id) return;
      if (room.game) return;
      if (room.players.length < 2) return fail(socket, 'Need at least two players');
      startGame(room);
    });

    on('play', ({ cardId, shape }) => {
      const room = inRoom();
      if (!room?.game) return fail(socket, 'Not your turn');
      const order = room.players.map((p) => p.id);
      const res = playCard(room.game, order, socket.data.id, Number(cardId), shape);
      if (!res.ok) return fail(socket, res.error);
      update(room);
    });

    on('draw', () => {
      const room = inRoom();
      if (!room?.game) return fail(socket, 'Not your turn');
      const order = room.players.map((p) => p.id);
      const res = drawTurn(room.game, order, socket.data.id);
      if (!res.ok) return fail(socket, res.error);
      update(room);
    });

    // Rematch: any seated player can deal the next round once a round is finished.
    on('nextRound', () => {
      const room = inRoom();
      const g = room?.game;
      if (!g || g.phase !== 'finished') return;
      if (room.players.length < 2) return fail(socket, 'Need at least two players');
      room.game = makeGame(room.players, g.scores, g.round + 1);
      update(room);
    });

    on('chat', (_p, raw) => {
      if (typeof raw !== 'string') return fail(socket, 'Invalid chat message');
      const now = Date.now();
      if (now - (socket.data.lastChat || 0) < cfg.chatCooldownMs) return fail(socket, 'Please wait before sending another message');
      const room = inRoom();
      const p = room?.players.find((x) => x.id === socket.data.id);
      if (!room || !p) return;
      socket.data.lastChat = now;
      const text = raw.replace(/[<>\x00-\x1F]/g, '').trim().slice(0, MAX_CHAT);
      if (!text) return;
      room.chat.push({ name: p.name, text });
      if (room.chat.length > 50) room.chat.shift();
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const room = inRoom();
      const p = room?.players.find((x) => x.id === socket.data.id);
      if (!p || p.socket !== socket.id) return;
      p.connected = false;
      p.socket = null;
      if (!room.game) {
        // In the lobby, free the seat if they don't come back soon.
        p.dropTimer = setTimeout(() => removePlayer(room, p.id), cfg.lobbyGraceMs);
        p.dropTimer.unref?.();
      } else if (room.players[room.game.turn]?.id === p.id) {
        scheduleTurn(room); // shorten the wait for an absent player
      }
      if (room.host === p.id) {
        const next = room.players.find((x) => x.connected);
        if (next) room.host = next.id;
      }
      if (!room.players.some((x) => x.connected)) {
        clearTurnTimer(room); // nobody here; the idle sweep will clean the room up
      }
      broadcast(room);
    });
  });

  // Sweep: rooms are dropped after 24h, or after 2h with nobody connected.
  const sweeper = setInterval(() => {
    for (const room of rooms.values()) {
      const idle = !room.players.some((p) => p.connected);
      const age = Date.now() - room.created;
      if (age > 24 * 3600e3 || (idle && age > 2 * 3600e3)) destroyRoom(room);
    }
  }, 600_000);
  sweeper.unref();

  return {
    app,
    http,
    io,
    rooms,
    listen: (port = process.env.PORT || 3000) =>
      new Promise((resolve) => http.listen(port, () => resolve(http.address().port))),
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        for (const room of [...rooms.values()]) destroyRoom(room);
        io.close(() => resolve());
      }),
  };
}

