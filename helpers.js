import { io } from 'socket.io-client';
import { createGameServer } from './app.js';
import { canPlay, SHAPES } from './engine.js';

export async function startServer(opts = {}) {
  const server = createGameServer(opts);
  const port = await server.listen(0);
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/** A test client that records the latest state, errors and identity. */
export function connect(url, label = 'client') {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c = {
    label,
    socket,
    state: null,
    identity: null,
    errors: [],
    states: 0,
    replaced: null,
    left: false,
    emit: (ev, payload) => socket.emit(ev, payload),
    ready: new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    }),
    /** Resolve when predicate(state) is true (checked now and on each update). */
    waitFor(pred, ms = 4000, what = 'condition') {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (c.state && pred(c.state)) {
            clearInterval(timer);
            clearTimeout(to);
            resolve(c.state);
          }
        };
        const timer = setInterval(check, 15);
        const to = setTimeout(() => {
          clearInterval(timer);
          reject(new Error(`${label}: timed out waiting for ${what}; errors=${JSON.stringify(c.errors)}`));
        }, ms);
        check();
      });
    },
    waitError(match, ms = 2000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          const hit = c.errors.find((e) => e.includes(match));
          if (hit) {
            clearInterval(timer);
            resolve(hit);
          } else if (Date.now() - t0 > ms) {
            clearInterval(timer);
            reject(new Error(`${label}: no error containing "${match}"; got ${JSON.stringify(c.errors)}`));
          }
        }, 15);
      });
    },
    close: () => socket.close(),
  };
  socket.on('state', (s) => {
    c.state = s;
    c.states++;
  });
  socket.on('identity', (i) => (c.identity = i));
  socket.on('errorMessage', (m) => c.errors.push(m));
  socket.on('replaced', (m) => (c.replaced = m));
  socket.on('left', () => {
    c.left = true;
    c.state = null;
  });
  return c;
}

export async function newClient(url, label) {
  const c = connect(url, label);
  await c.ready;
  return c;
}

/** Create a room with `n` players; returns { clients, code }. */
export async function makeRoom(url, n, prefix = 'P') {
  const host = await newClient(url, `${prefix}0`);
  host.emit('create', { name: `${prefix}0` });
  await host.waitFor((s) => s.code, 2000, 'room creation');
  const clients = [host];
  for (let i = 1; i < n; i++) {
    const c = await newClient(url, `${prefix}${i}`);
    c.emit('join', { code: host.state.code, name: `${prefix}${i}` });
    await c.waitFor((s) => s.code, 2000, `${prefix}${i} join`);
    clients.push(c);
  }
  await host.waitFor((s) => s.players.length === n, 2000, 'all players listed');
  return { clients, code: host.state.code };
}

export async function startGame(clients) {
  clients[0].emit('start');
  await Promise.all(clients.map((c) => c.waitFor((s) => s.game, 2000, 'game start')));
}

export const whoseTurn = (clients) => clients.find((c) => c.state?.game?.turn === c.state.me);

/** Pick a legal card for this client's current state, or null. */
export function legalCard(state) {
  const g = state.game;
  return g.hand.find((c) => canPlay(c, g.top, g.chosenShape)) || null;
}

/**
 * Let everyone play greedily until the round is finished. Returns when finished.
 * Calls onState(clients) after each move so tests can check invariants.
 */
export async function playToEnd(clients, { maxMoves = 2000, onState } = {}) {
  let moves = 0;
  while (moves++ < maxMoves) {
    const any = clients[0].state;
    if (any?.game?.phase === 'finished') return moves;
    const actor = whoseTurn(clients);
    if (!actor) {
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    const before = actor.states;
    const card = legalCard(actor.state);
    if (card && !actor.state.game.pending) {
      actor.emit('play', { cardId: card.id, shape: SHAPES[moves % SHAPES.length] });
    } else {
      actor.emit('draw');
    }
    // wait until this actor has seen the resulting state
    const t0 = Date.now();
    while (actor.states === before && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    if (onState) onState(clients);
  }
  throw new Error('round did not finish');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
