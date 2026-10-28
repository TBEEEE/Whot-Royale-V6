// Integration tests: a real HTTP + Socket.IO server driven by real Socket.IO clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, newClient, makeRoom, startGame, whoseTurn, legalCard, playToEnd, sleep } from './helpers.js';

const closeAll = (clients) => clients.forEach((c) => c.close());

test('health endpoint and static client are served', async () => {
  const { server, url } = await startServer();
  try {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);
    const html = await (await fetch(url)).text();
    assert.match(html, /WHOT/);
  } finally {
    await server.close();
  }
});

test('two players: create, join by code, start, hands stay private', async () => {
  const { server, url } = await startServer();
  const { clients, code } = await makeRoom(url, 2);
  try {
    assert.match(code, /^[0-9A-F]{6}$/);
    await startGame(clients);
    const [a, b] = clients;
    for (const c of clients) {
      assert.equal(c.state.game.hand.length, 5);
      assert.equal(c.state.started, true);
    }
    // No client payload may contain another player's cards, tokens or the draw pile.
    for (const [me, other] of [[a, b], [b, a]]) {
      const raw = JSON.stringify(me.state);
      assert.ok(!('hands' in me.state.game), 'state must not carry all hands');
      assert.ok(!raw.includes(other.identity.token), 'other token leaked');
      assert.ok(!raw.includes(me.identity.token), 'own token should not be in broadcast state');
      const mine = new Set(me.state.game.hand.map((c) => c.id));
      for (const card of other.state.game.hand) assert.ok(!mine.has(card.id), 'hands overlap');
      for (const p of me.state.players) assert.ok(!('hand' in p) && !('token' in p));
      assert.equal(me.state.players.find((p) => p.id === other.identity.id).cards, 5);
    }
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('only the host can start and at least two players are required', async () => {
  const { server, url } = await startServer();
  const { clients } = await makeRoom(url, 2);
  try {
    clients[1].emit('start');
    await sleep(120);
    assert.equal(clients[0].state.started, false, 'non-host start must be ignored');
    const solo = await newClient(url, 'solo');
    solo.emit('create', { name: 'Solo' });
    await solo.waitFor((s) => s.code);
    solo.emit('start');
    await solo.waitError('at least two');
    solo.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('room capacity: six join, seventh is rejected', async () => {
  const { server, url } = await startServer();
  const { clients, code } = await makeRoom(url, 6);
  try {
    const seventh = await newClient(url, 'P7');
    seventh.emit('join', { code, name: 'Late' });
    await seventh.waitError('Room full');
    assert.equal(clients[0].state.players.length, 6);
    seventh.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('unknown room code and lowercase codes', async () => {
  const { server, url } = await startServer();
  const { clients, code } = await makeRoom(url, 1);
  try {
    const x = await newClient(url, 'x');
    x.emit('join', { code: 'ZZZZZZ', name: 'X' });
    await x.waitError('Room not found');
    x.emit('join', { code: code.toLowerCase(), name: 'X' });
    await x.waitFor((s) => s.code === code, 2000, 'lowercase join');
    x.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('server rejects illegal moves: out of turn, foreign card, non-matching card, WHOT without shape', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients } = await makeRoom(url, 3);
  try {
    await startGame(clients);
    const actor = whoseTurn(clients);
    const waiting = clients.find((c) => c !== actor);

    // out of turn
    waiting.emit('play', { cardId: waiting.state.game.hand[0].id, shape: 'circle' });
    await waiting.waitError('Not your turn');
    waiting.emit('draw');
    await sleep(100);
    assert.equal(actor.state.game.turn, actor.state.me, 'out-of-turn draw must not advance the turn');

    // a card that belongs to someone else
    const foreign = waiting.state.game.hand[0].id;
    actor.emit('play', { cardId: foreign, shape: 'circle' });
    await actor.waitError('Card not in your hand');

    // garbage card ids
    actor.emit('play', { cardId: 'nope' });
    actor.emit('play', { cardId: 99999 });
    await sleep(100);

    // non-matching card
    const g = actor.state.game;
    const bad = g.hand.find((c) => c.number !== 20 && c.number !== g.top.number && c.shape !== (g.chosenShape || g.top.shape));
    if (bad) {
      actor.emit('play', { cardId: bad.id });
      await actor.waitError('Card does not match');
    }
    assert.equal(actor.state.game.hand.length, 5, 'hand must be unchanged after illegal moves');
    assert.equal(actor.state.game.turn, actor.state.me);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('legal play and draw advance turns and update every client', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients } = await makeRoom(url, 3);
  try {
    await startGame(clients);
    const actor = whoseTurn(clients);
    const handBefore = actor.state.game.hand.length;
    const card = legalCard(actor.state);
    if (card) {
      actor.emit('play', { cardId: card.id, shape: 'star' });
      await Promise.all(clients.map((c) => c.waitFor((s) => s.game.top.id === card.id, 2000, 'top card update')));
      assert.equal(actor.state.game.hand.length, handBefore - 1);
    } else {
      actor.emit('draw');
      await actor.waitFor((s) => s.game.hand.length === handBefore + 1, 2000, 'draw');
    }
    // everyone sees the same shared table state
    const tops = new Set(clients.map((c) => c.state.game.top.id));
    const turns = new Set(clients.map((c) => c.state.game.turn));
    assert.equal(tops.size, 1);
    assert.equal(turns.size, 1);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('chat is synchronized, sanitized, length-limited and rate-limited', async () => {
  const { server, url } = await startServer();
  const { clients } = await makeRoom(url, 2);
  try {
    clients[0].emit('chat', '<img src=x onerror=alert(1)>hello');
    await clients[1].waitFor((s) => s.chat.length === 1, 2000, 'chat message');
    const m = clients[1].state.chat[0];
    assert.equal(m.name, 'P0');
    assert.ok(!m.text.includes('<') && !m.text.includes('>'));
    assert.match(m.text, /hello/);

    clients[0].emit('chat', 'second right away');
    await clients[0].waitError('Please wait');

    await sleep(900);
    clients[0].emit('chat', 'x'.repeat(500));
    await clients[1].waitFor((s) => s.chat.length === 2, 2000, 'long message');
    assert.ok(clients[1].state.chat[1].text.length <= 120);

    await sleep(900);
    clients[0].emit('chat', { not: 'a string' });
    await clients[0].waitError('Invalid chat');
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('malformed payloads never crash or wedge the server', async () => {
  const { server, url } = await startServer();
  const c = await newClient(url, 'fuzz');
  try {
    const junk = [null, undefined, 5, 'str', [], {}, { name: {} }, { code: [] }, { cardId: {} }, true];
    for (const ev of ['create', 'join', 'quickJoin', 'reconnectPlayer', 'setPublic', 'start', 'play', 'draw', 'nextRound', 'chat', 'leave']) {
      for (const j of junk) c.emit(ev, j);
      await sleep(50);
    }
    await sleep(100);
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);
    // and the server still works afterwards
    const d = await newClient(url, 'after');
    d.emit('create', { name: 'After' });
    await d.waitFor((s) => s.code, 2000, 'create after fuzz');
    d.close();
  } finally {
    c.close();
    await server.close();
  }
});

test('names are cleaned and trimmed', async () => {
  const { server, url } = await startServer();
  const c = await newClient(url, 'n');
  try {
    c.emit('create', { name: '  <b>Ada</b>  very long nickname that keeps going ' });
    const s = await c.waitFor((s) => s.code);
    const name = s.players[0].name;
    assert.ok(name.length <= 18 && !name.includes('<') && !name.includes('>'));
    assert.ok(name.startsWith('bAda'));
  } finally {
    c.close();
    await server.close();
  }
});

test('reconnect restores the same seat and hand; stale tokens are refused', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients, code } = await makeRoom(url, 2);
  try {
    await startGame(clients);
    const [a, b] = clients;
    const saved = { code, id: b.identity.id, token: b.identity.token };
    const handIds = b.state.game.hand.map((c) => c.id).sort();
    b.close();
    await a.waitFor((s) => s.players.find((p) => p.id === saved.id).connected === false, 2000, 'offline marker');

    const b2 = await newClient(url, 'B2');
    b2.emit('reconnectPlayer', { ...saved, token: 'wrong' });
    await b2.waitError('Saved session expired');
    b2.emit('reconnectPlayer', saved);
    await b2.waitFor((s) => s.game && s.me === saved.id, 2000, 'reconnect');
    assert.deepEqual(b2.state.game.hand.map((c) => c.id).sort(), handIds);
    await a.waitFor((s) => s.players.find((p) => p.id === saved.id).connected === true, 2000, 'online marker');
    b2.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('opening the same session twice replaces the old socket', async () => {
  const { server, url } = await startServer();
  const { clients, code } = await makeRoom(url, 2);
  try {
    const a = clients[0];
    const dup = await newClient(url, 'dup');
    dup.emit('reconnectPlayer', { code, id: a.identity.id, token: a.identity.token });
    await dup.waitFor((s) => s.me === a.identity.id);
    await sleep(100);
    assert.ok(a.replaced, 'old socket should be told it was replaced');
    dup.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('quick match pairs strangers and auto-starts without a host click', async () => {
  const { server, url } = await startServer({ autoStartMs: 300 });
  const a = await newClient(url, 'qa');
  const b = await newClient(url, 'qb');
  try {
    a.emit('quickJoin', { name: 'Ada' });
    await a.waitFor((s) => s.code);
    b.emit('quickJoin', { name: 'Bayo' });
    await b.waitFor((s) => s.code);
    assert.equal(a.state.code, b.state.code, 'quick match should land both in one room');
    assert.equal(a.state.public, true);
    await Promise.all([a, b].map((c) => c.waitFor((s) => s.game, 3000, 'auto start')));
    // started rooms are not offered to new quick-match players
    const c = await newClient(url, 'qc');
    c.emit('quickJoin', { name: 'Chi' });
    await c.waitFor((s) => s.code);
    assert.notEqual(c.state.code, a.state.code);
    c.close();
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});

test('host can list a private room for quick match', async () => {
  const { server, url } = await startServer();
  const { clients, code } = await makeRoom(url, 1);
  try {
    const q = await newClient(url, 'q');
    q.emit('quickJoin', { name: 'Q' });
    await q.waitFor((s) => s.code);
    assert.notEqual(q.state.code, code, 'private room must not be matched');
    q.close();

    clients[0].emit('setPublic', true);
    await clients[0].waitFor((s) => s.public === true);
    const q2 = await newClient(url, 'q2');
    q2.emit('quickJoin', { name: 'Q2' });
    await q2.waitFor((s) => s.code);
    assert.equal(q2.state.code, code, 'listed room should be matched');
    q2.close();

    const stranger = await newClient(url, 'stranger');
    stranger.emit('setPublic', false); // not in a room: ignored
    stranger.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('leaving the lobby transfers host; last player leaving deletes the room', async () => {
  const { server, url } = await startServer();
  const { clients, code } = await makeRoom(url, 3);
  try {
    const [host, b, c] = clients;
    host.emit('leave');
    await b.waitFor((s) => s.players.length === 2, 2000, 'player removed');
    assert.equal(b.state.host, b.identity.id, 'host should transfer to next player');
    assert.equal(host.left, true);
    b.emit('leave');
    c.emit('leave');
    await sleep(150);
    assert.equal(server.rooms.has(code), false);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('leaving mid-round returns cards, fixes turn order, and a forfeit ends a 2-player round', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients } = await makeRoom(url, 3);
  try {
    await startGame(clients);
    const leaver = clients.find((c) => c.state.game.turn !== c.state.me); // not on turn
    const rest = clients.filter((c) => c !== leaver);
    leaver.emit('leave');
    await Promise.all(rest.map((c) => c.waitFor((s) => s.players.length === 2, 2000, 'leaver removed')));
    for (const c of rest) {
      assert.ok(c.state.players.some((p) => p.id === c.state.game.turn), 'turn must point at a seated player');
      assert.equal(c.state.game.phase, 'playing');
    }
    const second = rest.find((c) => c.state.game.turn !== c.state.me);
    second.emit('leave');
    const winner = rest.find((c) => c !== second);
    await winner.waitFor((s) => s.game.phase === 'finished', 2000, 'forfeit win');
    assert.equal(winner.state.game.winner, winner.state.me);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('a disconnected player does not stall the table: their turn is auto-played', async () => {
  const { server, url } = await startServer({ disconnectedTurnMs: 250, turnMs: 60000 });
  const { clients } = await makeRoom(url, 3);
  try {
    await startGame(clients);
    const actor = whoseTurn(clients);
    const others = clients.filter((c) => c !== actor);
    const handBefore = actor.state.game.hand.length;
    const actorId = actor.state.me;
    actor.close();
    await others[0].waitFor((s) => s.game.turn !== actorId, 3000, 'turn to move on');
    assert.ok(
      others[0].state.game.log.some((l) => /was away and drew/.test(l)),
      'log should explain the skip'
    );
    const row = others[0].state.players.find((p) => p.id === actorId);
    assert.equal(row.cards, handBefore + 1);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('turn timer auto-draws for an idle connected player', async () => {
  const { server, url } = await startServer({ turnMs: 300 });
  const { clients } = await makeRoom(url, 2);
  try {
    await startGame(clients);
    const first = whoseTurn(clients);
    assert.ok(first.state.deadline > first.state.now, 'clients are told the turn deadline');
    await first.waitFor((s) => s.game.turn !== s.me, 3000, 'timeout');
    assert.ok(first.state.game.log.some((l) => /ran out of time/.test(l)));
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('six clients play a complete round with consistent shared state', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients } = await makeRoom(url, 6);
  try {
    await startGame(clients);
    let checks = 0;
    const moves = await playToEnd(clients, {
      onState: (cs) => {
        // wait for convergence is implicit: compare only clients that already saw the latest turn
        for (const c of cs) {
          const s = c.state;
          assert.equal(s.game.hand.length, s.players.find((p) => p.id === s.me).cards, 'own hand matches public count');
          assert.ok(!('hands' in s.game));
        }
        checks++;
      },
    });
    assert.ok(moves > 6, 'a real round takes several moves');
    await sleep(100);
    const winnerIds = new Set(clients.map((c) => c.state.game.winner));
    assert.equal(winnerIds.size, 1, 'all clients agree on the winner');
    const winnerId = [...winnerIds][0];
    const winner = clients.find((c) => c.state.me === winnerId);
    assert.equal(winner.state.game.hand.length, 0);
    const pts = winner.state.players.find((p) => p.id === winnerId).score;
    const expected = clients.filter((c) => c !== winner).reduce((s, c) => s + c.state.game.hand.reduce((x, k) => x + k.number, 0), 0);
    assert.equal(pts, expected, 'winner scores the value of opponents\' remaining cards');
    assert.ok(checks > 0);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('rematch deals a new round, keeps scores, and a late joiner can sit in between rounds', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients, code } = await makeRoom(url, 3);
  try {
    await startGame(clients);
    await playToEnd(clients);
    await sleep(100);
    const winnerId = clients[0].state.game.winner;
    const scoreBefore = clients[0].state.players.find((p) => p.id === winnerId).score;
    assert.ok(scoreBefore > 0);

    const late = await newClient(url, 'late');
    late.emit('join', { code, name: 'Late' });
    await late.waitFor((s) => s.code === code, 2000, 'join between rounds');
    clients.push(late);

    // any seated player (not only the host) may start the rematch
    clients[2].emit('nextRound');
    await Promise.all(clients.map((c) => c.waitFor((s) => s.game.round === 2 && s.game.phase === 'playing', 2000, 'round 2')));
    for (const c of clients) assert.equal(c.state.game.hand.length, 5);
    assert.equal(clients[0].state.players.find((p) => p.id === winnerId).score, scoreBefore, 'scores persist');
    assert.equal(clients[0].state.players.length, 4);
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('players cannot join a round already in progress', async () => {
  const { server, url } = await startServer({ turnMs: 60000 });
  const { clients, code } = await makeRoom(url, 2);
  try {
    await startGame(clients);
    const late = await newClient(url, 'late');
    late.emit('join', { code, name: 'Late' });
    await late.waitError('already started');
    late.close();
  } finally {
    closeAll(clients);
    await server.close();
  }
});

test('event flooding from one socket is rate limited, other players unaffected', async () => {
  const { server, url } = await startServer({ turnMs: 60000, maxEventsPerSecond: 20 });
  const { clients } = await makeRoom(url, 2);
  try {
    for (let i = 0; i < 200; i++) clients[0].emit('draw');
    await sleep(200);
    clients[1].emit('chat', 'still here');
    await clients[0].waitFor((s) => s.chat.length === 1, 2000, 'other player chat');
  } finally {
    closeAll(clients);
    await server.close();
  }
});
