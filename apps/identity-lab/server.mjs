import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLab, persistLab, loadLab, DATA_DIR } from './lib/storage.mjs';
import { resolveIdentity, evaluateIdentity } from './lib/identity.mjs';
import { publicBlockchain, submitTransfer, mineBlock, validateBlockchain, simulateReorg } from './lib/blockchain.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const MAX_BODY = 32768;
export function createLabServer({lab = loadLab(), persist = true, dataDirectory = DATA_DIR, portal = null} = {}) {
  let state = lab;
  const respond = (res, code, value, extra = {}) => {
    res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra});
    res.end(JSON.stringify(value));
  };
  const body = async req => {
    let bytes = 0, text = '';
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) throw Object.assign(new Error('Żądanie jest zbyt duże.'), {status:413});
      text += chunk;
    }
    try {return text ? JSON.parse(text) : {};} catch {throw Object.assign(new Error('Nieprawidłowy JSON.'), {status:400});}
  };
  const updateChain = operation => {
    const next = {...state,chain:structuredClone(state.chain)};
    const result = operation(next.chain);
    if(persist)persistLab(next,dataDirectory);
    state=next;
    return result;
  };
  const server = http.createServer(async (req,res) => {
    try {
      // All writes originate from this loopback UI or explicit CLI clients.
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return respond(res,403,{error:'Dozwolony jest tylko lokalny host.'});
      const url = new URL(req.url, `http://${host}`);
      const p = url.pathname;
      const write = ['POST','PUT','DELETE','PATCH'].includes(req.method);
      if (write) {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return respond(res,403,{error:'Niedozwolone źródło żądania.'});
        if (!req.headers['content-type']?.startsWith('application/json')) return respond(res,415,{error:'Wymagany Content-Type: application/json.'});
      }
      if (p.startsWith('/api/')) {
        const data = state.publicData;
        if (p === '/api/status' && req.method === 'GET') return respond(res,200,{meta:data.meta, counts:{services:data.services.length, social:data.services.filter(s=>s.category==='social').length, marketplace:data.services.filter(s=>s.category==='marketplace').length, forum:data.services.filter(s=>s.category==='forum').length, accounts:data.accounts.length, people:state.groundTruth.people.length, posts:data.posts.length, listings:data.listings.length, threads:data.threads.length}, synthetic:true, portal});
        if (p === '/api/services' && req.method === 'GET') return respond(res,200,data.services.map(service=>({...service,accounts:data.accounts.filter(a=>a.serviceId===service.id).length, posts:data.posts.filter(a=>a.serviceId===service.id).length, listings:data.listings.filter(a=>a.serviceId===service.id).length, threads:data.threads.filter(a=>a.serviceId===service.id).length})));
        if (p === '/api/accounts' && req.method === 'GET') {
          let accounts = data.accounts;
          const service = url.searchParams.get('service');
          const q = (url.searchParams.get('q') || '').toLocaleLowerCase('pl');
          if (service) accounts = accounts.filter(a=>a.serviceId===service);
          if (q) accounts=accounts.filter(a=>[a.id,a.email,a.username,a.displayName,a.bio,...a.walletAddresses].some(s=>String(s).toLocaleLowerCase('pl').includes(q)));
          const offset = Math.max(0,Number(url.searchParams.get('offset'))||0);
          const limit = Math.min(1000,Math.max(1,Number(url.searchParams.get('limit'))||60));
          return respond(res,200,{total:accounts.length, accounts:accounts.slice(offset,offset+limit)});
        }
        if (p.startsWith('/api/accounts/') && req.method === 'GET') {
          const id=decodeURIComponent(p.slice('/api/accounts/'.length));
          const account=data.accounts.find(a=>a.id===id);
          if (!account) return respond(res,404,{error:'Nie znaleziono profilu.'});
          return respond(res,200,{account, service:data.services.find(s=>s.id===account.serviceId), posts:data.posts.filter(a=>a.accountId===id), listings:data.listings.filter(a=>a.accountId===id), threads:data.threads.filter(a=>a.accountId===id)});
        }
        if (p.startsWith('/api/portal/') && req.method === 'GET') {
          const slug=decodeURIComponent(p.slice('/api/portal/'.length));
          const service=data.services.find(s=>s.slug===slug);
          if (!service) return respond(res,404,{error:'Nie znaleziono portalu.'});
          return respond(res,200,{service, accounts:data.accounts.filter(a=>a.serviceId===service.id), posts:data.posts.filter(a=>a.serviceId===service.id), listings:data.listings.filter(a=>a.serviceId===service.id), threads:data.threads.filter(a=>a.serviceId===service.id)});
        }
        if (p === '/api/search' && req.method === 'GET') return respond(res,200,resolveIdentity((url.searchParams.get('q')||'').slice(0,200),data.accounts,{limit:40}));
        if (p === '/api/resolve' && req.method === 'POST') {
          const b=await body(req);
          if(typeof b.query!=='string'||!b.query.trim()||b.query.length>200)return respond(res,400,{error:'Podaj e-mail, alias lub identyfikator (1–200 znaków).'});
          return respond(res,200,resolveIdentity(b.query.trim(),data.accounts,{limit:Math.min(100,Math.max(1,Number(b.limit)||40))}));
        }
        if (p === '/api/evaluate' && req.method === 'POST') {
          const b=await body(req); const threshold=Number(b.threshold??0.75);
          if(!Number.isFinite(threshold)||threshold<0||threshold>1)return respond(res,400,{error:'Próg musi mieścić się w zakresie 0–1.'});
          return respond(res,200,evaluateIdentity(data.accounts,state.groundTruth,{threshold,maxPairs:12000}));
        }
        if (p === '/api/ground-truth' && req.method === 'GET') return respond(res,200,state.groundTruth);
        if (p === '/api/blockchain' && req.method === 'GET') return respond(res,200,publicBlockchain(state.chain));
        if (p === '/api/blockchain/validate' && req.method === 'GET') return respond(res,200,validateBlockchain(state.chain));
        if (p === '/api/blockchain/transfer' && req.method === 'POST') {
          const input=await body(req);const result=updateChain(chain=>submitTransfer(chain,input));return respond(res,201,{result,blockchain:publicBlockchain(state.chain)});
        }
        if (p === '/api/blockchain/mine' && req.method === 'POST') {
          const input=await body(req);const result=updateChain(chain=>mineBlock(chain,input));return respond(res,201,{result,blockchain:publicBlockchain(state.chain)});
        }
        if (p === '/api/blockchain/reorg' && req.method === 'POST') {
          const input=await body(req);const result=updateChain(chain=>simulateReorg(chain,input));return respond(res,200,{result,blockchain:publicBlockchain(state.chain)});
        }
        if (p === '/api/regenerate' && req.method === 'POST') {
          const b=await body(req); const seed=Number(b.seed??67), people=Number(b.people??180);
          if(!Number.isSafeInteger(seed)||seed<0||seed>2147483647||!Number.isSafeInteger(people)||people<30||people>1000)return respond(res,400,{error:'Wybierz 30–1000 osób i całkowity seed 0–2147483647.'});
          const next=buildLab({seed,people});
          if(persist)persistLab(next,dataDirectory);state=next;
          return respond(res,200,{ok:true,meta:state.publicData.meta,accounts:state.publicData.accounts.length});
        }
        const downloads={'/api/export/public':()=>data,'/api/export/truth':()=>state.groundTruth,'/api/export/blockchain':()=>publicBlockchain(state.chain)};
        if(downloads[p] && req.method === 'GET')return respond(res,200,downloads[p](),{'content-disposition':`attachment; filename="${p.split('/').pop()}.json"`});
        return respond(res,404,{error:'Nie znaleziono endpointu.'});
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return respond(res,405,{error:'Niedozwolona metoda.'});
      if(portal && p==='/'){res.writeHead(302,{location:`/s/${portal}`});return res.end();}
      const staticPath=['/app.js','/styles.css','/favicon.svg'].includes(p)?p:'/index.html';
      const file=path.join(ROOT,'public',staticPath.slice(1));
      res.writeHead(200,{'content-type':MIME[path.extname(file)],'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"});
      if(req.method==='HEAD')return res.end();
      fs.createReadStream(file).pipe(res);
    } catch(error) {respond(res,error.status||400,{error:error.message||'Błąd laboratorium.'});}
  });
  return {server,getLab:()=>state};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const port=Number(process.env.PORT||8787);
  const lab=loadLab();
  const {server,getLab}=createLabServer({lab});
  server.on('error',e=>{console.error(`Nie można uruchomić portu ${port}: ${e.message}`);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Identity Lab: http://127.0.0.1:${port} | ${lab.publicData.services.length} portali | ${lab.publicData.accounts.length} kont | seed ${lab.publicData.meta.seed}`));
  const portals=[];
  if(process.argv.includes('--portals')){
    lab.publicData.services.forEach((service,i)=>{
      // Proxy to the primary server so every portal shares mutations and persistence.
      const proxy=http.createServer((req,res)=>{
        if(req.url==='/'){res.writeHead(302,{location:`/s/${service.slug}`});return res.end();}
        const headers={...req.headers,host:`127.0.0.1:${port}`};
        if(headers.origin===`http://${req.headers.host}`)headers.origin=`http://127.0.0.1:${port}`;
        const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
        upstream.on('error',()=>{res.writeHead(502);res.end('Uruchom główny serwer laboratorium.');});
        req.pipe(upstream);
      });
      proxy.on('error',e=>console.error(`Portal ${service.name}: ${e.message}`));
      proxy.listen(8801+i,'127.0.0.1',()=>console.log(`${service.name}: http://127.0.0.1:${8801+i}`));
      portals.push(proxy);
    });
  }
  const shutdown=()=>{portals.forEach(s=>s.close());server.close(()=>process.exit(0));};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
