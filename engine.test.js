import test from 'node:test';import assert from 'node:assert/strict';import {deck,shuffle,canPlay,action,makeGame,drawCards,nextIndex,score} from './engine.js';
test('deck has unique ids and WHOT cards',()=>{const d=deck();assert.equal(new Set(d.map(c=>c.id)).size,d.length);assert.equal(d.filter(c=>c.number===20).length,5)});
test('shuffle preserves cards',()=>assert.deepEqual(shuffle(deck()).map(c=>c.id).sort((a,b)=>a-b),deck().map(c=>c.id).sort((a,b)=>a-b)));
test('match shape, number or wild',()=>{const top={shape:'circle',number:3};assert.equal(canPlay({shape:'circle',number:7},top),true);assert.equal(canPlay({shape:'star',number:3},top),true);assert.equal(canPlay({shape:'star',number:20},top),true);assert.equal(canPlay({shape:'star',number:4},top),false);assert.equal(canPlay({shape:'star',number:4},top,'star'),true)});
test('action mappings',()=>{assert.equal(action({number:14}),'general-market');assert.equal(action({number:8}),'suspend')});
test('game deals five each',()=>{const g=makeGame([{id:'a'},{id:'b'}]);assert.equal(g.hands.a.length,5);assert.equal(g.hands.b.length,5);assert.notEqual(g.discard[0].number,20);assert.equal(drawCards(g,'a',2).length,2)});
test('turn wrap and score',()=>{assert.equal(nextIndex(2,2,3),1);assert.equal(score([{number:20},{number:5}]),25)});

test('two-player skip returns the turn to the acting player',()=>{assert.equal(nextIndex(0,2,2),0)});

test('deck contains only valid shapes and five wild cards',()=>{const d=deck();assert.equal(d.length,54);assert.equal(d.filter(c=>c.shape==='whot').length,5);assert.ok(d.every(c=>['circle','triangle','cross','square','star','whot'].includes(c.shape)))});
test('initial deal conserves every card',()=>{const g=makeGame(Array.from({length:6},(_,i)=>({id:String(i)})));const all=[...g.draw,...g.discard,...Object.values(g.hands).flat()];assert.equal(all.length,54);assert.equal(new Set(all.map(c=>c.id)).size,54)});
test('drawing cannot manufacture cards after pile exhausted',()=>{const g=makeGame([{id:'a'},{id:'b'}]);const before=g.draw.length+g.discard.length+g.hands.a.length+g.hands.b.length;drawCards(g,'a',200);const after=g.draw.length+g.discard.length+g.hands.a.length+g.hands.b.length;assert.equal(after,before)});
