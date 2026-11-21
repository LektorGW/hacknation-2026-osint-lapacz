const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => Number(value || 0).toLocaleString('pl-PL');
const pct = value => value == null ? '—' : (value * 100).toLocaleString('pl-PL', {maximumFractionDigits:1}) + '%';
const counted = (value,one,few,many) => {const n=Number(value||0);return `${num(n)} ${n===1?one:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?few:many}`;};
const short = value => String(value || '').length > 23 ? String(value).slice(0,12) + '…' + String(value).slice(-7) : String(value || '');
const date = value => {try {return new Date(value).toLocaleDateString('pl-PL',{day:'numeric',month:'short',year:'numeric'});} catch {return '—';}};
const colors = ['#547a76','#725977','#5d6c95','#9b6955','#627f4d'];
const avatarColor = a => /^#[0-9a-f]{3,8}$/i.test(a?.avatarColor || '') ? a.avatarColor : colors[(a?.username?.length || 0) % colors.length];
const initials = a => (a.displayName || a.username || '?').split(/[\s_.]+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
const avatar = (a,large=false) => `<span class="avatar${large?' large':''}" style="--avatar:${avatarColor(a)}">${esc(initials(a))}</span>`;
const serviceMark = s => `<span class="service-icon" style="--service-color:${esc(s.color)}">${esc(({x:'𝕏',facebook:'f',instagram:'◎',tiktok:'♪',linkedin:'in',allegro:'a',olx:'olx',vinted:'V',ebay:'e',amazon:'a',etsy:'E',sprzedajemy:'S'})[s.slug] || s.name[0])}</span>`;
const paths = {
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  layers:'m12 3 10 6-10 6L2 9z M2 15l10 6 10-6 M2 12l10 6 10-6',
  search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  chain:'m12 3 8 4.5v9L12 21l-8-4.5v-9z m0 0v9 m8-4.5L12 12 4 7.5 M12 12v9',
  chart:'M3 3v18h18 M7 15l4-5 4 3 6-8',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3l-1 3-3 1-2 3 2 3v4l3 2 3-1 3 1 3-2v-4l2-3-2-3-3-1-1-3z',
  download:'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  close:'m6 6 12 12 M6 18 18 6',
  box:'m12 3 9 5-9 5-9-5z M3 8v10l9 5 9-5V8 M12 13v10',
  message:'M21 15a3 3 0 0 1-3 3H8l-6 4V5a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3z',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18',
  check:'m5 12 4 4L20 5',
  activity:'M2 12h4l3-8 6 16 3-8h4',
  key:'M15 5a5 5 0 1 1-4 8l-8 8H1v-4l8-8a5 5 0 0 1 6-4',
  heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8'
};
const icon = name => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name] || paths.grid}"/></svg>`;
const appState = {status:null,services:[],chain:null,category:'all',accountOffset:0,accountQuery:'',portalLimit:18,portalQuery:'',evaluation:null,routeToken:0};
async function api(url,body) {
  const response = await fetch(url, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json();
  if(!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function toast(message,error=false) {const node=$('#toast');node.textContent=message;node.className=`show${error?' error':''}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.className='',5500);}
function serviceOf(id) {return appState.services.find(s=>s.id===id) || {name:id,slug:'',color:'#607090'};}
function goResolve(query) {
  if(location.pathname.startsWith('/s/')) {location.href=`/#resolve?q=${encodeURIComponent(query)}`;return;}
  const next=`#resolve?q=${encodeURIComponent(query)}`;
  if(location.hash===next)renderRoute();else location.hash=next;
}
const stat = (label,value,detail,ico,accent='') => `<div class="stat"><div class="stat-label">${esc(label)}${icon(ico)}</div><strong class="${accent}">${esc(value)}</strong><small>${esc(detail)}</small></div>`;
const navItems=[['overview','Przegląd','grid'],['services','Serwisy','globe'],['accounts','Konta','users'],['resolve','Powiązania','search'],['blockchain','Blockchain','chain'],['benchmark','Benchmark','chart']];
function shell(page,content) {
  const current=navItems.find(n=>n[0]===page) || navItems[0];
  $('#app').innerHTML=`<div class="layout"><aside class="sidebar"><a class="brand" href="/#overview"><span class="brand-icon">${icon('layers')}</span><div>Identity Lab<small>SYNTHETIC ENVIRONMENT</small></div></a><div class="nav-label">LABORATORIUM</div><nav class="nav" aria-label="Nawigacja główna">${navItems.map(([id,label,ico])=>`<a href="/#${id}" class="${id===page?'active':''}">${icon(ico)}<span>${label}</span>${id==='services'?'<span class="count">27</span>':''}</a>`).join('')}</nav><div class="side-bottom"><div class="local-box"><strong>Odizolowane środowisko</strong><p>Wszystkie profile i transakcje są syntetyczne. Serwisy działają lokalnie.</p></div><div class="side-foot"><span>LAB / 067</span><span>v1.0.0</span></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb"><span>Workspace</span><span>/</span><strong>${current[1]}</strong></div><div class="top-actions"><span class="badge">LOKALNE</span><span class="seed">SEED ${appState.status?.meta.seed ?? 67}</span><a class="export-button" href="/api/export/public" download title="Eksport publicznego zbioru">${icon('download')}</a><button data-action="settings" class="quiet" aria-label="Ustawienia zbioru">${icon('settings')}</button></div></header><div class="content">${content}<footer class="content-foot"><span>IDENTITY LAB · DANE W CAŁOŚCI SYNTETYCZNE</span><span>27 PORTALI / BRAK POŁĄCZEŃ Z PRAWDZIWYMI PLATFORMAMI</span></footer></div></main></div>`;
}
function title(eyebrow,heading,description,extra='') {return `<div class="page-title"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(heading)}</h1><p>${esc(description)}</p></div>${extra}</div>`;}
function searchPanel(query='') {return `<section class="card search-panel"><div class="search-heading">${icon('search')}<div><h2>Jeden ślad. Wiele możliwych powiązań.</h2><p>Wpisz e-mail, alias, adres portfela lub identyfikator profilu.</p></div></div><form class="search-form" data-form="resolve"><label class="sr-only" for="identity-query">Szukana tożsamość</label><input id="identity-query" name="query" value="${esc(query)}" placeholder="np. mira.kowal@poczta.test" required maxlength="200" autocomplete="off"><button class="primary" type="submit">${icon('search')}Analizuj powiązania</button></form><div class="query-hints"><span>Wypróbuj scenariusz:</span><button data-query="mira.kowal@poczta.test">wiele aliasów</button><button data-query="rowerzysta">zbieżny nick</button><button data-query="acct-00008">odłączone fake konto</button></div></section>`;}
function overview() {
  const c=appState.status.counts;
  const cats=[['social','Społecznościowe','Profile, wpisy i relacje','users',5],['marketplace','Aukcje i ogłoszenia','Oferty, opisy i sprzedający','box',7],['forum','Fora dyskusyjne','Wątki, odpowiedzi i społeczności','message',15]];
  shell('overview',`${title('Środowisko badawcze','Tożsamości pod lupą.','27 portali. Setki syntetycznych historii. Jedno miejsce do testowania powiązań między kontami.','<span class="pill">REPRODUKOWALNE DANE</span>')}
  <div class="stats">${stat('Aktywne serwisy','27','5 social · 7 marketplace · 15 forów','globe','accent')}${stat('Profile użytkowników',num(c.accounts),`${num(c.people)} ukrytych tożsamości`,'users')}${stat('Wpisy, oferty i wątki',num(c.posts+c.listings+c.threads),`+ odpowiedzi w dyskusjach`,'message')}${stat('Bloki w łańcuchu',num(appState.chain.summary.blocks),`${num(appState.chain.summary.wallets)} portfeli · token LAB`,'chain','purple')}</div>
  ${searchPanel()}
  <div class="grid2"><section class="card"><div class="card-title"><div><h2>Ekosystem testowy</h2><small>Osobne portale, wspólny zbiór obserwacji</small></div><a href="#services">Wszystkie serwisy</a></div><div class="service-lines">${cats.map(([cat,name,desc,ico,count])=>`<a class="service-line" href="#services" data-category-link="${cat}"><span class="service-icon" style="--service-color:${cat==='social'?'#759ce5':cat==='marketplace'?'#e69b67':'#b3df78'}">${icon(ico)}</span><div class="flex"><strong>${name}</strong><p>${desc}</p><div class="bar"><span style="width:${count/27*100}%;background:${cat==='social'?'#759ce5':cat==='marketplace'?'#e69b67':'#b3df78'}"></span></div></div><span class="number">${String(count).padStart(2,'0')}</span></a>`).join('')}</div></section>
  <section class="card"><div class="card-title"><div><h2>Ślady tworzą hipotezy</h2><small>Przykładowy układ powiązań</small></div><span class="tag green">DEMO</span></div>${demoGraph()}<div class="legend"><span><i></i>mocny sygnał</span><span><i class="weak"></i>słaba poszlaka</span></div></section></div>
  <div class="grid2 mt"><section class="card card-pad"><div class="eyebrow">Scenariusze</div><h2>Nie każda zbieżność oznacza tę samą osobę</h2><p class="mb" style="margin-top:10px;font-size:.85rem">Zbiór obejmuje zmienione aliasy, kilka skrzynek pocztowych, profile pod przybraną nazwą i niezależne osoby o tym samym nicku.</p><div class="tags"><span class="tag">zwykłe konta</span><span class="tag purple">multikonta</span><span class="tag orange">fake persony</span><span class="tag">mylące podobieństwa</span></div></section><section class="card card-pad"><div class="eyebrow">Walidacja</div><h2>Sprawdź trafienia względem wzorca</h2><p style="margin:10px 0 18px;font-size:.85rem">Ocena modelu korzysta z osobnego pliku prawdy wzorcowej. Wyszukiwanie nigdy go nie odczytuje.</p><a class="link-button" href="#benchmark">Otwórz benchmark</a></section></div>`);
}
function demoGraph() {
  const nodes=[['X',95,55,true],['Instagram',330,55,true],['OLX',365,170,false],['Forum',72,175,true],['e-mail',215,210,false]];
  return `<div class="diagram"><svg role="img" aria-label="Przykładowy graf: profil centralny połączony z pięcioma śladami" viewBox="0 0 440 250">${nodes.map(([name,x,y,strong])=>`<path class="edge ${strong?'strong-edge':''}" d="M220 115L${x} ${y}"/>`).join('')}${nodes.map(([name,x,y])=>`<circle class="node" cx="${x}" cy="${y}" r="24"/><text x="${x}" y="${y+42}" text-anchor="middle">${name}</text><circle cx="${x}" cy="${y}" r="4" fill="#b5c7db"/>`).join('')}<circle class="center" cx="220" cy="115" r="36"/><text class="center-label" x="220" y="119" text-anchor="middle">mira_k</text></svg></div>`;
}
function servicesPage() {
  const category=appState.category;
  const services=appState.services.filter(s=>category==='all'||s.category===category);
  const catLabels={social:'Społecznościowy',marketplace:'Aukcje i ogłoszenia',forum:'Forum dyskusyjne'};
  shell('services',`${title('27 niezależnych przestrzeni','Serwisy testowe','Otwórz dowolny portal i przejrzyj jego profile oraz opublikowane treści. Wszystkie dane pochodzą z tego samego scenariusza.')}
  <div class="tabs" role="group" aria-label="Rodzaj serwisu">${[['all','Wszystkie',27],['social','Społecznościowe',5],['marketplace','Aukcyjne',7],['forum','Fora',15]].map(([id,label,count])=>`<button data-category="${id}" class="${category===id?'active':''}" aria-pressed="${category===id}">${label}<span class="tag">${count}</span></button>`).join('')}</div>
  <div class="service-grid">${services.map(s=>`<article class="card service-card"><div class="service-top">${serviceMark(s)}<div><h3>${esc(s.name)}</h3><small>${catLabels[s.category]}</small></div></div><p>${esc(s.description)}</p><span class="domain">${esc(s.domain)}</span><div class="service-bottom"><small>${num(s.accounts)} kont · ${num(s.posts+s.listings+s.threads)} treści</small><a class="visit" href="/s/${esc(s.slug)}">Otwórz portal</a></div></article>`).join('')}</div><div class="note mt">Domeny .test oznaczają wirtualne serwisy. Portale otwierają się lokalnie pod /s/nazwa. Tryb <span class="mono">npm run portals</span> udostępnia również 27 osobnych portów 8801–8827.</div>`);
}
function accountRow(a) {return `<tr><td><div class="account-cell">${avatar(a)}<div><strong>${esc(a.displayName)}</strong><small>@${esc(a.username)}</small></div></div></td><td>${esc(serviceOf(a.serviceId).name)}</td><td class="mono">${esc(a.email)}</td><td>${esc(a.location)}</td><td><button data-profile="${esc(a.id)}" class="quiet">Profil</button></td></tr>`;}
async function accountsPage(token) {
  const query=appState.accountQuery;
  shell('accounts',`${title('Publiczne obserwacje','Katalog kont','Profile są widoczne bez etykiet ordinary / multi / fake. Te etykiety należą do ukrytego wzorca.')}
  <form class="search-form mb" data-form="accounts"><label class="sr-only" for="account-filter">Filtruj konta</label><input id="account-filter" name="query" value="${esc(query)}" placeholder="Filtruj: nazwa, e-mail, alias, opis…"><button type="submit">${icon('search')}Filtruj</button></form><section class="card" id="accounts-table"><div class="loading">Wczytywanie profili…</div></section>`);
  try {
    const result=await api(`/api/accounts?limit=35&offset=${appState.accountOffset}&q=${encodeURIComponent(query)}`);
    if(token!==appState.routeToken)return;
    $('#accounts-table').innerHTML=`${result.accounts.length?`<div class="table-wrap"><table><thead><tr><th>Profil</th><th>Serwis</th><th>E-mail</th><th>Lokalizacja</th><th>Akcja</th></tr></thead><tbody>${result.accounts.map(accountRow).join('')}</tbody></table></div>`:'<div class="empty">Nie znaleziono pasujących kont.</div>'}<div class="table-actions"><small>${num(result.total)} kont · strona ${Math.floor(appState.accountOffset/35)+1}</small><div class="actions-row"><button data-page="prev" ${appState.accountOffset===0?'disabled':''}>Poprzednia</button><button data-page="next" ${appState.accountOffset+35>=result.total?'disabled':''}>Następna</button></div></div>`;
  } catch(e){if(token===appState.routeToken)$('#accounts-table').innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
async function resolvePage(query,token) {
  shell('resolve',`${title('Analiza poszlak','Mapa powiązań','Każda hipoteza ma jawne przesłanki. Wskaźnik podobieństwa pomaga porządkować wyniki; nie jest skalibrowanym prawdopodobieństwem.')}${searchPanel(query)}<div id="resolve-results">${query?'<div class="loading">Porównywanie śladów między portalami…</div>':`<div class="card empty">${icon('search')}<h2>Zacznij od jednego śladu</h2><p>Użyj przykładu powyżej lub skopiuj dane dowolnego konta.</p></div>`}</div>`);
  if(!query)return;
  try {
    const r=await api('/api/resolve',{query,limit:40});
    if(token!==appState.routeToken)return;
    appState.resolution=r;
    const inferred=r.matches.filter(m=>!r.anchors.includes(m.account.id));
    $('#resolve-results').innerHTML=r.matches.length?`<div class="resolve-layout"><div class="stack"><section class="card"><div class="card-title"><div><h2>Graf obserwacji</h2><small>${r.anchors.length} punktów startowych · ${num(r.totalMatches??r.matches.length)} wyników</small></div></div>${resolutionGraph(r)}<div class="legend"><span><i></i>silniejsza przesłanka</span><span><i class="weak"></i>niepewne powiązanie</span></div></section><div class="note"><strong>Jak czytać wynik</strong><br>„Trafienie zapytania” oznacza znalezienie tekstu w profilu. Wskaźnik procentowy na pozostałych kontach opisuje siłę hipotezy o wspólnej osobie.<br><br>${(r.caveats||[]).slice(0,3).map(esc).join('<br><br>')}</div></div><div><div class="actions-row mb"><h2>${num(r.matches.length)} profili</h2><span class="tag">${inferred.length} powiązań do sprawdzenia</span></div><div class="result-list">${r.matches.map((m,i)=>resultCard(m,i,r)).join('')}</div></div></div>`:`<div class="card empty">${icon('search')}<h2>Brak obserwacji dla tego zapytania</h2><p>Spróbuj pełnego e-maila, innego aliasu lub identyfikatora konta.</p></div>`;
  }catch(e){if(token===appState.routeToken)$('#resolve-results').innerHTML=`<div class="note warning">${esc(e.message)}</div>`;}
}
function resultCard(m,i,r) {
  const a=m.account, s=serviceOf(a.serviceId), anchor=r.anchors.includes(a.id);
  return `<article class="card result"><div class="result-top">${avatar(a)}<div class="flex"><h3>${esc(a.displayName)}</h3><small>@${esc(a.username)} · ${esc(s.name)}</small></div><div class="confidence ${m.probability<.65?'low':''}">${anchor?'◎':pct(m.probability)}<small>${anchor?'trafienie zapytania':'wskaźnik podobieństwa'}</small></div></div><div class="mono subtle wrapped" style="margin-top:12px">${esc(a.email)}</div><div class="evidence">${anchor?'<span class="tag green">punkt startowy</span>':''}${(m.evidence||[]).slice(0,5).map(e=>`<span class="tag ${e.weight>=3?'green':''}">${esc(e.label||e.signal)}</span>`).join('')}${!anchor&&m.probability<.5?'<span class="tag orange">słaba hipoteza</span>':''}</div><div class="result-actions"><button data-profile="${esc(a.id)}">Profil</button><button data-evidence="${i}" aria-expanded="false">Przesłanki</button><a href="/s/${esc(s.slug)}/profile/${esc(a.id)}">Zobacz w serwisie</a></div><div class="result-details" id="evidence-${i}" hidden></div></article>`;
}
function resolutionGraph(r) {
  const matches=r.matches.slice(0,11), center=matches.find(m=>r.anchors.includes(m.account.id))||matches[0];
  const others=matches.filter(m=>m!==center), cx=220,cy=135;
  const points=others.map((m,i)=>{const angle=2*Math.PI*i/Math.max(1,others.length)-Math.PI/2;return {m,x:cx+160*Math.cos(angle),y:cy+94*Math.sin(angle)};});
  return `<div class="diagram"><svg role="img" aria-label="Graf hipotez powiązań między kontami" viewBox="0 0 440 280">${points.map(({m,x,y})=>`<path class="edge ${m.probability>=.75?'strong-edge':''}" d="M${cx} ${cy}L${x} ${y}"/>`).join('')}${points.map(({m,x,y})=>`<a class="graph-node" href="/s/${esc(serviceOf(m.account.serviceId).slug)}/profile/${esc(m.account.id)}"><circle class="node" cx="${x}" cy="${y}" r="18"/><text x="${x}" y="${y+4}" text-anchor="middle" style="font-size:10px">${esc(serviceOf(m.account.serviceId).name.slice(0,2))}</text><text x="${x}" y="${y+33}" text-anchor="middle" style="font-size:9px">${esc(m.account.username.slice(0,15))}</text></a>`).join('')}<circle class="center" cx="${cx}" cy="${cy}" r="35"/><text class="center-label" x="${cx}" y="${cy+4}" text-anchor="middle" style="font-size:10px">${esc(center.account.username.slice(0,13))}</text></svg></div>`;
}
async function blockchainPage(token) {
  shell('blockchain',`${title('Sieć LAB / proof of work','Blockchain w praktyce','Podpisane transakcje, UTXO i rzeczywisty wybór gałęzi według wykonanej pracy. Token LAB służy wyłącznie do testów.')}<div id="chain-content" class="loading">Odtwarzanie rejestru…</div>`);
  try {const chain=await api('/api/blockchain');if(token!==appState.routeToken)return;appState.chain=chain;renderChain();}catch(e){if(token===appState.routeToken)$('#chain-content').innerHTML=`<div class="note warning">${esc(e.message)}</div>`;}
}
function renderChain() {
  const c=appState.chain,s=c.summary;
  const walletName=address=>c.wallets.find(w=>w.address===address)?.label||short(address);
  const options=c.wallets.map(w=>`<option value="${esc(w.address)}">${esc(w.label)} · ${num(w.availableBalance)} LAB</option>`).join('');
  $('#chain-content').className='';
  $('#chain-content').innerHTML=`<div class="stats">${stat('Wysokość łańcucha',num(s.height),`${num(s.blocks)} bloków z genesis`,'chain','purple')}${stat('Transakcje',num(s.transactions),'potwierdzone w łańcuchu','activity')}${stat('Mempool',num(s.pending),'oczekujące na potwierdzenie','layers',s.pending?'orange':'')}${stat('Podaż LAB',num(s.supply),`${num(s.wallets)} portfeli testowych`,'key','accent')}</div>
  <section class="card"><div class="card-title"><div><h2>Eksplorator bloków</h2><small>Ostatnie bloki · PoW: ${esc(c.difficulty)} zer hex · nagroda: ${num(c.reward)} LAB</small></div><a href="/api/export/blockchain" download>Eksport JSON</a></div><div class="chain-strip">${c.blocks.slice(-8).map(b=>`<button class="block" data-block="${b.height}"><small>${b.height===0?'GENESIS':'BLOK'}</small><strong>#${b.height}</strong><small>${b.transactions.length} transakcji</small><div class="hash">${esc(b.hash.slice(0,16))}…</div></button>`).join('')}</div><div class="chain-ops"><button class="primary" data-action="mine">${icon('chain')}Wykop blok</button><button data-action="validate">${icon('check')}Sprawdź integralność</button><button data-action="reorg">Symuluj reorganizację</button></div><div class="chain-message" id="chain-message">Wydobycie obejmuje mempool i nagrodę. Reorganizacja buduje konkurencyjną gałąź o większej pracy.</div></section>
  <div class="grid2 mt"><div class="stack"><section class="card"><div class="card-title"><h2>Nowa transakcja</h2><span class="tag purple">Ed25519</span></div><form class="form-grid card-pad" data-form="transfer"><label>Nadawca<select name="from" id="transfer-from">${options}</select></label><label>Odbiorca<select name="to" id="transfer-to">${options}</select></label><div class="form-row"><label>Kwota w LAB<input name="amount" type="number" min="1" step="1" value="25" required></label><label>Opłata w LAB<input name="fee" type="number" min="0" step="1" value="1" required></label></div><button type="submit" class="primary">Podpisz i dodaj do mempoolu</button><small>Testowe klucze pozostają w stanie lokalnego symulatora. Przeglądarka wysyła jedynie parametry przelewu.</small></form></section><div class="note">${esc(c.notice||'Jednoprocesowy symulator: brak połączeń P2P i rzeczywistej kryptowaluty.')}<br><br>Przelew między różnymi adresami nie oznacza, że portfele należą do jednej osoby.</div></div>
  <section class="card"><div class="card-title"><h2>Portfele testowe</h2><span class="tag">${num(c.wallets.length)} adresów</span></div><div class="wallet-list">${c.wallets.map(w=>`<div class="wallet-row"><div><strong>${esc(w.label)}</strong><small title="${esc(w.address)}">${esc(short(w.address))}</small><button class="quiet" data-query="${esc(w.address)}" style="padding:3px 0;border:0;font-size:.65rem;color:var(--muted)">Znajdź profile z tym adresem</button></div><div class="balance">${num(w.balance)} LAB<small>po mempoolu: ${num(w.availableBalance)}</small></div></div>`).join('')}</div></section></div>
  <section class="card mt"><div class="card-title"><h2>Oczekujące transakcje</h2><span class="tag">${c.mempool.length}</span></div>${c.mempool.length?`<div class="table-wrap"><table><thead><tr><th>Id transakcji</th><th>Wejścia</th><th>Wyjścia</th><th>Opłata</th></tr></thead><tbody>${c.mempool.map(tx=>`<tr><td class="mono">${esc(short(tx.id))}</td><td>${tx.inputs.length} UTXO</td><td>${tx.outputs.map(o=>`${num(o.amount)} LAB · ${esc(walletName(o.address))}`).join('<br>')}</td><td>${num(tx.fee)} LAB</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Mempool jest pusty. Wyślij przelew, a następnie wykop blok.</div>'}</section>
  ${c.events?.length?`<section class="card mt"><div class="card-title"><h2>Zdarzenia sieci</h2><span class="tag">${num(s.orphans)} osieroconych bloków</span></div><div class="card-pad">${c.events.slice(-5).reverse().map(e=>`<div class="key-val"><span>${esc(e.type||'event')}</span><strong class="wrapped mono">${esc(e.message||JSON.stringify(e))}</strong></div>`).join('')}</div></section>`:''}`;
  if($('#transfer-to')?.options.length>1)$('#transfer-to').selectedIndex=1;
}
function benchmarkPage() {
  shell('benchmark',`${title('Prawda wzorcowa / ground truth','Mierz jakość hipotez','Sprawdź wykryte i pominięte pary kont. Wzorzec służy do oceny; nie bierze udziału w dopasowywaniu.')}
  <div class="grid2"><section class="card card-pad"><h2>Uruchom ocenę</h2><p style="font-size:.85rem;margin:10px 0 22px">Benchmark dobiera do 12 000 par, uwzględnia różną częstość pozytywnych i negatywnych przypadków oraz osobno sprawdza mylące aliasy.</p><form class="benchmark-controls" data-form="benchmark"><label>Próg uznania powiązania<select name="threshold"><option value="0.75">75% · domyślny</option><option value="0.5">50% · szersze dopasowanie</option><option value="0.9">90% · mocne sygnały</option><option value="0.98">98% · bardzo mocne sygnały</option></select></label><button type="submit" class="primary">${icon('chart')}Oceń model</button></form></section><section class="card card-pad"><h2>Oddzielony wzorzec</h2><p style="font-size:.85rem;margin:10px 0 20px">Własny benchmark może korzystać z przypisań konto → osoba oraz ról ordinary, multi i fake. Pobranie wzorca jest jawnym krokiem testowym.</p><div class="actions-row"><a href="/api/export/truth" download class="link-button">Pobierz ground-truth.json</a><button data-action="truth">Pokaż scenariusze</button></div></section></div>
  <div class="note warning mt">Procenty dopasowania są heurystycznymi wskaźnikami, bez kalibracji na niezależnym zbiorze. Metryki opisują wyłącznie ten syntetyczny scenariusz. Mała próba może pominąć rzadkie fałszywe trafienia.</div><div id="benchmark-results" class="mt">${appState.evaluation?benchmarkResults(appState.evaluation):''}</div>`);
}
function benchmarkResults(r) {
  const audit=r.hardNegativeAudit;
  const note=audit?`<div class="note ${audit.falsePositives?'warning':'green'} mb"><strong>Kontrolowany audyt mylących poszlak:</strong> ${counted(audit.pairs,'para','pary','par')} różnych osób; ${counted(audit.falsePositives,'fałszywe powiązanie','fałszywe powiązania','fałszywych powiązań')}. Wspólny portfel: ${counted(audit.bySignal?.sharedWallet?.falsePositives,'fałszywe powiązanie','fałszywe powiązania','fałszywych powiązań')} (sprawdzono ${counted(audit.bySignal?.sharedWallet?.pairs,'parę','pary','par')}). Ten audyt jest oddzielny od losowej próby poniżej.</div>`:'';
  return note+benchmarkReport(r);
}
function benchmarkReport(r) {
  const c=r.confusion||{};
  return `<div class="benchmark-metrics">${stat('Precision',pct(r.precision),'oszacowana precyzja powiązań','chart')}${stat('Recall',pct(r.recall),'odsetek odnalezionych par osoby','users')}${stat('F1',pct(r.f1),'równowaga precyzji i czułości','activity')}</div><div class="grid2 mt"><section class="card"><div class="card-title"><h2>Macierz pomyłek w próbie</h2><span class="tag">SUROWE LICZNOŚCI</span></div><div class="matrix"><div class="good"><small>Trafne powiązania · TP</small><strong>${num(c.tp)}</strong></div><div><small>Fałszywe powiązania · FP</small><strong>${num(c.fp)}</strong></div><div><small>Pominięte powiązania · FN</small><strong>${num(c.fn)}</strong></div><div class="good"><small>Trafne odrzucenia · TN</small><strong>${num(c.tn)}</strong></div></div></section><section class="card card-pad"><h2>Metoda i ograniczenia</h2><div class="key-val"><span>Próg</span><strong>${pct(r.threshold)}</strong></div><div class="key-val"><span>Porównane pary</span><strong>${num((c.tp||0)+(c.fp||0)+(c.tn||0)+(c.fn||0))}</strong></div><p style="margin-top:15px;font-size:.8rem">Precision / recall / F1 są ważone częstością doboru par. Macierz pokazuje surową próbę i nie służy bezpośrednio do obliczania precyzji populacyjnej.</p><details class="tx-details"><summary>Szczegóły próby i audytu trudnych negatywów</summary><pre>${esc(JSON.stringify({sample:r.sample,hardNegativeAudit:r.hardNegativeAudit,caveats:r.caveats},null,2))}</pre></details></section></div><section class="card card-pad mt"><h2>Pełny wynik benchmarku</h2><details class="tx-details"><summary>Pokaż metryki i przykłady błędów</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details></section>`;
}
async function showProfile(id) {
  try {
    const {account:a,service:s,posts,listings,threads}=await api(`/api/accounts/${encodeURIComponent(id)}`);
    openModal('Profil syntetyczny',`<div class="profile-heading">${avatar(a,true)}<div><h2>${esc(a.displayName)}</h2><p>@${esc(a.username)} · ${esc(s.name)}</p></div></div><div class="profile-bio">${esc(a.bio)}</div><dl class="profile-fields"><div><dt>E-mail</dt><dd class="mono">${esc(a.email)}</dd></div><div><dt>Lokalizacja</dt><dd>${esc(a.location)}</dd></div><div><dt>Id konta</dt><dd class="mono">${esc(a.id)}</dd></div><div><dt>Dołączono</dt><dd>${date(a.joinedAt)}</dd></div><div><dt>Zainteresowania</dt><dd>${esc(a.interests.join(', '))}</dd></div><div><dt>Aktywne godziny</dt><dd>${a.activeHours.map(h=>`${h}:00`).join(', ')}</dd></div>${a.walletAddresses.length?`<div style="grid-column:1/-1"><dt>Publiczne adresy portfeli</dt><dd class="mono">${a.walletAddresses.map(esc).join('<br>')}</dd></div>`:''}</dl><div class="tags"><span class="tag">${posts.length} wpisów</span><span class="tag">${listings.length} ofert</span><span class="tag">${threads.length} wątków</span></div>`,`<button class="primary" data-query="${esc(a.id)}">Analizuj powiązania</button><button data-close>Zamknij</button><a href="/s/${esc(s.slug)}/profile/${esc(a.id)}">Otwórz w portalu</a>`);
  }catch(e){toast(e.message,true);}
}
let modalFocus;
function openModal(heading,body,footer='') {
  modalFocus=document.activeElement;
  $('#overlay').innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${esc(heading)}</h2><button data-close class="quiet" aria-label="Zamknij okno">${icon('close')}</button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}</section></div>`;
  $('.modal [data-close]')?.focus();
}
function closeModal() {$('#overlay').innerHTML='';modalFocus?.focus();}
async function settings() {
  openModal('Nowy scenariusz testowy',`<p class="mb">Zastąp lokalny zbiór i zresetuj blockchain. To odtworzy wszystkie dane z wybranego ziarna.</p><form class="form-grid" data-form="regenerate"><div class="form-row"><label>Ziarno (seed)<input type="number" name="seed" min="0" max="2147483647" value="${appState.status.meta.seed}" required></label><label>Liczba fikcyjnych osób<input type="number" name="people" min="30" max="1000" value="${appState.status.counts.people}" required></label></div><div class="note warning">Dotychczasowe testowe przelewy i zmiany łańcucha zostaną zastąpione. Możesz najpierw pobrać eksport JSON.</div><button class="primary" type="submit">Wygeneruj i zastąp dane</button></form>`);
}
async function chainAction(action,button) {
  button.disabled=true;
  try {
    if(action==='validate') {
      const r=await api('/api/blockchain/validate');
      $('#chain-message').textContent=r.valid?'Integralność poprawna: podpisy, UTXO, Merkle, PoW i podaż zweryfikowane.':`Błąd integralności: ${r.errors.join('; ')}`;
      toast(r.valid?'Łańcuch przeszedł pełną walidację.':'Walidacja wykryła błąd.',!r.valid);
    }else{
      const r=await api(`/api/blockchain/${action}`,action==='reorg'?{depth:1}:{});
      appState.chain=r.blockchain;renderChain();
      $('#chain-message').textContent=action==='mine'?'Wykopano nowy blok. Transakcje z mempoolu otrzymały potwierdzenie.':'Wybrano konkurencyjną gałąź o większej pracy. Poprzednie bloki trafiły do archiwum.';
      toast(action==='mine'?'Nowy blok dołączony do łańcucha.':'Zakończono reorganizację.');
    }
  }catch(e){toast(e.message,true);}finally{button.disabled=false;}
}
const portalState = {data:null};
function portalAuthor(a,createdAt) {return `<div class="post-author">${avatar(a)}<div><button data-profile="${esc(a.id)}"><strong>${esc(a.displayName)}</strong></button><small>@${esc(a.username)} · ${date(createdAt)}</small></div></div>`;}
async function portalPage(slug,profileId,token) {
  $('#app').innerHTML='<div class="loading">Otwieranie portalu testowego…</div>';
  try {
    const data=await api(`/api/portal/${encodeURIComponent(slug)}`);
    if(token!==appState.routeToken)return;
    portalState.data=data;
    renderPortal();
    if(profileId)await showProfile(profileId);
  }catch(e){$('#app').innerHTML=`<div class="content"><h1>Nie znaleziono portalu</h1><p class="mt">${esc(e.message)}</p><p class="mt"><a href="/">Wróć do laboratorium</a></p></div>`;}
}
function renderPortal() {
  const d=portalState.data,s=d.service;
  const getAccount=id=>d.accounts.find(a=>a.id===id)||{id,displayName:'Profil testowy',username:id,avatarColor:'#586b80'};
  const q=appState.portalQuery.toLocaleLowerCase('pl');
  const includes=(item,keys)=>!q||[...keys.map(k=>item[k]),getAccount(item.accountId).username,getAccount(item.accountId).displayName].some(v=>String(v||'').toLocaleLowerCase('pl').includes(q));
  let items=s.category==='social'?d.posts.filter(p=>includes(p,['text'])):s.category==='marketplace'?d.listings.filter(p=>includes(p,['title','description','category'])):d.threads.filter(p=>includes(p,['title','text']));
  items=[...items].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const displayed=items.slice(0,appState.portalLimit);
  const social=displayed.map(p=>`<article class="card post">${portalAuthor(getAccount(p.accountId),p.createdAt)}${s.slug==='instagram'?`<div class="listing-art mb" style="height:200px;background:linear-gradient(140deg,#475c71,#1e3730)">${icon('globe')}</div>`:''}${s.slug==='tiktok'?'<div class="tag purple mb">Opis syntetycznego materiału wideo</div>':''}<div class="post-text">${esc(p.text)}</div><div class="post-footer"><span>♡ ${num(p.likes)}</span><span>${s.slug==='linkedin'?'Aktualność zawodowa':'Wpis syntetyczny'}</span></div></article>`).join('');
  const listings=displayed.map((p,i)=>`<article class="card"><div class="listing-art" style="background:linear-gradient(${120+i*15}deg,${s.color}66,#1c2735)">${icon(p.category?.includes('książ')?'layers':'box')}</div><div class="listing-content"><span class="tag">${esc(p.category)}</span><h3 style="margin-top:10px">${esc(p.title)}</h3><span class="price">${Number(p.price).toLocaleString('pl-PL')} zł</span><p>${esc(p.description)}</p><p>${esc(getAccount(p.accountId).location)} · ${date(p.createdAt)}</p><button data-profile="${esc(p.accountId)}">Sprzedający: ${esc(getAccount(p.accountId).username)}</button></div></article>`).join('');
  const threads=displayed.map(p=>`<article class="card thread"><h2>${esc(p.title)}</h2>${portalAuthor(getAccount(p.accountId),p.createdAt)}<p>${esc(p.text)}</p><div class="replies">${(p.replies||[]).slice(0,3).map(reply=>`<div class="reply">${portalAuthor(getAccount(reply.accountId),reply.createdAt)}<p>${esc(reply.text)}</p></div>`).join('')}</div><div class="post-footer"><span>${(p.replies||[]).length} odpowiedzi</span><span>Wątek syntetyczny</span></div></article>`).join('');
  $('#app').innerHTML=`<div class="portal" style="--service-color:${esc(s.color)}"><div class="portal-banner">SYMULACJA · fikcyjne profile i treści · ${esc(s.domain)} · brak powiązania z prawdziwą platformą</div><header class="portal-header"><div class="portal-brand">${esc(s.name)}</div><a href="/#services">Wróć do Identity Lab</a></header><main class="portal-body"><div class="portal-intro"><div><div class="eyebrow">${s.category==='social'?'Społeczność':s.category==='marketplace'?'Aukcje i ogłoszenia':'Forum dyskusyjne'}</div><h1>${s.category==='social'?'Co słychać w społeczności?':s.category==='marketplace'?'Znajdź coś dla siebie.':'Rozmowy, które łączą.'}</h1><p>${esc(s.description)}</p></div><span class="pill">${d.accounts.length} KONT · ${items.length} TREŚCI</span></div><form class="search-form mb portal-search" data-form="portal"><label class="sr-only" for="portal-filter">Szukaj w portalu</label><input id="portal-filter" name="query" value="${esc(appState.portalQuery)}" placeholder="Szukaj treści lub użytkownika…"><button type="submit">Szukaj</button></form>${s.category==='marketplace'?`<div class="market-grid">${listings||'<div class="empty">Nie znaleziono ofert.</div>'}</div>`:`<div class="portal-columns"><section class="feed">${(s.category==='social'?social:threads)||'<div class="card empty">Brak pasujących treści.</div>'}</section><aside><section class="card"><div class="card-title"><h2>Uczestnicy społeczności</h2></div><div class="profile-links">${d.accounts.slice(0,12).map(a=>`<button data-profile="${esc(a.id)}">${avatar(a)}<div><strong>${esc(a.displayName)}</strong><small>@${esc(a.username)}</small></div></button>`).join('')}</div></section><div class="note mt">Każdy profil ma osobny identyfikator i dane kontaktowe. Możesz otworzyć profil i przeanalizować jego powiązania w laboratorium.</div></aside></div>`}${items.length>displayed.length?'<div class="pager"><button data-action="portal-more">Pokaż kolejne treści</button></div>':''}<footer class="content-foot"><span>PORTAL TESTOWY · ${esc(s.domain)}</span><span>WYŁĄCZNIE DANE SYNTETYCZNE</span></footer></main></div>`;
}
async function refreshState() {
  const [status,services,chain]=await Promise.all([api('/api/status'),api('/api/services'),api('/api/blockchain')]);
  Object.assign(appState,{status,services,chain});
}
async function renderRoute() {
  const token=++appState.routeToken;
  const portal=/^\/s\/([^/]+)(?:\/profile\/([^/]+))?\/?$/.exec(location.pathname);
  if(portal) {await portalPage(decodeURIComponent(portal[1]),portal[2]?decodeURIComponent(portal[2]):null,token);return;}
  const [page='overview',search='']=(location.hash.slice(1)||'overview').split('?');
  const query=new URLSearchParams(search).get('q')||'';
  if(page==='services')servicesPage();
  else if(page==='accounts')await accountsPage(token);
  else if(page==='resolve')await resolvePage(query,token);
  else if(page==='blockchain')await blockchainPage(token);
  else if(page==='benchmark')benchmarkPage();
  else overview();
  window.scrollTo({top:0,behavior:'instant'});
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button,a');
  if(!button)return;
  if(button.hasAttribute('data-close')) {closeModal();return;}
  if(button.dataset.query) {closeModal();goResolve(button.dataset.query);return;}
  if(button.dataset.profile) {event.preventDefault();await showProfile(button.dataset.profile);return;}
  if(button.hasAttribute('data-category-link')) {appState.category=button.dataset.categoryLink;return;}
  if(button.hasAttribute('data-category')) {appState.category=button.dataset.category;servicesPage();return;}
  if(button.hasAttribute('data-page')) {appState.accountOffset=Math.max(0,appState.accountOffset+(button.dataset.page==='next'?35:-35));renderRoute();return;}
  if(button.hasAttribute('data-evidence')) {
    const index=Number(button.dataset.evidence),m=appState.resolution?.matches[index],node=$(`#evidence-${index}`);
    if(!m||!node)return;
    node.hidden=!node.hidden;button.setAttribute('aria-expanded',String(!node.hidden));
    node.innerHTML=`${m.via?`<p>Porównano z kontem <span class="mono">${esc(typeof m.via==='object'?JSON.stringify(m.via):m.via)}</span>.</p>`:''}${m.evidence.map(e=>`<div><strong>${esc(e.label||e.signal)}</strong><br>${esc(e.detail)} <small>Waga: ${esc(e.weight)}</small></div>`).join('')}<p style="margin-top:10px">${(m.caveats||[]).map(esc).join(' ')}</p>`;
    return;
  }
  if(button.hasAttribute('data-block')) {
    const b=appState.chain.blocks.find(b=>b.height===Number(button.dataset.block));
    if(b)openModal(`Blok #${b.height}`,`<div class="tags mb"><span class="tag purple">${b.transactions.length} transakcji</span><span class="tag">nonce ${num(b.nonce)}</span></div><p class="mono wrapped">${esc(b.hash)}</p><details class="tx-details" open><summary>Nagłówek i transakcje</summary><pre>${esc(JSON.stringify(b,null,2))}</pre></details>`);
    return;
  }
  const action=button.dataset.action;
  if(action==='settings')settings();
  if(['mine','reorg','validate'].includes(action))await chainAction(action,button);
  if(action==='portal-more') {appState.portalLimit+=18;renderPortal();}
  if(action==='truth') {
    try {
      const truth=await api('/api/ground-truth');
      const roles={};truth.accountLinks.forEach(l=>roles[l.role]=(roles[l.role]||0)+1);
      openModal('Jawny podgląd wzorca',`<div class="tags mb">${Object.entries(roles).map(([role,count])=>`<span class="tag">${esc(role)}: ${num(count)}</span>`).join('')}</div><p class="mb">Scenariusze generatora i ich oczekiwane powiązania:</p><details class="tx-details" open><summary>Scenariusze</summary><pre>${esc(JSON.stringify(truth.scenarios,null,2))}</pre></details>`,`<button data-close>Zamknij</button><a href="/api/export/truth" download>Pobierz pełny wzorzec</a>`);
    }catch(e){toast(e.message,true);}
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.dataset.form)return;event.preventDefault();
  const fields=Object.fromEntries(new FormData(form));const type=form.dataset.form;
  if(type==='resolve') {goResolve(fields.query.trim());return;}
  if(type==='accounts') {appState.accountQuery=fields.query.trim();appState.accountOffset=0;renderRoute();return;}
  if(type==='portal') {appState.portalQuery=fields.query.trim();appState.portalLimit=18;renderPortal();return;}
  const button=$('button[type="submit"]',form);if(button)button.disabled=true;
  try {
    if(type==='transfer') {const r=await api('/api/blockchain/transfer',{...fields,amount:Number(fields.amount),fee:Number(fields.fee)});appState.chain=r.blockchain;renderChain();toast('Transakcja podpisana. Czeka na wykopanie bloku.');}
    if(type==='benchmark') {
      $('#benchmark-results').innerHTML='<div class="loading">Porównywanie par z prawdą wzorcową…</div>';
      const r=await api('/api/evaluate',{threshold:Number(fields.threshold)});appState.evaluation=r;
      if($('#benchmark-results'))$('#benchmark-results').innerHTML=benchmarkResults(r);
    }
    if(type==='regenerate') {
      await api('/api/regenerate',{seed:Number(fields.seed),people:Number(fields.people)});
      appState.evaluation=null;appState.accountOffset=0;appState.resolution=null;
      await refreshState();closeModal();await renderRoute();toast('Nowy scenariusz jest gotowy. Blockchain zresetowano.');
    }
  }catch(e){toast(e.message,true);if(type==='benchmark'&&$('#benchmark-results'))$('#benchmark-results').innerHTML=`<div class="note warning">${esc(e.message)}</div>`;}finally{if(button)button.disabled=false;}
});
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))closeModal();});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeModal();
  const modal=$('.modal');
  if(e.key==='Tab'&&modal){const focusable=[...modal.querySelectorAll('button,a,input,select,summary')].filter(n=>!n.disabled);const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
window.addEventListener('hashchange',()=>{closeModal();renderRoute();});
try {await refreshState();await renderRoute();}catch(e){$('#app').innerHTML=`<div class="content"><h1>Laboratorium jest niedostępne</h1><p class="mt">${esc(e.message)}</p><p class="mt">Uruchom <span class="mono">npm start</span> w katalogu projektu i odśwież stronę.</p></div>`;}
