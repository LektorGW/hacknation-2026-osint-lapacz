import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createLabServer} from '../server.mjs';
import {buildLab,persistLab,loadLab} from '../lib/storage.mjs';

let server,base;
const request = async (route, body, headers = {}) => {
  const r=await fetch(base+route,body===undefined?{headers}:{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
};
before(async()=>{
  ({server}=createLabServer({lab:buildLab({seed:67,people:40}),persist:false}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

test('27 independent populated portal APIs match their catalog and renderable pages',async()=>{
  const {data:services}=await request('/api/services');
  assert.equal(services.length,27);
  assert.deepEqual(['social','marketplace','forum'].map(c=>services.filter(s=>s.category===c).length),[5,7,15]);
  for(const service of services){
    const {status,data}=await request(`/api/portal/${service.slug}`);
    assert.equal(status,200);
    assert.ok(data.accounts.length>0);
    const key={social:'posts',marketplace:'listings',forum:'threads'}[service.category];
    assert.ok(data[key].length>0,service.slug);
    assert.ok(data.accounts.every(a=>a.serviceId===service.id));
    const page=await fetch(`${base}/s/${service.slug}`);
    assert.equal(page.status,200);assert.match(await page.text(),/app\.js/);
  }
});
test('public data and normal profile APIs contain neither identity truth nor private keys',async()=>{
  for(const route of ['/api/export/public','/api/accounts?limit=1000','/api/accounts/acct-00001','/api/blockchain','/api/export/blockchain']){
    const {status,data}=await request(route);
    assert.equal(status,200);
    assert.doesNotMatch(JSON.stringify(data),/"(?:personId|personaId|role|privateKey|accountLinks)"/);
  }
  const {data:truth}=await request('/api/ground-truth');
  assert.ok(truth.accountLinks.some(l=>l.role==='fake'));
});
test('demo resolution links public traces, explains uncertainty and leaves disconnected fake unresolved',async()=>{
  const {status,data}=await request('/api/resolve',{query:'mira.kowal@poczta.test'});
  assert.equal(status,200);
  assert.ok(data.matches.length>=5);
  assert.ok(data.matches.some(m=>m.account.id==='acct-00002'));
  assert.ok(data.matches.every(m=>m.evidence&&m.probability<=1));
  assert.ok(!data.matches.some(m=>m.account.id==='acct-00008'));
  const nickname=await request('/api/resolve',{query:'rowerzysta'});
  assert.ok(nickname.data.anchors.length>=2);
  assert.ok(nickname.data.caveats.length>0);
});
test('account-published test wallets refer to actual simulated chain registry',async()=>{
  const {data:accounts}=await request('/api/accounts?limit=1000');
  const {data:chain}=await request('/api/blockchain');
  const addresses=new Set(chain.wallets.map(w=>w.address));
  assert.ok(accounts.accounts.some(a=>a.walletAddresses.length>0));
  for(const a of accounts.accounts)for(const address of a.walletAddresses)assert.ok(addresses.has(address));
});
test('controlled audit surfaces shared intermediary wallet between unrelated people',async()=>{
  const {data}=await request('/api/evaluate',{threshold:.75});
  assert.ok(data.hardNegativeAudit.bySignal.sharedWallet.pairs>=1);
  assert.ok(data.hardNegativeAudit.bySignal.sharedWallet.falsePositives>=1);
});
test('HTTP transfer, mining and reorg preserve a valid ledger and never reveal test private keys',async()=>{
  const {data:chain}=await request('/api/blockchain');
  const {status,data:transfer}=await request('/api/blockchain/transfer',{from:chain.wallets[0].address,to:chain.wallets[1].address,amount:17,fee:1});
  assert.equal(status,201);assert.equal(transfer.blockchain.mempool.length,1);
  assert.doesNotMatch(JSON.stringify(transfer),/privateKey/);
  const invalid=await request('/api/blockchain/transfer',{from:chain.wallets[0].address,to:chain.wallets[1].address,amount:1.5,fee:1});
  assert.equal(invalid.status,400);
  const mined=await request('/api/blockchain/mine',{});
  assert.equal(mined.status,201);assert.equal(mined.data.blockchain.mempool.length,0);
  assert.equal(mined.data.blockchain.summary.height,chain.summary.height+1);
  const reorg=await request('/api/blockchain/reorg',{depth:1});
  assert.equal(reorg.status,200);assert.ok(reorg.data.blockchain.summary.orphans>=1);
  assert.doesNotMatch(JSON.stringify(reorg.data),/privateKey/);
  const validation=await request('/api/blockchain/validate');assert.equal(validation.data.valid,true);
});
test('benchmark is explicit and rejects invalid query, origin, bounds and unknown resources',async()=>{
  const evaluation=await request('/api/evaluate',{threshold:.75});
  assert.equal(evaluation.status,200);assert.ok(evaluation.data.confusion.tp>0);
  assert.equal((await request('/api/resolve',{query:''})).status,400);
  assert.equal((await request('/api/evaluate',{threshold:5})).status,400);
  assert.equal((await request('/api/regenerate',{people:2})).status,400);
  assert.equal((await request('/api/resolve',{query:'test'},{origin:'https://example.test'})).status,403);
  assert.equal((await request('/api/portal/does-not-exist')).status,404);
  assert.equal((await request('/api/accounts/missing')).status,404);
  const badHost=await new Promise((resolve,reject)=>{http.get(`${base}/api/status`,{headers:{host:'evil.test'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
  assert.equal(badHost,403);
});
test('regeneration replaces all portals consistently and resets the chain',async()=>{
  const regenerated=await request('/api/regenerate',{seed:91,people:35});assert.equal(regenerated.status,200);
  const {data:status}=await request('/api/status');assert.equal(status.meta.seed,91);assert.equal(status.counts.people,35);
  const {data:chain}=await request('/api/blockchain');assert.equal(chain.summary.height,6);
  assert.equal((await request('/api/blockchain/validate')).data.valid,true);
});
test('JSON persistence survives reload and keeps the private state outside the public export',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'identity-lab-'));
  try{
    const lab=buildLab({seed:123,people:30});persistLab(lab,directory);
    const restored=loadLab(directory);assert.deepEqual(restored,lab);
    assert.ok(fs.readFileSync(path.join(directory,'blockchain-private.json'),'utf8').includes('privateKey'));
    assert.ok(!fs.readFileSync(path.join(directory,'public.json'),'utf8').includes('privateKey'));
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'identity-lab-'));fs.rmSync(directory,{recursive:true,force:true});}
});
test('failed disk persistence leaves active in-memory chain untouched',async()=>{
  const lab=buildLab({seed:31,people:30});
  const local=createLabServer({lab,persist:true,dataDirectory:path.join(import.meta.dirname,'integration.test.mjs','not-a-directory')});
  await new Promise(resolve=>local.server.listen(0,'127.0.0.1',resolve));
  try{
    const before=structuredClone(local.getLab().chain);
    const r=await fetch(`http://127.0.0.1:${local.server.address().port}/api/blockchain/mine`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(r.status,400);assert.deepEqual(local.getLab().chain,before);
  }finally{local.server.closeAllConnections();await new Promise(resolve=>local.server.close(resolve));}
});
test('atomic snapshot prevents mixed generations after interrupted export updates',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'identity-lab-'));
  try{
    const committed=buildLab({seed:11,people:30});persistLab(committed,directory);
    fs.writeFileSync(path.join(directory,'public.json'),JSON.stringify(buildLab({seed:12,people:30}).publicData));
    const restored=loadLab(directory);assert.deepEqual(restored,committed);
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'identity-lab-'));fs.rmSync(directory,{recursive:true,force:true});}
});
