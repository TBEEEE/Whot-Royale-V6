// Deterministic rule tests: every action card, on hand-built game states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGame, playCard, drawTurn, removeFromGame, score } from './engine.js';

const C = (id, shape, number) => ({ id, shape, number });

/** Build a game with exact hands and top card. */
function setup(ids, hands, top, { turn = 0 } = {}) {
  const g = makeGame(ids.map((id) => ({ id, name: id.toUpperCase() })));
  ids.forEach((id, i) => (g.hands[id] = hands[i]));
  g.discard = [top];
  g.draw = Array.from({ length: 30 }, (_, i) => C(100 + i, 'star', 1 + (i % 7)));
  g.turn = turn;
  return g;
}
const filler = (base) => [C(base, 'square', 13), C(base + 1, 'square', 11)];

test('normal card: matches shape, passes turn clockwise', () => {
  const g = setup(['a', 'b', 'c'], [[C(1, 'circle', 4), ...filler(2)], filler(10), filler(20)], C(50, 'circle', 7));
  const r = playCard(g, ['a', 'b', 'c'], 'a', 1);
  assert.equal(r.ok, true);
  assert.equal(g.turn, 1);
  assert.equal(g.discard.at(-1).id, 1);
});

test('number match works across shapes', () => {
  const g = setup(['a', 'b'], [[C(1, 'cross', 7), ...filler(2)], filler(10)], C(50, 'circle', 7));
  assert.equal(playCard(g, ['a', 'b'], 'a', 1).ok, true);
});

test('Hold On (1): same player plays again', () => {
  const g = setup(['a', 'b', 'c'], [[C(1, 'circle', 1), ...filler(2)], filler(10), filler(20)], C(50, 'circle', 7));
  playCard(g, ['a', 'b', 'c'], 'a', 1);
  assert.equal(g.turn, 0);
});

test('Pick Two (2): next player must draw exactly 2 and loses their turn', () => {
  const order = ['a', 'b', 'c'];
  const g = setup(order, [[C(1, 'circle', 2), ...filler(2)], filler(10), filler(20)], C(50, 'circle', 7));
  playCard(g, order, 'a', 1);
  assert.equal(g.turn, 1);
  assert.equal(g.pending, 2);
  // the penalised player may not play a card instead of drawing
  const blocked = playCard(g, order, 'b', 10);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /penalty/);
  drawTurn(g, order, 'b');
  assert.equal(g.hands.b.length, 4);
  assert.equal(g.pending, 0);
  assert.equal(g.turn, 2);
});

test('Pick Three (5): next player draws 3', () => {
  const order = ['a', 'b'];
  const g = setup(order, [[C(1, 'circle', 5), ...filler(2)], filler(10)], C(50, 'circle', 7));
  playCard(g, order, 'a', 1);
  assert.equal(g.pending, 3);
  drawTurn(g, order, 'b');
  assert.equal(g.hands.b.length, 5);
  assert.equal(g.turn, 0);
});

test('Suspension (8): skips the next player; in 2-player it returns to the player', () => {
  const o3 = ['a', 'b', 'c'];
  const g3 = setup(o3, [[C(1, 'circle', 8), ...filler(2)], filler(10), filler(20)], C(50, 'circle', 7));
  playCard(g3, o3, 'a', 1);
  assert.equal(g3.turn, 2);
  const o2 = ['a', 'b'];
  const g2 = setup(o2, [[C(1, 'circle', 8), ...filler(2)], filler(10)], C(50, 'circle', 7));
  playCard(g2, o2, 'a', 1);
  assert.equal(g2.turn, 0);
});

test('General Market (14): every other player draws one card', () => {
  const order = ['a', 'b', 'c', 'd'];
  const g = setup(order, [[C(1, 'circle', 14), ...filler(2)], filler(10), filler(20), filler(30)], C(50, 'circle', 7));
  playCard(g, order, 'a', 1);
  assert.equal(g.hands.a.length, 2);
  for (const id of ['b', 'c', 'd']) assert.equal(g.hands[id].length, 3);
  assert.equal(g.turn, 1);
});

test('WHOT (20): plays on anything, sets the shape, then the shape must be followed', () => {
  const order = ['a', 'b'];
  const g = setup(order, [[C(1, 'whot', 20), ...filler(2)], [C(10, 'star', 4), C(11, 'circle', 9), C(12, 'cross', 3)]], C(50, 'circle', 7));
  assert.equal(playCard(g, order, 'a', 1).ok, false, 'shape is required');
  assert.equal(playCard(g, order, 'a', 1, 'banana').ok, false, 'shape must be valid');
  assert.equal(playCard(g, order, 'a', 1, 'star').ok, true);
  assert.equal(g.chosenShape, 'star');
  assert.equal(playCard(g, order, 'b', 11).ok, false, 'circle no longer matches');
  assert.equal(playCard(g, order, 'b', 12).ok, false);
  assert.equal(playCard(g, order, 'b', 10).ok, true);
  assert.equal(g.chosenShape, null, 'chosen shape clears after the next card');
});

test('illegal play leaves the game untouched', () => {
  const order = ['a', 'b'];
  const g = setup(order, [[C(1, 'cross', 4), ...filler(2)], filler(10)], C(50, 'circle', 7));
  const snapshot = JSON.stringify(g);
  assert.equal(playCard(g, order, 'a', 1).ok, false);
  assert.equal(playCard(g, order, 'a', 999).ok, false);
  assert.equal(playCard(g, order, 'b', 10).ok, false);
  assert.equal(JSON.stringify(g), snapshot);
});

test('going out wins the round; winner banks opponents\' card values (WHOT = 20)', () => {
  const order = ['a', 'b', 'c'];
  const g = setup(order, [[C(1, 'circle', 4)], [C(10, 'whot', 20), C(11, 'star', 5)], [C(20, 'cross', 13)]], C(50, 'circle', 7));
  const r = playCard(g, order, 'a', 1);
  assert.equal(r.effect, 'win');
  assert.equal(g.phase, 'finished');
  assert.equal(g.winner, 'a');
  assert.equal(g.scores.a, 20 + 5 + 13);
  assert.equal(playCard(g, order, 'b', 11).ok, false, 'no moves after the round ends');
  assert.equal(score([C(1, 'whot', 20), C(2, 'star', 8)]), 28);
});

test('scores carry into the next round', () => {
  const g = makeGame([{ id: 'a' }, { id: 'b' }], { a: 40, b: 7, gone: 99 }, 3);
  assert.equal(g.scores.a, 40);
  assert.equal(g.scores.b, 7);
  assert.equal('gone' in g.scores, false);
  assert.equal(g.round, 3);
});

test('exhausted draw pile is rebuilt from the discards without losing the top card', () => {
  const order = ['a', 'b'];
  const g = setup(order, [filler(1), filler(10)], C(50, 'circle', 7));
  g.discard = [C(60, 'star', 1), C(61, 'star', 2), C(62, 'star', 3), C(50, 'circle', 7)];
  g.draw = [];
  drawTurn(g, order, 'a');
  assert.equal(g.hands.a.length, 3);
  assert.equal(g.discard.at(-1).id, 50);
  assert.equal(g.draw.length + g.discard.length + g.hands.a.length + g.hands.b.length, 4 + 2 + 2);
});

test('removeFromGame: turn index stays correct whoever leaves', () => {
  const order = ['a', 'b', 'c', 'd'];
  // leaver before the current turn
  let g = setup(order, order.map((_, i) => filler(i * 10 + 1)), C(50, 'circle', 7), { turn: 2 });
  removeFromGame(g, order, 'a');
  assert.equal(order.filter((x) => x !== 'a')[g.turn], 'c');
  // leaver after the current turn
  g = setup(order, order.map((_, i) => filler(i * 10 + 1)), C(50, 'circle', 7), { turn: 1 });
  removeFromGame(g, order, 'd');
  assert.equal(order.filter((x) => x !== 'd')[g.turn], 'b');
  // current player leaves: next player takes over, penalty dropped
  g = setup(order, order.map((_, i) => filler(i * 10 + 1)), C(50, 'circle', 7), { turn: 3 });
  g.pending = 3;
  removeFromGame(g, order, 'd');
  assert.equal(order.filter((x) => x !== 'd')[g.turn], 'a');
  assert.equal(g.pending, 0);
  assert.equal('d' in g.hands, false);
});

test('removeFromGame: cards return to the pile and a lone survivor wins by forfeit', () => {
  const order = ['a', 'b'];
  const g = setup(order, [filler(1), [C(10, 'star', 5), C(11, 'whot', 20)]], C(50, 'circle', 7));
  const pile = g.draw.length;
  removeFromGame(g, order, 'b');
  assert.equal(g.draw.length, pile + 2);
  assert.equal(g.phase, 'finished');
  assert.equal(g.winner, 'a');
  assert.equal(g.scores.a, 25);
});

test('a full random game conserves all 54 cards at every step', () => {
  for (let game = 0; game < 40; game++) {
    const n = 2 + (game % 5);
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const g = makeGame(ids.map((id) => ({ id })));
    let steps = 0;
    while (g.phase === 'playing' && steps++ < 3000) {
      const id = ids[g.turn];
      const top = g.discard.at(-1);
      const card = g.pending ? null : g.hands[id].find((c) => c.number === 20 || c.number === top.number || c.shape === (g.chosenShape || top.shape));
      if (card) playCard(g, ids, id, card.id, 'circle');
      else drawTurn(g, ids, id);
      const total = g.draw.length + g.discard.length + Object.values(g.hands).flat().length;
      assert.equal(total, 54, `card count drifted in game ${game} step ${steps}`);
      const all = [...g.draw, ...g.discard, ...Object.values(g.hands).flat()].map((c) => c.id);
      assert.equal(new Set(all).size, 54, 'duplicate card id');
    }
    assert.equal(g.phase, 'finished', `game ${game} should finish`);
  }
});
