import test from 'node:test';
import assert from 'node:assert/strict';
import {makeGame,drawCards,replenish,canPlay,SHAPES} from './engine.js';
test('six-player game deals privately to each participant',()=>{
 const players=Array.from({length:6},(_,i)=>({id:`p${i}`}));
 const game=makeGame(players);
 assert.equal(Object.keys(game.hands).length,6);
 assert.equal(Object.values(game.hands).flat().length,30);
 assert.equal(new Set(Object.values(game.hands).flat().map(c=>c.id)).size,30);
});
test('drawing cards never duplicates existing card IDs',()=>{
 const game=makeGame([{id:'a'},{id:'b'}]);
 drawCards(game,'a',10);
 const ids=[...game.hands.a,...game.hands.b,...game.draw,...game.discard].map(c=>c.id);
 assert.equal(new Set(ids).size,ids.length);
});
test('WHOT shape selection supports all five shapes',()=>{
 for(const shape of SHAPES)assert.equal(canPlay({shape:'triangle',number:4},{shape:'circle',number:9},shape),shape==='triangle');
});
test('replenishing keeps top discard visible',()=>{
 const game=makeGame([{id:'a'},{id:'b'}]);
 game.discard.push(...game.draw.splice(0));
 const top=game.discard.at(-1);
 game.draw=[];replenish(game);
 assert.equal(game.discard.length,1);
 assert.equal(game.discard[0].id,top.id);
 assert.equal(game.draw.length>0,true);
});
