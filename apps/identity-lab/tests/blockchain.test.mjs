import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBlockchain,publicBlockchain,submitTransfer,mineBlock,validateBlockchain,simulateReorg} from '../lib/blockchain.mjs';

const fresh=()=>createBlockchain({seed:67,walletCount:8,difficulty:1});
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function updateTxId(tx) {const {id,...body}=tx;tx.id=createHash('sha256').update(canonical(body)).digest('hex');}
test('deterministic seeded chain has real PoW, signed transfers and conserved supply',()=>{
  const state=fresh(),same=fresh();
  assert.deepEqual(state,same);
  assert.equal(state.blocks.length,7);
  assert.equal(validateBlockchain(state).valid,true);
  assert.equal(validateBlockchain(state).supply,8_000+6*50);
  assert.ok(state.blocks.every(b=>b.hash.startsWith('0')));
  assert.ok(state.blocks.flatMap(b=>b.transactions).filter(t=>t.type==='transfer').every(t=>t.inputs.every(i=>i.signature.length>40)));
  assert.ok(state.blocks.every(b=>b.transactions.every(tx=>Date.parse(tx.createdAt)<=Date.parse(b.timestamp))));
});
test('signed transfer reserves UTXOs, mines with fees and changes balances',()=>{
  const state=fresh(),[a,b]=state.wallets;
  const before=publicBlockchain(state),balanceA=before.wallets[0].balance,balanceB=before.wallets[1].balance;
  const tx=submitTransfer(state,{from:a.address,to:b.address,amount:50,fee:3});
  assert.equal(tx.outputs[0].amount,50);
  assert.equal(state.mempool.length,1);
  assert.equal(publicBlockchain(state).wallets[0].availableBalance,balanceA-53);
  const block=mineBlock(state,{minerAddress:b.address});
  assert.equal(block.transactions[0].outputs[0].amount,53);
  assert.equal(state.mempool.length,0);
  assert.equal(publicBlockchain(state).wallets[0].balance,balanceA-53);
  assert.equal(publicBlockchain(state).wallets[1].balance,balanceB+50+53);
  assert.equal(validateBlockchain(state).valid,true);
});
test('invalid values and insufficient or reserved funds are rejected without mutation',()=>{
  const state=fresh(),[a,b]=state.wallets;
  for (const amount of [-1,0,1.5,NaN,Infinity,1e20]) assert.throws(()=>submitTransfer(state,{from:a.address,to:b.address,amount}));
  assert.throws(()=>submitTransfer(state,{from:a.address,to:a.address,amount:1}));
  assert.throws(()=>submitTransfer(state,{from:a.address,to:'lab1unknown',amount:1}));
  const available=publicBlockchain(state).wallets[0].availableBalance;
  submitTransfer(state,{from:a.address,to:b.address,amount:available-1,fee:1});
  assert.throws(()=>submitTransfer(state,{from:a.address,to:b.address,amount:1}),/Niewystarczające/);
  assert.equal(validateBlockchain(state).valid,true);
});
test('tampering signatures, amounts, hashes, registry or rewards fails validation',()=>{
  const original=fresh();
  const mutations=[s=>s.blocks[1].transactions[1].inputs[0].signature='AAAA',s=>s.blocks[2].transactions[1].outputs[0].amount++,s=>s.blocks[3].hash='0'.repeat(64),s=>s.blocks[4].transactions[0].outputs[0].amount++,s=>s.wallets[0].publicKey=s.wallets[1].publicKey,s=>s.blocks[4].cumulativeWork++];
  for (const mutate of mutations) {
    const state=structuredClone(original);mutate(state);
    assert.equal(validateBlockchain(state).valid,false);
  }
});
test('duplicated pending transaction and invalid pending signature are rejected',()=>{
  const state=fresh(),[a,b]=state.wallets;
  const tx=submitTransfer(state,{from:a.id,to:b.id,amount:20});
  state.mempool.push(structuredClone(tx));
  assert.equal(validateBlockchain(state).valid,false);
  assert.throws(()=>mineBlock(state));
  state.mempool.pop();state.mempool[0].inputs[0].signature='invalid';
  assert.equal(validateBlockchain(state).valid,false);
});
test('signature verification rejects altered signed content even after recomputing transaction ID',()=>{
  const state=fresh(),[a,b]=state.wallets;
  submitTransfer(state,{from:a.id,to:b.id,amount:20});
  const tx=state.mempool[0];
  tx.outputs[0].amount++;
  tx.outputs[1].amount--;
  updateTxId(tx);
  assert.match(validateBlockchain(state).errors[0],/podpis Ed25519/);
});
test('double-spending a confirmed input is rejected despite a new transaction ID',()=>{
  const state=fresh(),[a,b]=state.wallets;
  const tx=submitTransfer(state,{from:a.id,to:b.id,amount:20});
  mineBlock(state);
  tx.sequence++;
  updateTxId(tx);
  state.mempool.push(tx);
  assert.match(validateBlockchain(state).errors[0],/Podwójne wydanie/);
});
test('higher-work branch replaces old blocks, restores valid transfers and validates after mining',()=>{
  const state=fresh(),oldLength=state.blocks.length,oldTip=state.blocks.at(-1).hash;
  const event=simulateReorg(state,{depth:2});
  assert.equal(event.oldTip,oldTip);
  assert.equal(event.depth,2);
  assert.equal(state.blocks.length,oldLength+1);
  assert.ok(event.newWork>event.oldWork);
  assert.equal(state.orphans[0].blocks.length,2);
  assert.ok(state.mempool.length>0);
  assert.equal(validateBlockchain(state).valid,true);
  mineBlock(state);
  assert.equal(validateBlockchain(state).valid,true);
  simulateReorg(state,{depth:1});
  assert.equal(validateBlockchain(state).valid,true);
});
test('public chain contains no private keys and can be serialized and restored',()=>{
  const state=fresh(),view=publicBlockchain(state),text=JSON.stringify(view);
  assert.ok(!text.includes('privateKey'));
  for(const wallet of state.wallets) assert.ok(!text.includes(wallet.privateKey));
  assert.equal(validateBlockchain(JSON.parse(JSON.stringify(state))).valid,true);
  view.wallets[0].balance=-10;view.blocks[0].hash='changed';
  assert.equal(validateBlockchain(state).valid,true);
});
