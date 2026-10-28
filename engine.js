// WHOT Royale rules engine. Pure game logic: no sockets, no timers.
import { randomInt } from 'node:crypto';

export const SHAPES = ['circle', 'triangle', 'cross', 'square', 'star'];

const NUMBERS = {
  circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  star: [1, 2, 3, 4, 5, 7, 8],
};

/** The standard 54-card WHOT deck (five WHOT 20 wilds). */
export function deck() {
  let id = 0;
  return [
    ...SHAPES.flatMap((shape) => NUMBERS[shape].map((number) => ({ id: ++id, shape, number }))),
    ...Array.from({ length: 5 }, () => ({ id: ++id, shape: 'whot', number: 20 })),
  ];
}

export function shuffle(cards) {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function canPlay(card, top, chosenShape) {
  return card.number === 20 || card.shape === (chosenShape || top.shape) || card.number === top.number;
}

export function action(card) {
  return ({ 1: 'hold', 2: 'pick2', 5: 'pick3', 8: 'suspend', 14: 'general-market', 20: 'choose' })[card.number] || 'normal';
}

export function nextIndex(i, step, count) {
  return (((i + step) % count) + count) % count;
}

export function score(hand) {
  return hand.reduce((sum, c) => sum + (c.number === 20 ? 20 : c.number), 0);
}

/**
 * Deal a new round. `players` is an array of { id, name? } in seat order.
 * `carryScores` (optional) keeps running totals across rounds.
 */
export function makeGame(players, carryScores = {}, round = 1) {
  const pile = shuffle(deck());
  const hands = {};
  for (const p of players) hands[p.id] = Array.from({ length: 5 }, () => pile.pop());
  let top = pile.pop();
  while (top.number === 20) {
    pile.unshift(top);
    top = pile.pop();
  }
  return {
    hands,
    draw: pile,
    discard: [top],
    turn: 0,
    chosenShape: null,
    pending: 0,
    phase: 'playing',
    winner: null,
    round,
    names: Object.fromEntries(players.map((p) => [p.id, p.name || 'Player'])),
    log: ['Round started'],
    scores: Object.fromEntries(players.map((p) => [p.id, carryScores[p.id] || 0])),
  };
}

export function replenish(game) {
  if (game.draw.length) return;
  const top = game.discard.pop();
  game.draw = shuffle(game.discard);
  game.discard = [top];
}

export function drawCards(game, id, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    replenish(game);
    if (!game.draw.length) break;
    const c = game.draw.pop();
    game.hands[id].push(c);
    out.push(c);
  }
  return out;
}

export function addLog(game, text) {
  game.log.push(text);
  if (game.log.length > 40) game.log.shift();
}

const nameOf = (game, id) => game.names?.[id] || 'Player';

function finishRound(game, winnerId, order) {
  game.phase = 'finished';
  game.winner = winnerId;
  for (const pid of order) if (pid !== winnerId) game.scores[winnerId] += score(game.hands[pid]);
  addLog(game, `${nameOf(game, winnerId)} wins the round!`);
}

/**
 * Attempt to play a card. `order` is the array of player ids in seat order.
 * Returns { ok:false, error } or { ok:true, effect, card }.
 * Mutates the game only when the move is legal.
 */
export function playCard(game, order, playerId, cardId, shape) {
  if (!game || game.phase !== 'playing' || order[game.turn] !== playerId) return { ok: false, error: 'Not your turn' };
  const hand = game.hands[playerId];
  const idx = hand ? hand.findIndex((c) => c.id === cardId) : -1;
  if (idx < 0) return { ok: false, error: 'Card not in your hand' };
  if (game.pending) return { ok: false, error: 'Resolve your penalty first' };
  const card = hand[idx];
  if (!canPlay(card, game.discard.at(-1), game.chosenShape)) return { ok: false, error: 'Card does not match' };
  if (card.number === 20 && !SHAPES.includes(shape)) return { ok: false, error: 'Choose a valid shape' };

  hand.splice(idx, 1);
  game.discard.push(card);
  game.chosenShape = card.number === 20 ? shape : null;
  const effect = action(card);
  const who = nameOf(game, playerId);
  const label = card.number === 20 ? `WHOT (${shape})` : `${card.number} ${card.shape}`;
  addLog(game, `${who} played ${label}`);

  if (!hand.length) {
    finishRound(game, playerId, order);
    return { ok: true, effect: 'win', card };
  }

  const n = order.length;
  switch (effect) {
    case 'pick2':
    case 'pick3':
      game.turn = nextIndex(game.turn, 1, n);
      game.pending = effect === 'pick2' ? 2 : 3;
      addLog(game, `${nameOf(game, order[game.turn])} must pick ${game.pending}`);
      break;
    case 'general-market':
      for (const pid of order) if (pid !== playerId) drawCards(game, pid, 1);
      addLog(game, 'General Market! Everyone else picks one');
      game.turn = nextIndex(game.turn, 1, n);
      break;
    case 'hold':
      addLog(game, `${who} holds on and plays again`);
      break;
    case 'suspend':
      addLog(game, `${nameOf(game, order[nextIndex(game.turn, 1, n)])} is suspended`);
      game.turn = nextIndex(game.turn, 2, n);
      break;
    default:
      game.turn = nextIndex(game.turn, 1, n);
  }
  return { ok: true, effect, card };
}

/** Draw for the current player (1 card, or the pending penalty). Ends their turn. */
export function drawTurn(game, order, playerId, reason = 'drew') {
  if (!game || game.phase !== 'playing' || order[game.turn] !== playerId) return { ok: false, error: 'Not your turn' };
  const n = game.pending || 1;
  const drawn = drawCards(game, playerId, n);
  addLog(game, `${nameOf(game, playerId)} ${reason} ${drawn.length} card${drawn.length === 1 ? '' : 's'}`);
  game.pending = 0;
  game.turn = nextIndex(game.turn, 1, order.length);
  return { ok: true, drawn: drawn.length };
}

/**
 * Remove a player from a running game (they left). `order` is the seat order
 * BEFORE removal; the caller removes the player from its own list afterwards.
 * Their cards go to the bottom of the draw pile. If only one player remains,
 * that player wins the round.
 */
export function removeFromGame(game, order, playerId) {
  const idx = order.indexOf(playerId);
  if (!game || idx < 0) return;
  const remaining = order.filter((id) => id !== playerId);
  const leaverHand = game.hands[playerId] || [];
  game.draw.unshift(...leaverHand);
  const forfeited = score(leaverHand);
  delete game.hands[playerId];
  addLog(game, `${nameOf(game, playerId)} left the table`);
  if (game.phase !== 'playing') return;
  if (remaining.length < 2) {
    if (remaining.length === 1) {
      game.scores[remaining[0]] += forfeited;
      game.phase = 'finished';
      game.winner = remaining[0];
      addLog(game, `${nameOf(game, remaining[0])} wins by forfeit!`);
    }
    return;
  }
  if (idx < game.turn) game.turn -= 1;
  else if (idx === game.turn) {
    game.pending = 0;
    game.turn = game.turn % remaining.length;
  }
}
