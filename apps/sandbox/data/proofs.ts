// Czwarta część scenariusza: „dowody i ich podróbki" oraz reguły niezależności źródeł.
//   i)   podpisana wiadomość potwierdzająca dysponowanie adresem (dowód kryptograficzny),
//   ii)  sfałszowany „dowód" — cudzy podpis doklejony do własnego adresu,
//   iii) ta sama oferta wklejona do trzech serwisów (kopie liczą się jako jedno potwierdzenie),
//   iv)  ten sam nick u dwóch różnych osób w dwóch serwisach (bez łączenia).
// Wszystkie osoby, konta i adresy są zmyślone. Adresy Norberta Szpaka pochodzą z klucza wylosowanego
// przez scripts/generate-signed-proofs.ts — klucz istniał tylko w pamięci skryptu i nie został nigdzie
// zapisany; tutaj są wyłącznie adres, wiadomość i podpis. Pozostałe adresy: scripts/generate-addresses.ts.
// Plik nie zmienia niczego w scenariuszach a–h, części rynkowej ani w „powiązanych tożsamościach".

import type { Account, LabeledAddress, LedgerRow, Page, Thread } from './scenario.ts';

export const PROOF_ADDR = {
  // i) Adresy, dla których istnieją poprawne podpisy.
  szpakBtc: 'bc1qyyrky9pu5rvpl6chp2grf3ds07efu9dmwzvfce',
  szpakEth: '0x812B5125157bd8F61baa152C9295a3Ba776838c7',
  // ii) Adres fałszerza — podpis Norberta do niego nie pasuje.
  baronBtc: 'bc1q78n2a82uz9tv8ntadqsgkctc66y59y6jkjtpac',
  // iii) Jedna oferta w trzech serwisach.
  jaskulaTron: 'TTfeafNdtjeCTKcVo6SkGEaXwx3mUTeKtx',
  // iv) Ten sam nick, dwie różne osoby.
  wilczekBtc: '1HMMp2ZDqNX7tKDPzFkUaUMQ6vf3ve4d62',
  wilczynskaTron: 'TBnxxbu53MBoD2kFqEE42RtYCjsbRMYjXu',
} as const;

const P = PROOF_ADDR;
const code = (address: string) => `<code>${address}</code>`;

/** Podpisane wiadomości scenariusza i) — do testów i dokumentacji. Poprawność sprawdza `verifySignedMessage`. */
export const SIGNED_PROOFS = {
  szpakBtc: {
    address: P.szpakBtc,
    message: `Ja, szpak_nody (GitPub), potwierdzam, że dysponuję adresem ${P.szpakBtc}. Data: 2026-05-20.`,
    signature: 'KKaY2sG2S0cmaFHyeYBClWrlIq8iGdaJew4taWtGu613Pmon70X6OK46pGTsPD1ulVyzWpO6TVfe2jY+KwBlTw4=',
  },
  szpakEth: {
    address: P.szpakEth,
    message: `Konto szpak_nody w serwisie GitPub należy do właściciela adresu ${P.szpakEth}. 2026-05-20`,
    signature:
      '0xf9a9addf7aea179aafe5d6d5e0cbd88213dadb5b98da10c18ec09887ccaaadc637e5095f2664933a4800bb4f5bc1c63ca9e7e0a0b98b8d3167723ef2c034b6b11b',
  },
} as const;

/** ii) „Dowód" fałszerza: wiadomość przerobiona na własny nick i adres, podpis skopiowany od Norberta Szpaka. */
export const FORGED_PROOF = {
  address: P.baronBtc,
  message: `Ja, krypto_baron (Społeczność), potwierdzam, że dysponuję adresem ${P.baronBtc}. Data: 2026-05-20.`,
  signature: SIGNED_PROOFS.szpakBtc.signature,
} as const;

const signedBlock = (proof: { address: string; message: string; signature: string }) => `<pre>-----BEGIN BITCOIN SIGNED MESSAGE-----
${proof.message}
-----BEGIN SIGNATURE-----
${proof.address}
${proof.signature}
-----END BITCOIN SIGNED MESSAGE-----</pre>`;

/** iii) Akapit oferty — identyczny we wszystkich trzech serwisach. */
const jaskulaOffer = `Sprzedaję USDT za gotówkę albo BLIK, Rzeszów i okolice, kwoty od 500 do 20 000 zł, kurs dnia bez prowizji, spotkanie w galerii handlowej lub wysyłka po zaksięgowaniu wpłaty. Kto kupuje ode mnie regularnie i woli odwrotnie, czyli oddać USDT za złotówki, przelewa tokeny na mój adres w sieci TRON ${P.jaskulaTron} i dostaje przelew na konto w ciągu kwadransa, także wieczorem i w weekendy, potwierdzenie wysyłam SMS-em, a przy większych kwotach umawiam się osobiście i wypłacam gotówkę do ręki. Nick fjaskula_usdt, pytania na priv.`;

export const proofAccounts: Account[] = [
  // i) Ważny dowód.
  { service: 'gitpub', handle: 'szpak_nody', name: 'Norbert Szpak', email: 'norbert@szpak-nody.example', location: 'Gliwice', createdAt: '2020-09-07T09:00:00Z' },
  // ii) Podróbka.
  { service: 'spolecznosc', handle: 'krypto_baron', name: 'Borys Kania', location: 'Sosnowiec', createdAt: '2025-12-01T09:00:00Z' },
  // iii) To samo konto w trzech serwisach.
  { service: 'targ', handle: 'fjaskula_usdt', name: 'Filip Jaskuła', phone: '500 000 861', location: 'Rzeszów', createdAt: '2024-04-04T09:00:00Z' },
  { service: 'forum', handle: 'fjaskula_usdt' },
  { service: 'komunikator', handle: 'fjaskula_usdt' },
  // iv) Ten sam nick, różne osoby: inne nazwisko, e-mail, miejscowość, sieć i adres.
  { service: 'targ', handle: 'wilczek_x9', name: 'Adam Wilczek', email: 'adam@wilczek-rowery.example', phone: '500 000 871', location: 'Gdynia', createdAt: '2022-03-18T09:00:00Z' },
  { service: 'forum', handle: 'wilczek_x9', name: 'Beata Wilczyńska', email: 'beata.w@przemysl-net.example', location: 'Przemyśl', createdAt: '2019-10-02T09:00:00Z' },
];

export const proofPages: Page[] = [
  {
    service: 'gitpub',
    path: '/szpak_nody',
    kind: 'profile',
    title: 'szpak_nody (Norbert Szpak)',
    author: 'szpak_nody',
    publishedAt: '2026-05-20T12:00:00Z',
    html: `
<p class="bio">Utrzymuję węzły sieci Lightning i piszę narzędzia do ich monitorowania. Gliwice.</p>
<h2>README</h2>
<p>Skrypty do kopii zapasowych kanałów, eksporter metryk węzła, poradnik konfiguracji. Zlecenia rozliczam w BTC i ETH.</p>
<h2>Wesprzyj mnie</h2>
<p>BTC: ${code(P.szpakBtc)}</p>
<p>ETH: ${code(P.szpakEth)}</p>
<h2>Dowód, że to moje adresy</h2>
<p>Żeby nikt nie podmienił adresów na tej stronie, podpisałem je kluczami portfela. Podpis BTC sprawdzisz w dowolnym portfelu („Zweryfikuj wiadomość"):</p>
${signedBlock(SIGNED_PROOFS.szpakBtc)}
<p>Podpis ETH w formacie eksploratora bloków:</p>
<p><code>{"address":"${SIGNED_PROOFS.szpakEth.address}","msg":"${SIGNED_PROOFS.szpakEth.message}","sig":"${SIGNED_PROOFS.szpakEth.signature}","version":"2"}</code></p>`,
  },
  {
    service: 'spolecznosc',
    path: '/u/krypto_baron',
    kind: 'profile',
    title: 'Borys Kania (@krypto_baron)',
    author: 'krypto_baron',
    publishedAt: '2026-06-02T10:00:00Z',
    html: `
<p class="bio">Inwestor i doradca. Pomnażam oszczędności — zweryfikowany portfel, pełna przejrzystość.</p>
<p>Wpłaty do „funduszu" przyjmuję na adres BTC: ${code(P.baronBtc)}</p>
<p>Portfel jest zweryfikowany podpisem — sprawdź sam:</p>
${signedBlock(FORGED_PROOF)}`,
  },
  {
    service: 'targ',
    path: '/oferta/3101',
    kind: 'offer',
    title: 'USDT za gotówkę lub BLIK — Rzeszów',
    author: 'fjaskula_usdt',
    publishedAt: '2026-04-06T09:00:00Z',
    html: `
<p><strong>Cena:</strong> kurs dnia · <strong>Lokalizacja:</strong> Rzeszów</p>
<p>${jaskulaOffer}</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;861, nick: fjaskula_usdt</p>`,
  },
  {
    service: 'targ',
    path: '/oferta/3102',
    kind: 'offer',
    title: 'Rower gravel, rama M — przyjmę też BTC',
    author: 'wilczek_x9',
    publishedAt: '2026-03-22T15:00:00Z',
    html: `
<p><strong>Cena:</strong> 5&nbsp;200 zł · <strong>Lokalizacja:</strong> Gdynia</p>
<p>Gravel po jednym sezonie, osprzęt 1×11, hamulce hydrauliczne. Prowadzę serwis rowerowy, więc rower jest po pełnym przeglądzie.</p>
<p>Zadatek w bitcoinie na adres: ${code(P.wilczekBtc)}</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;871, nick: wilczek_x9, e-mail: <a href="mailto:adam@wilczek-rowery.example">adam@wilczek-rowery.example</a></p>`,
  },
];

export const proofThreads: Thread[] = [
  // iii) Kopia oferty na forum.
  {
    service: 'forum',
    path: '/watek/31',
    title: 'Giełda: kupię / sprzedam (Podkarpacie)',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      { author: 'fjaskula_usdt', publishedAt: '2026-04-06T09:20:00Z', html: `<p>${jaskulaOffer}</p>` },
      { author: 'taryfa_nocna', publishedAt: '2026-04-06T11:05:00Z', html: '<p>To samo ogłoszenie widziałem na Targu i na kanale w Gołębiu — jedno wystarczy.</p>' },
    ],
  },
  // iii) Kopia oferty w komunikatorze.
  {
    service: 'komunikator',
    path: '/kanal/p2p-podkarpacie',
    title: 'P2P Podkarpacie — oferty',
    itemKind: 'message',
    itemSegment: 'wiadomosc',
    items: [{ author: 'fjaskula_usdt', publishedAt: '2026-04-06T09:35:00Z', html: `<p>${jaskulaOffer}</p>` }],
  },
  // iv) Druga osoba o tym samym nicku — na forum.
  {
    service: 'forum',
    path: '/watek/32',
    title: 'Korepetycje z matematyki online — jak rozliczacie uczniów z zagranicy?',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      {
        author: 'wilczek_x9',
        publishedAt: '2026-02-11T18:40:00Z',
        html: `<p>Uczę matematyki online, część uczniów mieszka w Irlandii i Norwegii. Od roku przyjmuję od nich USDT w sieci TRON na adres ${code(P.wilczynskaTron)} — bez prowizji banku. Beata, Przemyśl. Kontakt: <a href="mailto:beata.w@przemysl-net.example">beata.w@przemysl-net.example</a></p>`,
      },
    ],
  },
];

export const proofLabeledAddresses: LabeledAddress[] = [
  { address: P.szpakBtc, network: 'bitcoin', addressClass: 'private' },
  { address: P.szpakEth, network: 'ethereum', addressClass: 'private' },
  { address: P.baronBtc, network: 'bitcoin', addressClass: 'private' },
  { address: P.jaskulaTron, network: 'tron', addressClass: 'private' },
  { address: P.wilczekBtc, network: 'bitcoin', addressClass: 'private' },
  { address: P.wilczynskaTron, network: 'tron', addressClass: 'private' },
];

/** Adresy z pozostałych części scenariusza potrzebne w przelewach. */
export interface ProofCounterparties {
  exchangeBtc: string;
  exchangeEth: string;
  exchangeTron: string;
  p2pTron: string;
  anonBtc: string;
  anonEth: string;
  anonTron: string;
}

const row = (time: string, from: string, to: string, asset: string, amount: number): LedgerRow => ({ time, from, to, asset, amount });

export function proofLedger(C: ProofCounterparties): LedgerRow[] {
  return [
    // i) Norbert Szpak: wpływy od klientów, wypłaty na giełdę w 2025 i 2026 r.
    row('2025-04-09T10:00:00Z', C.anonBtc, P.szpakBtc, 'BTC', 0.45),
    row('2025-06-17T13:30:00Z', P.szpakBtc, C.exchangeBtc, 'BTC', 0.3),
    row('2026-01-14T09:10:00Z', C.anonBtc, P.szpakBtc, 'BTC', 0.2),
    row('2026-03-03T16:45:00Z', P.szpakBtc, C.exchangeBtc, 'BTC', 0.25),
    row('2025-08-21T11:00:00Z', C.anonEth, P.szpakEth, 'ETH', 1.1),
    row('2025-10-05T08:15:00Z', P.szpakEth, C.exchangeEth, 'ETH', 0.9),
    // ii) Fałszerz: same wpływy od „inwestorów".
    row('2026-06-05T12:00:00Z', C.anonBtc, P.baronBtc, 'BTC', 0.05),
    row('2026-06-09T18:20:00Z', C.anonBtc, P.baronBtc, 'BTC', 0.08),
    // iii) Filip Jaskuła: skup USDT i wypłaty przez kantor P2P.
    row('2026-04-08T10:00:00Z', C.anonTron, P.jaskulaTron, 'USDT', 3200),
    row('2026-04-15T12:00:00Z', P.jaskulaTron, C.p2pTron, 'USDT', 3000),
    // iv) Dwie różne osoby — w eksploratorze nic ich nie łączy.
    row('2026-03-25T10:00:00Z', C.anonBtc, P.wilczekBtc, 'BTC', 0.02),
    row('2026-02-20T10:00:00Z', C.anonTron, P.wilczynskaTron, 'USDT', 400),
    row('2026-05-04T10:00:00Z', P.wilczynskaTron, C.exchangeTron, 'USDT', 350),
  ];
}
