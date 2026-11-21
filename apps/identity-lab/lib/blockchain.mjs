import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// All keys and funds in this module belong to a deterministic, isolated test chain.
const PKCS8_PREFIX = '302e020100300506032b657004220420';
const START_TIME = Date.parse('2026-10-01T08:00:00.000Z');
const MAX_MONEY = 1_000_000_000;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const clone = value => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function integer(value, label, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}: wymagana liczba całkowita od ${min} do ${max}.`);
  return value;
}
function registry(state) {
  return state.wallets.map(({address, publicKey}) => ({address, publicKey}));
}
function unsigned(tx) {
  return {type:tx.type, inputs:tx.inputs.map(({txId,index,publicKey})=>({txId,index,publicKey})), outputs:tx.outputs, fee:tx.fee, createdAt:tx.createdAt, sequence:tx.sequence};
}
function transactionId(tx) {
  const {id, ...body} = tx;
  return hash(body);
}
function merkleRoot(transactions) {
  let level = transactions.map(tx => tx.id);
  if (!level.length) return hash('');
  while (level.length > 1) {
    const next=[];
    for (let i=0;i<level.length;i+=2) next.push(hash(level[i] + (level[i+1] || level[i])));
    level=next;
  }
  return level[0];
}
function header(block) {
  const {height,previousHash,timestamp,nonce,difficulty,merkleRoot,minerAddress,registryHash}=block;
  return {height,previousHash,timestamp,nonce,difficulty,merkleRoot,minerAddress,registryHash};
}
function makeBlock(state, previous, transactions, minerAddress, timeOffset=0) {
  const height=previous ? previous.height+1 : 0;
  const block={height,index:height,previousHash:previous?.hash || '0'.repeat(64),timestamp:new Date(START_TIME+height*600_000+timeOffset).toISOString(),nonce:0,difficulty:state.difficulty,merkleRoot:merkleRoot(transactions),minerAddress,registryHash:hash(registry(state)),transactions:clone(transactions)};
  while (!hash(header(block)).startsWith('0'.repeat(block.difficulty))) block.nonce++;
  block.hash=hash(header(block));
  block.work=16**block.difficulty;
  block.cumulativeWork=(previous?.cumulativeWork || 0)+block.work;
  return block;
}
function outpoint(input) {return `${input.txId}:${input.index}`;}
function getWallet(state, value) {
  const wallet=state.wallets.find(w=>w.address===value || w.id===value);
  if (!wallet) throw new Error('Nieznany portfel testowy.');
  return wallet;
}
function applyTransfer(tx,utxos,publicKeys,seenIds) {
  if (tx.type!=='transfer') throw new Error('Nieprawidłowy typ transakcji.');
  if (tx.id!==transactionId(tx)) throw new Error('Identyfikator transakcji nie odpowiada treści.');
  if (seenIds.has(tx.id)) throw new Error('Powtórzona transakcja.');
  if (!Array.isArray(tx.inputs) || !tx.inputs.length || !Array.isArray(tx.outputs) || !tx.outputs.length) throw new Error('Brak wejść lub wyjść transakcji.');
  integer(tx.fee,'Opłata');
  integer(tx.sequence,'Numer transakcji');
  if (!Number.isFinite(Date.parse(tx.createdAt))) throw new Error('Nieprawidłowa data transakcji.');
  const consumed=new Set();
  const message=Buffer.from(canonical(unsigned(tx)));
  let incoming=0,outgoing=0;
  for (const input of tx.inputs) {
    integer(input.index,'Indeks wyjścia');
    const key=outpoint(input);
    if (consumed.has(key)) throw new Error('Podwójne wydanie UTXO wewnątrz transakcji.');
    const output=utxos.get(key);
    if (!output) throw new Error('Podwójne wydanie lub nieistniejące UTXO.');
    if (publicKeys.get(output.address)!==input.publicKey) throw new Error('Klucz publiczny nie należy do właściciela UTXO.');
    let validSignature=false;
    try { validSignature=verify(null,message,createPublicKey({key:Buffer.from(input.publicKey,'base64'),format:'der',type:'spki'}),Buffer.from(input.signature,'base64')); } catch {}
    if (!validSignature) throw new Error('Nieprawidłowy podpis Ed25519.');
    incoming+=output.amount;
    integer(incoming,'Suma wejść');
    consumed.add(key);
  }
  for (const output of tx.outputs) {
    integer(output.amount,'Kwota wyjścia',1);
    if (!publicKeys.has(output.address)) throw new Error('Nieznany adres odbiorcy.');
    outgoing+=output.amount;
    integer(outgoing,'Suma wyjść');
  }
  if (incoming!==outgoing+tx.fee) throw new Error('Bilans transakcji: wejścia muszą równać się wyjściom i opłacie.');
  for (const key of consumed) utxos.delete(key);
  tx.outputs.forEach((output,index)=>utxos.set(`${tx.id}:${index}`,{...output,txId:tx.id,index}));
  seenIds.add(tx.id);
}
function applyIssuance(tx,utxos,seenIds,{type,amount,address,publicKeys}) {
  if (tx.type!==type || tx.id!==transactionId(tx) || seenIds.has(tx.id)) throw new Error('Nieprawidłowa transakcja emisji.');
  if (!Array.isArray(tx.inputs) || tx.inputs.length || tx.fee!==0 || !Array.isArray(tx.outputs) || !tx.outputs.length) throw new Error('Nieprawidłowa struktura emisji.');
  let sum=0;
  tx.outputs.forEach((output,index)=>{
    integer(output.amount,'Emisja',1);
    if (!publicKeys.has(output.address) || (address && output.address!==address)) throw new Error('Nieprawidłowy odbiorca emisji.');
    sum+=output.amount;
    integer(sum,'Suma emisji');
    utxos.set(`${tx.id}:${index}`,{...output,txId:tx.id,index});
  });
  if (sum!==amount) throw new Error('Nieprawidłowa nagroda lub emisja genesis.');
  seenIds.add(tx.id);
}
function replay(state,blocks=state.blocks,{includeMempool=false}={}) {
  const utxos=new Map(),seenIds=new Set(),publicKeys=new Map(state.wallets.map(w=>[w.address,w.publicKey]));
  if (!blocks.length) throw new Error('Brak bloku genesis.');
  if (publicKeys.size!==state.wallets.length) throw new Error('Powtórzony adres portfela.');
  integer(state.difficulty,'Trudność',1,3);
  if (state.reward!==50 || state.initialBalance!==1000) throw new Error('Zmieniono parametry emisji sieci testowej.');
  const registryHash=hash(registry(state));
  let previous=null;
  for (const block of blocks) {
    integer(block.nonce,'Nonce',0,Number.MAX_SAFE_INTEGER);
    if (block.height!==(previous ? previous.height+1:0) || block.index!==block.height) throw new Error('Nieciągła wysokość łańcucha.');
    if (block.previousHash!==(previous?.hash || '0'.repeat(64))) throw new Error('Nieprawidłowe powiązanie poprzedniego bloku.');
    if (!Number.isFinite(Date.parse(block.timestamp)) || (previous && Date.parse(block.timestamp)<=Date.parse(previous.timestamp))) throw new Error('Nieprawidłowy czas bloku.');
    if (block.registryHash!==registryHash) throw new Error('Niezgodny rejestr kluczy portfeli.');
    if (block.difficulty!==state.difficulty || block.hash!==hash(header(block)) || !block.hash.startsWith('0'.repeat(block.difficulty))) throw new Error('Nieprawidłowy hash lub proof of work.');
    if (block.merkleRoot!==merkleRoot(block.transactions)) throw new Error('Nieprawidłowy korzeń Merkle.');
    if (block.work!==16**block.difficulty || block.cumulativeWork!==(previous?.cumulativeWork || 0)+block.work) throw new Error('Nieprawidłowa praca łańcucha.');
    if (!publicKeys.has(block.minerAddress)) throw new Error('Nieznany górnik.');
    if (!block.transactions.length) throw new Error('Blok bez emisji.');
    if (!previous) {
      if (block.transactions.length!==1) throw new Error('Genesis zawiera dodatkowe transakcje.');
      const tx=block.transactions[0];
      if (tx.outputs.length!==state.wallets.length || !state.wallets.every(w=>tx.outputs.filter(o=>o.address===w.address && o.amount===state.initialBalance).length===1)) throw new Error('Niezgodna alokacja genesis.');
      applyIssuance(tx,utxos,seenIds,{type:'genesis',amount:state.wallets.length*state.initialBalance,publicKeys});
    } else {
      let fees=0;
      // A coinbase cannot be spent in the block that creates it.
      for (const tx of block.transactions.slice(1)) { applyTransfer(tx,utxos,publicKeys,seenIds); fees+=tx.fee; }
      applyIssuance(block.transactions[0],utxos,seenIds,{type:'coinbase',amount:state.reward+fees,address:block.minerAddress,publicKeys});
    }
    previous=block;
  }
  if (includeMempool) for (const tx of state.mempool) applyTransfer(tx,utxos,publicKeys,seenIds);
  return {utxos,seenIds,publicKeys};
}
function issuance(type,outputs,height,time) {
  const tx={type,inputs:[],outputs,fee:0,createdAt:time,sequence:height};
  return {...tx,id:transactionId(tx)};
}

export function createBlockchain({seed=67,walletCount=24,difficulty=2}={}) {
  integer(seed,'Seed',0,2_147_483_647);integer(walletCount,'Liczba portfeli',2,200);integer(difficulty,'Trudność',1,3);
  const wallets=Array.from({length:walletCount},(_,i)=>{
    const seedBytes=hash(`${seed}:ed25519:${i}`);
    const privateKeyObject=createPrivateKey({key:Buffer.from(PKCS8_PREFIX+seedBytes,'hex'),format:'der',type:'pkcs8'});
    return {id:`wallet-${i+1}`,address:`lab1${hash(`${seed}:wallet:${i}`).slice(0,40)}`,label:`Portfel LAB ${String(i+1).padStart(2,'0')}`,publicKey:createPublicKey(privateKeyObject).export({format:'der',type:'spki'}).toString('base64'),privateKey:privateKeyObject.export({format:'der',type:'pkcs8'}).toString('base64')};
  });
  const state={version:1,network:'identity-lab-synthetic',token:'LAB',seed,difficulty,reward:50,initialBalance:1000,wallets,blocks:[],mempool:[],orphans:[],events:[],transferSequence:0};
  const genesisTx=issuance('genesis',wallets.map(w=>({address:w.address,amount:1000})),0,new Date(START_TIME).toISOString());
  state.blocks.push(makeBlock(state,null,[genesisTx],wallets[0].address));
  for (let block=0;block<6;block++) {
    // Consolidation and repeat-payee patterns are observable but do not prove identity.
    for (let i=0;i<Math.min(walletCount-1,5);i++) {
      const from=wallets[(block*3+i+1)%walletCount];
      let to=wallets[(block%3===0 ? 0 : (block+i+7)%walletCount)];
      if (from.address===to.address) to=wallets[(wallets.indexOf(to)+1)%walletCount];
      submitTransfer(state,{from:from.address,to:to.address,amount:15+((seed+block*17+i*13)%85),fee:1+(i%2)});
    }
    mineBlock(state,{minerAddress:wallets[block%Math.min(walletCount,4)].address});
  }
  state.events=[];
  return state;
}

export function submitTransfer(state,{from,to,amount,fee=1}={}) {
  integer(amount,'Kwota',1);integer(fee,'Opłata');
  integer(amount+fee,'Kwota z opłatą',1);
  const sender=getWallet(state,from),recipient=getWallet(state,to);
  if (sender.address===recipient.address) throw new Error('Nadawca i odbiorca muszą być różni.');
  const {utxos,seenIds,publicKeys}=replay(state,state.blocks,{includeMempool:true});
  const selected=[];let total=0;
  for (const output of utxos.values()) {
    if (output.address!==sender.address) continue;
    selected.push(output);total+=output.amount;
    if (total>=amount+fee) break;
  }
  if (total<amount+fee) throw new Error('Niewystarczające dostępne środki (UTXO zarezerwowane w mempoolu są uwzględnione).');
  const sequence=state.transferSequence+1;
  const tx={type:'transfer',inputs:selected.map(o=>({txId:o.txId,index:o.index,publicKey:sender.publicKey})),outputs:[{address:recipient.address,amount}],fee,createdAt:new Date(START_TIME+state.blocks.at(-1).height*600_000+300_000+(sequence%1000)).toISOString(),sequence};
  if (total>amount+fee) tx.outputs.push({address:sender.address,amount:total-amount-fee});
  const key=createPrivateKey({key:Buffer.from(sender.privateKey,'base64'),format:'der',type:'pkcs8'});
  const signature=sign(null,Buffer.from(canonical(unsigned(tx))),key).toString('base64');
  tx.inputs=tx.inputs.map(input=>({...input,signature}));
  tx.id=transactionId(tx);
  applyTransfer(tx,utxos,publicKeys,seenIds);
  state.transferSequence=sequence;
  state.mempool.push(tx);
  return clone(tx);
}

export function mineBlock(state,{minerAddress}={}) {
  const miner=getWallet(state,minerAddress || state.wallets[0].address);
  replay(state,state.blocks,{includeMempool:true});
  const previous=state.blocks.at(-1),height=previous.height+1;
  const fees=state.mempool.reduce((sum,tx)=>sum+tx.fee,0);
  const coinbase=issuance('coinbase',[{address:miner.address,amount:state.reward+fees}],height,new Date(START_TIME+height*600_000).toISOString());
  const block=makeBlock(state,previous,[coinbase,...state.mempool],miner.address);
  replay(state,[...state.blocks,block]);
  state.blocks.push(block);state.mempool=[];
  state.events.push({type:'mined',height:block.height,hash:block.hash,transactions:block.transactions.length,timestamp:block.timestamp});
  return clone(block);
}

export function validateBlockchain(state) {
  try {
    const confirmed=replay(state);
    replay(state,state.blocks,{includeMempool:true});
    const supply=[...confirmed.utxos.values()].reduce((sum,o)=>sum+o.amount,0);
    const expectedSupply=state.wallets.length*state.initialBalance+(state.blocks.length-1)*state.reward;
    if (supply!==expectedSupply) throw new Error('Niezgodna podaż tokenów.');
    return {valid:true,errors:[],blocks:state.blocks.length,transactions:state.blocks.reduce((n,b)=>n+b.transactions.length,0),utxos:confirmed.utxos.size,supply,expectedSupply,cumulativeWork:state.blocks.at(-1).cumulativeWork,mempool:state.mempool.length};
  } catch(error) {return {valid:false,errors:[error.message]};}
}

export function simulateReorg(state,{depth=1}={}) {
  integer(depth,'Głębokość reorganizacji',1,Math.min(3,state.blocks.length-1));
  replay(state,state.blocks,{includeMempool:true});
  const previousTip=state.blocks.at(-1),forkHeight=previousTip.height-depth;
  const discarded=clone(state.blocks.slice(forkHeight+1));
  const branch=clone(state.blocks.slice(0,forkHeight+1));
  // Mine an alternative branch from the fork point with one extra block of work.
  const branchNumber=state.orphans.length+1;
  for(let i=0;i<depth+1;i++) {
    const previous=branch.at(-1),height=previous.height+1;
    const miner=state.wallets[(height+branchNumber)%state.wallets.length];
    const timeOffset=branchNumber*1000;
    const coinbase=issuance('coinbase',[{address:miner.address,amount:state.reward}],height,new Date(START_TIME+height*600_000+timeOffset).toISOString());
    branch.push(makeBlock(state,previous,[coinbase],miner.address,timeOffset));
  }
  const {utxos,seenIds,publicKeys}=replay(state,branch);
  if(branch.at(-1).cumulativeWork<=previousTip.cumulativeWork) throw new Error('Alternatywna gałąź nie ma większej skumulowanej pracy.');
  const pending=[...discarded.flatMap(b=>b.transactions.filter(tx=>tx.type==='transfer')),...state.mempool];
  const newMempool=[],rejected=[];
  for(const tx of pending) {
    if(newMempool.some(t=>t.id===tx.id)) continue;
    try {applyTransfer(tx,utxos,publicKeys,seenIds);newMempool.push(tx);} catch(error) {rejected.push({id:tx.id,reason:error.message});}
  }
  state.blocks=branch;state.mempool=newMempool;
  const event={type:'reorg',forkHeight,depth,oldTip:previousTip.hash,newTip:branch.at(-1).hash,oldWork:previousTip.cumulativeWork,newWork:branch.at(-1).cumulativeWork,orphanedBlocks:discarded.map(b=>b.hash),requeuedTransactions:newMempool.length,rejectedTransactions:rejected,timestamp:branch.at(-1).timestamp};
  state.orphans.push({forkHeight,blocks:discarded,replacedBy:branch.at(-1).hash});
  state.events.push(event);
  return clone(event);
}

export function publicBlockchain(state) {
  const {utxos}=replay(state),available=replay(state,state.blocks,{includeMempool:true}).utxos;
  const total=(collection,address)=>[...collection.values()].filter(o=>o.address===address).reduce((sum,o)=>sum+o.amount,0);
  const tip=state.blocks.at(-1),transactionCount=state.blocks.reduce((sum,b)=>sum+b.transactions.filter(t=>t.type==='transfer').length,0);
  return {
    network:state.network,token:state.token,difficulty:state.difficulty,reward:state.reward,
    summary:{height:tip.height,blocks:state.blocks.length,transactions:transactionCount,pending:state.mempool.length,wallets:state.wallets.length,supply:state.wallets.length*state.initialBalance+tip.height*state.reward,cumulativeWork:tip.cumulativeWork,tipHash:tip.hash,orphans:state.orphans.reduce((n,o)=>n+o.blocks.length,0)},
    wallets:state.wallets.map(({privateKey,...wallet})=>({...wallet,balance:total(utxos,wallet.address),availableBalance:total(available,wallet.address),utxoCount:[...utxos.values()].filter(o=>o.address===wallet.address).length})),
    blocks:clone(state.blocks),mempool:clone(state.mempool),orphans:clone(state.orphans),events:clone(state.events),
    notice:'Izolowana sieć LAB: deterministyczne publicznie odtwarzalne klucze testowe, brak wartości pieniężnej i połączeń z prawdziwym blockchainem. Wspólny adres lub przepływ środków jest poszlaką, a nie dowodem wspólnego właściciela.'
  };
}
