// Scenariusz demonstracyjny: całe dane fikcyjnego „internetu" i fikcyjnego
// eksploratora bloków. Serwer (src/app.ts) wyłącznie je renderuje.
//
// Wszystkie osoby, konta, serwisy i firmy są zmyślone. Adresy wygenerowano
// skryptem scripts/generate-addresses.ts z losowych danych — mają poprawne sumy
// kontrolne, ale nie należą do nikogo.

import { MARKET_ADDR, marketAccounts, marketLabeledAddresses, marketLedger, marketPages, marketThreads } from './market.ts';
import { RELATED_ADDR, relatedAccounts, relatedLabeledAddresses, relatedLedger, relatedPages } from './related.ts';
import { PROOF_ADDR, proofAccounts, proofLabeledAddresses, proofLedger, proofPages, proofThreads } from './proofs.ts';

export type Service = 'gitpub' | 'www' | 'targ' | 'forum' | 'spolecznosc' | 'komunikator';

/** Rodzaj dokumentu; łącznik wyznacza z niego kategorię źródła. */
export type DocKind = 'profile' | 'page' | 'offer' | 'post' | 'mail' | 'comment' | 'message';

/** Publiczne dane konta w jednym serwisie — po nich działa wyszukiwarka. */
export interface Account {
  service: Service;
  handle: string;
  /** Imię i nazwisko, jeśli konto je ujawnia. */
  name?: string;
  /** E-mail, jeśli konto go ujawnia. */
  email?: string;
  /** Telefon kontaktowy, jeśli konto go ujawnia. */
  phone?: string;
  /** Miejscowość podana na koncie. */
  location?: string;
  /** Data założenia konta (ISO 8601). */
  createdAt?: string;
}

export interface Entry {
  author: string;
  publishedAt: string;
  html: string;
}

/** Samodzielny dokument: profil, strona WWW, ogłoszenie. */
export interface Page extends Entry {
  service: Service;
  path: string;
  kind: DocKind;
  title: string;
}

/** Dokument złożony: wątek forum, wpis z komentarzami, kanał komunikatora. */
export interface Thread {
  service: Service;
  path: string;
  title: string;
  /** Wpis otwierający, dostępny pod adresem samego wątku (np. wpis społecznościowy). */
  opening?: Entry & { kind: DocKind };
  itemKind: DocKind;
  /** Człon adresu pojedynczego elementu: `<path>/<itemSegment>/<numer>`. */
  itemSegment: string;
  items: Entry[];
}

/** Archiwalna kopia strony `service` + `path`. */
export interface Snapshot {
  service: Service;
  path: string;
  kind: DocKind;
  archivedAt: string;
  title: string;
  author: string;
  html: string;
  /** Kopia wykonana po podmianie adresu — niewidoczna w fazie „before". */
  afterChange: boolean;
}

export type SandboxNetwork = 'bitcoin' | 'ethereum' | 'tron';

export interface LabeledAddress {
  address: string;
  network: SandboxNetwork;
  label?: string;
  addressClass?: 'private' | 'exchange' | 'smart_contract' | 'institutional';
  isContract?: boolean;
  /** Rodzaj usługi wyjścia do walut tradycyjnych — wskazówka dla modułu danych blockchain. */
  kind?: 'p2p_service' | 'payment_gateway' | 'crypto_card' | 'stablecoin_swap';
}

export interface LedgerRow {
  time: string;
  from: string;
  to: string;
  asset: string;
  amount: number;
}

// ---------- Adresy ----------

export const ADDR = {
  // Osoby
  kacperBtc: 'bc1qxhvk23usdd66dddy8lvafvv47v5aa9jz6kl0ze',
  kacperEth: '0x52142a58315B1A1e787cA2ab38292c50896ee86a',
  namesakeBtc: '16YxN8WjR1ENoMyQsaUd3J8qoFeQr3hCfy',
  dominikOldBtc: '12BoumHbsRx7PphdYwjKX48Kxn98ZQvxWo',
  dominikNewBtc: 'bc1qarttus08r4jpzhgz3n3v9w3mz2nej8cxd4t4hp',
  martaEth: '0x3fb2904B57A5759DbE5B4f6CbA46C4E529699D84',
  martaLabsTron: 'TETb8rmovG86tzpPxKmek39rhVar2oTsv6',
  hubertTron: 'TRASZbW4ka247pJD7h4yVL3ApZmGLq632v',
  giveawayTron: 'TGVGqNUk2kpU5kwNqaK3pdsh5ZDecVtUJj',
  // Serwisy i kontrakty
  exchangeBtc: '34PsxzNKxE91xpnCPRBDxpRyD4jspB6z7A',
  exchangeEth: '0xeDCABEaF7845fb6f8d42D634acF7faea4449b5bf',
  exchangeTron: 'TGgBMyLJ9ZtzGKsSPknrbWGftNGaJiuDSX',
  p2pBtc: '34Skb8am1sRZEHg6YHzYQfEL7PdPtoHFGq',
  p2pTron: 'THJHf8xKC6LTASiMQiv6WSN8etcU76q8T7',
  gatewayEth: '0x0c579b69009D47426095a72eedd797f7D7a3Ff73',
  cardEth: '0x59D6894D1C4EEEa75956105f45E172494A550938',
  stableEth: '0x1e6702436E677A0a8c2f8fA2366983c9e9c76042',
  swapEth: '0xb586728b5F34C17d5dA473e64B858cF34d0A82AA',
  stableTron: 'TEp3qCAQmDbEg3URonUJa95MRUUpnkKoGe',
  // Anonimowi kontrahenci
  privBtc1: 'bc1qk079hnkhlqsrlm4yhsjfg35d8pmrxgc6clfwq7',
  privBtc2: 'bc1qxe63vrqn8nu3m8sa7euu9z4nmxu5d5ueyfl6gw',
  privBtc3: '16Be99MuHjFS9rPpdBhZZtaS6v4pq2tdFJ',
  privBtc4: '1AzwLEJVR2aVMWJ1vo39GVsYk3mB2Nm1M8',
  privEth1: '0xD28c39266b14f12Bf45264a77669549ED7Fb5DCf',
  privEth2: '0xcDdF399e1893168De5D8D472A70F19AD4c2F5e54',
  privEth3: '0x2c2DBDBd115B1eE15091F1CF4b6e7bCd30658622',
  privTron1: 'TKfzd83YjHZzFs84iLBrUJzkj9xRBazaXs',
  privTron2: 'TRpAwa1jCXJyvRRfufVnoohLpVFnYRkAUy',
  privTron3: 'TD8o1DdSgqbbPvXtT9tsmY9QKViiqEms7H',
} as const;

/** Adresy z etykietą lub klasą. Pozostałe adresy z księgi eksplorator pokazuje bez etykiety. */
const baseLabeledAddresses: LabeledAddress[] = [
  { address: ADDR.kacperBtc, network: 'bitcoin', addressClass: 'private' },
  { address: ADDR.kacperEth, network: 'ethereum', addressClass: 'private' },
  { address: ADDR.namesakeBtc, network: 'bitcoin', addressClass: 'private' },
  { address: ADDR.dominikOldBtc, network: 'bitcoin', addressClass: 'private' },
  { address: ADDR.dominikNewBtc, network: 'bitcoin', addressClass: 'private' },
  { address: ADDR.martaEth, network: 'ethereum', addressClass: 'private' },
  { address: ADDR.martaLabsTron, network: 'tron', addressClass: 'private' },
  { address: ADDR.hubertTron, network: 'tron', addressClass: 'private' },
  // Adres z giveawayu celowo bez etykiety: o jego naturze świadczy liczba publikujących.
  { address: ADDR.giveawayTron, network: 'tron' },
  { address: ADDR.exchangeBtc, network: 'bitcoin', label: 'Giełda Bursztyn: Hot Wallet', addressClass: 'exchange' },
  { address: ADDR.exchangeEth, network: 'ethereum', label: 'Giełda Bursztyn: Hot Wallet', addressClass: 'exchange' },
  { address: ADDR.exchangeTron, network: 'tron', label: 'Giełda Bursztyn: Hot Wallet', addressClass: 'exchange' },
  { address: ADDR.p2pBtc, network: 'bitcoin', label: 'KantorKrypto P2P', addressClass: 'institutional', kind: 'p2p_service' },
  { address: ADDR.p2pTron, network: 'tron', label: 'KantorKrypto P2P', addressClass: 'institutional', kind: 'p2p_service' },
  {
    address: ADDR.gatewayEth,
    network: 'ethereum',
    label: 'PlatnosciPay Gateway',
    addressClass: 'institutional',
    kind: 'payment_gateway',
  },
  {
    address: ADDR.cardEth,
    network: 'ethereum',
    label: 'KartaCoin: doładowanie karty',
    addressClass: 'institutional',
    kind: 'crypto_card',
  },
  {
    address: ADDR.stableEth,
    network: 'ethereum',
    label: 'Stablecoin USDT: kontrakt tokena',
    addressClass: 'smart_contract',
    isContract: true,
  },
  {
    address: ADDR.swapEth,
    network: 'ethereum',
    label: 'WymianaSwap: Router (zamiana na stablecoiny)',
    addressClass: 'smart_contract',
    isContract: true,
    kind: 'stablecoin_swap',
  },
  {
    address: ADDR.stableTron,
    network: 'tron',
    label: 'Stablecoin USDT: kontrakt tokena (TRC-20)',
    addressClass: 'smart_contract',
    isContract: true,
  },
];

// ---------- Księga transakcji fikcyjnego eksploratora ----------

const row = (time: string, from: string, to: string, asset: string, amount: number): LedgerRow => ({
  time,
  from,
  to,
  asset,
  amount,
});

const baseLedger: LedgerRow[] = [
  // Kacper — Bitcoin: wpływy od klientów, wypłaty na giełdę i do kantoru P2P w trzech latach podatkowych.
  row('2024-02-11T09:14:00Z', ADDR.privBtc1, ADDR.kacperBtc, 'BTC', 0.35),
  row('2024-03-19T17:40:00Z', ADDR.privBtc2, ADDR.kacperBtc, 'BTC', 0.21),
  row('2024-06-03T08:05:00Z', ADDR.kacperBtc, ADDR.exchangeBtc, 'BTC', 0.3),
  row('2024-11-22T20:31:00Z', ADDR.privBtc1, ADDR.kacperBtc, 'BTC', 0.18),
  row('2025-01-15T12:02:00Z', ADDR.kacperBtc, ADDR.p2pBtc, 'BTC', 0.12),
  row('2025-03-14T10:22:00Z', ADDR.privBtc3, ADDR.kacperBtc, 'BTC', 0.42),
  row('2025-04-02T07:48:00Z', ADDR.kacperBtc, ADDR.exchangeBtc, 'BTC', 0.4),
  row('2025-09-27T15:10:00Z', ADDR.privBtc2, ADDR.kacperBtc, 'BTC', 0.25),
  row('2025-12-09T11:27:00Z', ADDR.kacperBtc, ADDR.exchangeBtc, 'BTC', 0.2),
  row('2026-02-18T18:55:00Z', ADDR.privBtc4, ADDR.kacperBtc, 'BTC', 0.15),
  row('2026-03-05T09:33:00Z', ADDR.kacperBtc, ADDR.p2pBtc, 'BTC', 0.1),
  row('2026-05-21T13:19:00Z', ADDR.kacperBtc, ADDR.exchangeBtc, 'BTC', 0.08),

  // Kacper — Ethereum: zamiana na stablecoiny, bramka płatnicza, karta, giełda.
  row('2024-08-04T10:00:00Z', ADDR.privEth1, ADDR.kacperEth, 'ETH', 2.5),
  row('2024-08-20T14:12:00Z', ADDR.kacperEth, ADDR.swapEth, 'ETH', 1.2),
  row('2024-08-20T14:12:30Z', ADDR.swapEth, ADDR.kacperEth, 'USDT', 3100),
  row('2024-09-02T08:41:00Z', ADDR.kacperEth, ADDR.exchangeEth, 'USDT', 3000),
  row('2025-02-10T19:05:00Z', ADDR.privEth2, ADDR.kacperEth, 'ETH', 1.8),
  row('2025-02-12T09:30:00Z', ADDR.kacperEth, ADDR.gatewayEth, 'ETH', 0.4),
  row('2025-06-30T16:44:00Z', ADDR.kacperEth, ADDR.swapEth, 'ETH', 1.0),
  row('2025-06-30T16:44:30Z', ADDR.swapEth, ADDR.kacperEth, 'USDT', 2450),
  row('2025-07-03T07:15:00Z', ADDR.kacperEth, ADDR.cardEth, 'USDT', 800),
  row('2025-07-15T12:50:00Z', ADDR.kacperEth, ADDR.exchangeEth, 'USDT', 1500),
  row('2026-01-22T21:08:00Z', ADDR.privEth1, ADDR.kacperEth, 'ETH', 0.9),
  row('2026-04-11T10:17:00Z', ADDR.kacperEth, ADDR.exchangeEth, 'ETH', 0.6),
  row('2026-04-12T08:02:00Z', ADDR.kacperEth, ADDR.cardEth, 'USDT', 150),

  // Imiennik Kacpra — drobna zbiórka, bez wypłat.
  row('2025-05-06T16:20:00Z', ADDR.privBtc3, ADDR.namesakeBtc, 'BTC', 0.012),
  row('2025-07-19T11:45:00Z', ADDR.privBtc4, ADDR.namesakeBtc, 'BTC', 0.02),

  // Dominik — stary adres (do 2025), potem przeniesienie środków na nowy.
  row('2024-01-28T13:00:00Z', ADDR.privBtc2, ADDR.dominikOldBtc, 'BTC', 0.5),
  row('2024-07-09T09:12:00Z', ADDR.dominikOldBtc, ADDR.exchangeBtc, 'BTC', 0.4),
  row('2025-03-21T18:30:00Z', ADDR.privBtc1, ADDR.dominikOldBtc, 'BTC', 0.16),
  row('2025-08-29T22:10:00Z', ADDR.dominikOldBtc, ADDR.dominikNewBtc, 'BTC', 0.25),
  row('2025-10-14T10:05:00Z', ADDR.privBtc4, ADDR.dominikNewBtc, 'BTC', 0.3),
  row('2026-01-12T08:48:00Z', ADDR.dominikNewBtc, ADDR.exchangeBtc, 'BTC', 0.22),
  row('2026-04-27T15:36:00Z', ADDR.dominikNewBtc, ADDR.p2pBtc, 'BTC', 0.18),

  // Marta — Ethereum (profil główny) i Tron (konto projektowe).
  row('2025-04-08T12:11:00Z', ADDR.privEth3, ADDR.martaEth, 'ETH', 0.3),
  row('2025-09-17T09:59:00Z', ADDR.privEth2, ADDR.martaEth, 'ETH', 0.2),
  row('2025-11-03T14:25:00Z', ADDR.martaEth, ADDR.gatewayEth, 'ETH', 0.25),
  row('2025-05-15T10:40:00Z', ADDR.privTron1, ADDR.martaLabsTron, 'USDT', 900),
  row('2026-02-09T17:22:00Z', ADDR.privTron2, ADDR.martaLabsTron, 'USDT', 1200),
  row('2026-03-01T08:30:00Z', ADDR.martaLabsTron, ADDR.exchangeTron, 'USDT', 1500),
  row('2026-06-18T19:04:00Z', ADDR.martaLabsTron, ADDR.p2pTron, 'USDT', 300),

  // Hubert — rozliczenia serwisu w USDT na Tronie, wypłaty przez kantor P2P i giełdę.
  row('2024-05-10T11:00:00Z', ADDR.privTron1, ADDR.hubertTron, 'TRX', 200),
  row('2024-05-14T15:20:00Z', ADDR.privTron1, ADDR.hubertTron, 'USDT', 110),
  row('2024-06-22T12:45:00Z', ADDR.privTron2, ADDR.hubertTron, 'USDT', 450),
  row('2024-09-30T18:10:00Z', ADDR.privTron3, ADDR.hubertTron, 'USDT', 620),
  row('2024-11-08T09:27:00Z', ADDR.privTron2, ADDR.hubertTron, 'USDT', 980),
  row('2024-12-19T10:03:00Z', ADDR.hubertTron, ADDR.p2pTron, 'USDT', 2000),
  row('2025-02-27T16:38:00Z', ADDR.privTron1, ADDR.hubertTron, 'USDT', 760),
  row('2025-05-05T13:14:00Z', ADDR.privTron3, ADDR.hubertTron, 'USDT', 1340),
  row('2025-08-11T08:52:00Z', ADDR.hubertTron, ADDR.p2pTron, 'USDT', 2500),
  row('2025-11-23T20:06:00Z', ADDR.privTron2, ADDR.hubertTron, 'USDT', 890),
  row('2026-01-30T14:41:00Z', ADDR.privTron1, ADDR.hubertTron, 'USDT', 1150),
  row('2026-02-16T09:18:00Z', ADDR.hubertTron, ADDR.exchangeTron, 'USDT', 1800),

  // Adres z giveawayu — wpłaty od wielu osób, całość wyprowadzona na jeden adres.
  row('2026-03-02T10:15:00Z', ADDR.privTron1, ADDR.giveawayTron, 'USDT', 200),
  row('2026-03-02T11:48:00Z', ADDR.privTron2, ADDR.giveawayTron, 'USDT', 500),
  row('2026-03-02T13:05:00Z', ADDR.hubertTron, ADDR.giveawayTron, 'USDT', 50),
  row('2026-03-03T08:22:00Z', ADDR.privTron1, ADDR.giveawayTron, 'USDT', 350),
  row('2026-03-04T23:59:00Z', ADDR.giveawayTron, ADDR.privTron3, 'USDT', 1100),
];

// ---------- Konta ----------

const baseAccounts: Account[] = [
  // Główna osoba: spójne dane na obu profilach (ta sama miejscowość, telefon z ogłoszenia).
  { service: 'gitpub', handle: 'kwrzosek_dev', name: 'Kacper Wrzosek', email: 'kacper.wrzosek@poczta.example', location: 'Bydgoszcz', createdAt: '2019-06-03T09:00:00Z' },
  { service: 'targ', handle: 'kwrzosek_dev', phone: '500 000 201', location: 'Bydgoszcz', createdAt: '2021-02-15T09:00:00Z' },
  { service: 'forum', handle: 'bkruk_trader', name: 'Bartłomiej Kruk', email: 'b.kruk@fikcyjna.example' },
  // Imiennik: to samo imię i nazwisko, ale inna miejscowość i inny e-mail.
  { service: 'spolecznosc', handle: 'wrzosek_ryby', name: 'Kacper Wrzosek', email: 'wrzosek.ryby@jeziora.example', location: 'Olsztyn', createdAt: '2018-04-22T09:00:00Z' },
  { service: 'spolecznosc', handle: 'oli_stepniak', name: 'Oliwia Stępniak' },
  { service: 'www', handle: 'dsroka', name: 'Dominik Sroka', email: 'dominik@sroka-foto.example' },
  { service: 'spolecznosc', handle: 'marta.zielonka', name: 'Marta Zielonka', email: 'm.zielonka@skrzynka.example' },
  // Konta programistyczne Marty nie ujawniają nazwiska — prowadzi do nich tylko łańcuch tożsamości.
  { service: 'gitpub', handle: 'zielonka_codes' },
  { service: 'gitpub', handle: 'zielonka-labs' },
  { service: 'komunikator', handle: 'hubi_serwis' },
  { service: 'forum', handle: 'hubi_serwis', name: 'Hubert Jagła', email: 'hubert@serwis-jagla.example' },
  { service: 'spolecznosc', handle: 'zosia_mielcarz', name: 'Zofia Mielcarz', email: 'zofia.mielcarz@listy.example' },
  { service: 'forum', handle: 'zosia_mielcarz' },
  { service: 'targ', handle: 'zosia_mielcarz' },
  // Tło
  { service: 'gitpub', handle: 'rafal_ciesla', name: 'Rafał Cieśla' },
  { service: 'spolecznosc', handle: 'mega_rozdanie_krypto' },
  { service: 'targ', handle: 'kantor_na_rogu' },
];

// ---------- Strony ----------

const code = (address: string) => `<code>${address}</code>`;

const dsrokaPage = (address: string, note: string) => `
<p>Fotografia ślubna i reportażowa — Trójmiasto i okolice. Terminy na sezon rezerwuję z rocznym wyprzedzeniem.</p>
<h2>Oferta</h2>
<ul>
  <li>Reportaż ślubny (cały dzień) — od 4&nbsp;800 zł</li>
  <li>Sesja narzeczeńska — 900 zł</li>
  <li>Odbitki i fotoksiążki — wycena indywidualna</li>
</ul>
<h2>Zadatek i płatności</h2>
<p>Zadatek można wpłacić przelewem albo w bitcoinie. ${note}</p>
<p>Adres BTC do wpłaty zadatku: ${code(address)}</p>
<h2>Kontakt</h2>
<p>Dominik Sroka, e-mail: <a href="mailto:dominik@sroka-foto.example">dominik@sroka-foto.example</a>, tel. 500&nbsp;000&nbsp;412</p>`;

const basePages: Page[] = [
  // a) Własny profil z adresami — pierwsze z dwóch niezależnych źródeł.
  {
    service: 'gitpub',
    path: '/kwrzosek_dev',
    kind: 'profile',
    title: 'kwrzosek_dev (Kacper Wrzosek)',
    author: 'kwrzosek_dev',
    publishedAt: '2024-01-20T10:00:00Z',
    html: `
<p class="bio">Programista systemów wbudowanych z Bydgoszczy. Po godzinach składam i stroję koparki, piszę firmware do sterowników wentylatorów.</p>
<h2>README</h2>
<p>Cześć! Utrzymuję kilka otwartych projektów:</p>
<ul>
  <li><strong>wentyl-ctl</strong> — sterownik wentylatorów dla koparek ASIC</li>
  <li><strong>taryfa-g12</strong> — kalkulator opłacalności kopania przy taryfie nocnej</li>
  <li><strong>fw-stm32-pid</strong> — biblioteka regulatora PID</li>
</ul>
<p>Zlecenia komercyjne (firmware, strojenie koparek) rozliczam także w kryptowalutach.</p>
<h2>Wesprzyj mnie</h2>
<p>Jeśli moje projekty Ci pomogły, możesz postawić mi kawę:</p>
<p>BTC: ${code(ADDR.kacperBtc)}</p>
<p>ETH / USDT (ERC-20): ${code(ADDR.kacperEth)}</p>`,
  },
  // f) Łańcuch tożsamości — profil B (z nickiem z profilu społecznościowego) i powiązane konto projektowe.
  {
    service: 'gitpub',
    path: '/zielonka_codes',
    kind: 'profile',
    title: 'zielonka_codes',
    author: 'zielonka_codes',
    publishedAt: '2025-02-03T09:00:00Z',
    html: `
<p class="bio">Frontend, dostępność, trochę Rusta. Wrocław.</p>
<h2>README</h2>
<p>Buduję wtyczki do czytników ekranu i szablony dostępnych formularzy. Większe projekty prowadzę pod kontem
<a rel="me" href="/gitpub/zielonka-labs">@zielonka-labs</a>.</p>
<h2>Wesprzyj mnie</h2>
<p>Napiwki za wtyczki (ETH): ${code(ADDR.martaEth)}</p>`,
  },
  {
    service: 'gitpub',
    path: '/zielonka-labs',
    kind: 'profile',
    title: 'zielonka-labs',
    author: 'zielonka-labs',
    publishedAt: '2025-05-02T09:00:00Z',
    html: `
<p class="bio">Konto projektowe: audyty dostępności i szkolenia WCAG.</p>
<h2>README</h2>
<p>Repozytoria szkoleniowe i narzędzia do audytów. Faktury wystawiam przez inkubator, zagranicznych klientów rozliczam w USDT.</p>
<h2>Wesprzyj mnie</h2>
<p>USDT (TRC-20): ${code(ADDR.martaLabsTron)}</p>`,
  },
  {
    service: 'gitpub',
    path: '/rafal_ciesla',
    kind: 'profile',
    title: 'rafal_ciesla (Rafał Cieśla)',
    author: 'rafal_ciesla',
    publishedAt: '2024-09-12T09:00:00Z',
    html: `
<p class="bio">Administrator baz danych. Notatki z migracji i skrypty do kopii zapasowych.</p>
<h2>README</h2>
<p>Nie przyjmuję darowizn — jeśli chcesz pomóc, zgłoś błąd albo popraw dokumentację.</p>`,
  },
  // e) Strona osobista z podmienionym adresem (stare wersje w archiwum).
  {
    service: 'www',
    path: '/dsroka',
    kind: 'page',
    title: 'Dominik Sroka — fotografia',
    author: 'dsroka',
    publishedAt: '2025-08-30T08:00:00Z',
    html: dsrokaPage(ADDR.dominikNewBtc, 'Uwaga: od września 2025 r. obowiązuje nowy adres portfela.'),
  },
  // a) Ogłoszenie z tym samym adresem BTC — drugie niezależne źródło.
  {
    service: 'targ',
    path: '/oferta/1001',
    kind: 'offer',
    title: 'Sprzedam koparkę ASIC 110 TH/s — płatność w BTC mile widziana',
    author: 'kwrzosek_dev',
    publishedAt: '2025-03-10T18:30:00Z',
    html: `
<p><strong>Cena:</strong> 0,04 BTC lub 14&nbsp;500 zł · <strong>Lokalizacja:</strong> Bydgoszcz · <strong>Stan:</strong> używana</p>
<p>Sprzedam koparkę po wymianie wentylatorów i past, pracowała w chłodzonej piwnicy. Możliwy odbiór osobisty i test na miejscu.</p>
<p>Przy płatności kryptowalutą rezerwuję sprzęt po wpłacie zadatku 10% na adres BTC: ${code(ADDR.kacperBtc)}</p>
<p>Przyjmę także USDT — szczegóły telefonicznie.</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;201, nick: kwrzosek_dev</p>`,
  },
  // h) Ogłoszenie bez kryptowalut.
  {
    service: 'targ',
    path: '/oferta/1002',
    kind: 'offer',
    title: 'Rower miejski damski 28", stan bardzo dobry',
    author: 'zosia_mielcarz',
    publishedAt: '2025-06-14T09:10:00Z',
    html: `
<p><strong>Cena:</strong> 650 zł · <strong>Lokalizacja:</strong> Toruń · <strong>Stan:</strong> używany</p>
<p>Rower po przeglądzie, nowe opony i łańcuch. Płatność gotówką przy odbiorze albo BLIK-iem.</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;377, nick: zosia_mielcarz</p>`,
  },
  {
    service: 'targ',
    path: '/oferta/1003',
    kind: 'offer',
    title: 'Kupię / sprzedam USDT — gotówka, Warszawa Śródmieście',
    author: 'kantor_na_rogu',
    publishedAt: '2026-01-08T12:00:00Z',
    html: `
<p><strong>Cena:</strong> kurs dnia −1% · <strong>Lokalizacja:</strong> Warszawa</p>
<p>Wymiana od ręki, bez limitu. Adres do wpłaty podaję wyłącznie po kontakcie telefonicznym.</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;590</p>`,
  },
  // f) Łańcuch tożsamości — profil A: znaleziony po e-mailu, ujawnia nick programistyczny.
  {
    service: 'spolecznosc',
    path: '/u/marta.zielonka',
    kind: 'profile',
    title: 'Marta Zielonka (@marta.zielonka)',
    author: 'marta.zielonka',
    publishedAt: '2024-10-05T10:00:00Z',
    html: `
<p class="bio">Projektuję dostępne interfejsy. Wrocław. Prywatnie: wspinaczka i planszówki.</p>
<p>Kontakt: <a href="mailto:m.zielonka@skrzynka.example">m.zielonka@skrzynka.example</a></p>
<p>Kod publikuję na GitPubie jako <a rel="me" href="/gitpub/zielonka_codes">zielonka_codes</a>.</p>`,
  },
  // c) Imiennik badanej osoby — inny człowiek, inny adres.
  {
    service: 'spolecznosc',
    path: '/u/wrzosek_ryby',
    kind: 'profile',
    title: 'Kacper Wrzosek (@wrzosek_ryby)',
    author: 'wrzosek_ryby',
    publishedAt: '2023-04-18T10:00:00Z',
    html: `
<p class="bio">Wędkarz z Olsztyna. Jeziora Warmii, spinning, relacje z zawodów koła „Okoń".</p>
<p>Zbieram na nowy silnik do łódki — kto chce się dorzucić w krypto: ${code(ADDR.namesakeBtc)}</p>`,
  },
  {
    service: 'spolecznosc',
    path: '/u/oli_stepniak',
    kind: 'profile',
    title: 'Oliwia Stępniak (@oli_stepniak)',
    author: 'oli_stepniak',
    publishedAt: '2025-01-11T10:00:00Z',
    html: `
<p class="bio">Studentka logistyki, Poznań. Uczę się inwestować małymi krokami.</p>`,
  },
  // h) Osoba bez żadnych adresów.
  {
    service: 'spolecznosc',
    path: '/u/zosia_mielcarz',
    kind: 'profile',
    title: 'Zofia Mielcarz (@zosia_mielcarz)',
    author: 'zosia_mielcarz',
    publishedAt: '2022-08-01T10:00:00Z',
    html: `
<p class="bio">Bibliotekarka z Torunia. Rower, ogród, kryminały skandynawskie.</p>
<p>Kontakt: <a href="mailto:zofia.mielcarz@listy.example">zofia.mielcarz@listy.example</a></p>`,
  },
  {
    service: 'spolecznosc',
    path: '/u/mega_rozdanie_krypto',
    kind: 'profile',
    title: 'MEGA Rozdanie Krypto (@mega_rozdanie_krypto)',
    author: 'mega_rozdanie_krypto',
    publishedAt: '2026-02-27T10:00:00Z',
    html: `
<p class="bio">Oficjalne rozdania i konkursy! Codziennie nowe nagrody!</p>`,
  },
];

// ---------- Wątki, wpisy z komentarzami, kanały ----------

const giveawayComment = (author: string, publishedAt: string, text: string): Entry => ({
  author,
  publishedAt,
  html: `<p>${text}</p>`,
});

const baseThreads: Thread[] = [
  // b) Adres giełdy i adres smart kontraktu wklejone na forum.
  {
    service: 'forum',
    path: '/watek/1',
    title: 'Gdzie wypłacacie na złotówki? Giełda Bursztyn czy kantor P2P',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      {
        author: 'nocny_gornik',
        publishedAt: '2025-05-02T19:12:00Z',
        html: `<p>Kopię hobbystycznie od dwóch lat i dalej nie wiem, gdzie najsensowniej wymieniać na złotówki. Co polecacie przy kwotach rzędu kilku tysięcy miesięcznie?</p>`,
      },
      {
        author: 'bkruk_trader',
        publishedAt: '2025-05-02T20:47:00Z',
        html: `
<p>Ja od lat tylko Giełda Bursztyn. Żeby nikt nie wysłał na lewy adres z fałszywej strony — oficjalny adres ich gorącego portfela BTC, na który trafiają depozyty, to ${code(ADDR.exchangeBtc)} (można sprawdzić w eksploratorze, ma etykietę).</p>
<p>A jak ktoś woli stablecoiny, to pilnujcie, żeby to był prawdziwy kontrakt USDT: ${code(ADDR.stableEth)} — podróbek tokenów jest pełno.</p>`,
      },
      {
        author: 'zosia_mielcarz',
        publishedAt: '2025-05-03T08:05:00Z',
        html: `<p>Dziękuję za wątek. Sama nie mam kryptowalut, ale brat pyta o podatki — czy z takiej wymiany składa się potem PIT-38?</p>`,
      },
      {
        author: 'nocny_gornik',
        publishedAt: '2025-05-03T09:30:00Z',
        html: `<p>Tak, odpłatne zbycie waluty wirtualnej wykazuje się w PIT-38. Dzięki wszystkim za odpowiedzi.</p>`,
      },
    ],
  },
  {
    service: 'forum',
    path: '/watek/2',
    title: 'Koparka po trzech latach — czy to się jeszcze opłaca?',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      {
        author: 'taryfa_nocna',
        publishedAt: '2025-10-11T21:00:00Z',
        html: `<p>Przy obecnych cenach prądu wychodzę na zero. Ktoś liczył opłacalność z fotowoltaiką?</p>`,
      },
      {
        author: 'bkruk_trader',
        publishedAt: '2025-10-12T07:40:00Z',
        html: `<p>Z własnym prądem się spina, z sieci już nie. Ja sprzęt sprzedałem i zostałem przy samym handlu.</p>`,
      },
    ],
  },
  // g) Lista mailingowa — adres w stopce e-maila.
  {
    service: 'forum',
    path: '/lista/1',
    title: '[serwisanci-l] Rozliczenia za części — jak się umawiacie z klientami?',
    itemKind: 'mail',
    itemSegment: 'wiadomosc',
    items: [
      {
        author: 'gsm_piotrek',
        publishedAt: '2025-09-01T10:15:00Z',
        html: `<p>Koledzy, coraz więcej klientów pyta o płatność inną niż gotówka i przelew. Jak to u Was wygląda?</p>
<p>-- <br>Piotrek, serwis telefonów, Radom</p>`,
      },
      {
        author: 'hubi_serwis',
        publishedAt: '2025-09-01T11:02:00Z',
        html: `<p>U mnie od zeszłego roku połowa stałych klientów płaci w USDT, szczególnie za droższe wyświetlacze. Szybko i bez prowizji banku.</p>
<p>-- <br>Hubert Jagła<br>Serwis GSM Wola, Warszawa<br>tel. 500&nbsp;000&nbsp;733<br>Płatności USDT (TRC-20): ${ADDR.hubertTron}</p>`,
      },
    ],
  },
  // d) Giveaway — ten sam adres wklejany przez wiele niepowiązanych kont.
  {
    service: 'spolecznosc',
    path: '/wpis/301',
    title: 'MEGA ROZDANIE: podwajamy każdą wpłatę USDT!',
    opening: {
      kind: 'post',
      author: 'mega_rozdanie_krypto',
      publishedAt: '2026-03-01T18:00:00Z',
      html: `<p>Z okazji 100 tysięcy obserwujących PODWAJAMY każdą wpłatę! Wyślij od 50 do 5000 USDT (sieć TRON) na adres rozdania, a w ciągu godziny odeślemy dwa razy tyle.</p>
<p>Adres rozdania: ${code(ADDR.giveawayTron)}</p>
<p>Warunek: wklej adres rozdania w komentarzu i oznacz znajomego. Liczba miejsc ograniczona!</p>`,
    },
    itemKind: 'comment',
    itemSegment: 'komentarz',
    items: [
      giveawayComment('krypto_janusz77', '2026-03-01T18:04:00Z', `Potwierdzam, działa! Wysłałem 300 i wróciło 600. Adres: ${ADDR.giveawayTron}`),
      giveawayComment('moonlady_x', '2026-03-01T18:09:00Z', `Super akcja, biorę udział ${ADDR.giveawayTron} @anka.hodl patrz!`),
      giveawayComment('darmowe_tokeny', '2026-03-01T18:15:00Z', `${ADDR.giveawayTron} — wysłane, czekam na x2`),
      giveawayComment('oli_stepniak', '2026-03-02T10:20:00Z', `Wysłałam 200 USDT na ${ADDR.giveawayTron} zgodnie z regulaminem. Kiedy przyjdzie zwrot?`),
      giveawayComment('szybki_zysk24', '2026-03-02T10:31:00Z', `U mnie doszło po 20 minutach, polecam każdemu: ${ADDR.giveawayTron}`),
      giveawayComment('anka.hodl', '2026-03-02T12:02:00Z', `Dołączam ${ADDR.giveawayTron}`),
      giveawayComment('btc_maniak_pl', '2026-03-03T08:40:00Z', `Minęła doba i nic nie wróciło. Ludzie, nie wysyłajcie na ${ADDR.giveawayTron}, to oszustwo.`),
    ],
  },
  {
    service: 'spolecznosc',
    path: '/wpis/302',
    title: 'Zbiórka na silnik do łódki',
    opening: {
      kind: 'post',
      author: 'wrzosek_ryby',
      publishedAt: '2025-05-04T07:30:00Z',
      html: `<p>Stary silnik odmówił posłuszeństwa na środku Jezioraka. Zbieram na używaną czterosuwową piątkę — każda złotówka się liczy, a jak ktoś woli bitcoina, adres jest na moim profilu: ${code(ADDR.namesakeBtc)}</p>`,
    },
    itemKind: 'comment',
    itemSegment: 'komentarz',
    items: [
      giveawayComment('okon_olsztyn', '2025-05-04T09:12:00Z', 'Dorzuciłem się, do zobaczenia na zawodach!'),
    ],
  },
  {
    service: 'spolecznosc',
    path: '/wpis/303',
    title: 'Sezon rowerowy otwarty',
    opening: {
      kind: 'post',
      author: 'zosia_mielcarz',
      publishedAt: '2025-04-12T16:45:00Z',
      html: `<p>Pierwsze 40 km w tym roku: Toruń — Zamek Bierzgłowski i z powrotem. Stary rower idzie na sprzedaż, szczegóły na Targu.</p>`,
    },
    itemKind: 'comment',
    itemSegment: 'komentarz',
    items: [],
  },
  // g) Publiczny kanał komunikatora — rozliczenia „przelej na ...".
  {
    service: 'komunikator',
    path: '/kanal/serwis-gsm-wola',
    title: 'Serwis GSM Wola — klienci i rozliczenia',
    itemKind: 'message',
    itemSegment: 'wiadomosc',
    items: [
      {
        author: 'hubi_serwis',
        publishedAt: '2024-05-14T14:50:00Z',
        html: `<p>Wymiana gniazda ładowania gotowa, do odbioru od 16:00. Koszt 110 USDT albo 450 zł gotówką. Kto płaci w krypto: przelej na ${ADDR.hubertTron} (USDT, sieć TRON) i podeślij tu potwierdzenie.</p>`,
      },
      {
        author: 'klient_marek',
        publishedAt: '2024-05-14T15:22:00Z',
        html: `<p>Przelane 110 USDT, potwierdzenie wysłałem w wiadomości prywatnej.</p>`,
      },
      {
        author: 'hubi_serwis',
        publishedAt: '2024-05-14T15:31:00Z',
        html: `<p>Doszło, dzięki. Telefon czeka przy ladzie.</p>`,
      },
      {
        author: 'ewa_z_bemowa',
        publishedAt: '2025-05-05T12:40:00Z',
        html: `<p>Dzień dobry, ile za wyświetlacz do zeszłorocznego flagowca? Mogę zapłacić w USDT.</p>`,
      },
      {
        author: 'hubi_serwis',
        publishedAt: '2025-05-05T12:58:00Z',
        html: `<p>Oryginał 1340 USDT z montażem. Rozliczenie jak zawsze: przelej na ${ADDR.hubertTron}, część zamawiam po zaksięgowaniu wpłaty.</p>`,
      },
    ],
  },
  {
    service: 'komunikator',
    path: '/kanal/gielda-czesci-pc',
    title: 'Giełda części PC — Warszawa',
    itemKind: 'message',
    itemSegment: 'wiadomosc',
    items: [
      {
        author: 'ramzes_3200',
        publishedAt: '2026-02-02T19:00:00Z',
        html: `<p>Sprzedam dwie kości pamięci 16 GB, odbiór osobisty przy metrze Młociny, tylko gotówka.</p>`,
      },
      {
        author: 'hubi_serwis',
        publishedAt: '2026-02-02T19:25:00Z',
        html: `<p>Biorę obie, będę jutro po 17.</p>`,
      },
    ],
  },
];

// ---------- Archiwum ----------

export const snapshots: Snapshot[] = [
  {
    service: 'www',
    path: '/dsroka',
    kind: 'page',
    archivedAt: '2024-05-12T03:14:00Z',
    title: 'Dominik Sroka — fotografia',
    author: 'dsroka',
    html: dsrokaPage(ADDR.dominikOldBtc, 'Po wpłacie proszę o wiadomość e-mail z datą uroczystości.'),
    afterChange: false,
  },
  {
    service: 'www',
    path: '/dsroka',
    kind: 'page',
    archivedAt: '2025-03-02T01:40:00Z',
    title: 'Dominik Sroka — fotografia',
    author: 'dsroka',
    html: dsrokaPage(ADDR.dominikOldBtc, 'Po wpłacie proszę o wiadomość e-mail z datą uroczystości.'),
    afterChange: false,
  },
  {
    service: 'www',
    path: '/dsroka',
    kind: 'page',
    archivedAt: '2025-09-20T02:05:00Z',
    title: 'Dominik Sroka — fotografia',
    author: 'dsroka',
    html: dsrokaPage(ADDR.dominikNewBtc, 'Uwaga: od września 2025 r. obowiązuje nowy adres portfela.'),
    afterChange: true,
  },
];

// ---------- Całość: scenariusze a–h, „rynek P2P" (data/market.ts), „powiązane tożsamości" (data/related.ts), „dowody" (data/proofs.ts) ----------

/** Adresy części rynkowej — do testów i dokumentacji. */
export { MARKET_ADDR, RELATED_ADDR, PROOF_ADDR };

export const labeledAddresses: LabeledAddress[] = [...baseLabeledAddresses, ...marketLabeledAddresses, ...relatedLabeledAddresses, ...proofLabeledAddresses];
export const ledger: LedgerRow[] = [
  ...baseLedger,
  ...marketLedger(ADDR),
  // Część „powiązane tożsamości" (data/related.ts) korzysta z adresów usług i anonimowych kontrahentów części rynkowej.
  ...relatedLedger({
    exchangeBtc: ADDR.exchangeBtc,
    exchangeEth: ADDR.exchangeEth,
    exchangeTron: ADDR.exchangeTron,
    p2pBtc: ADDR.p2pBtc,
    p2pTron: ADDR.p2pTron,
    anonBtc: MARKET_ADDR.anonBtc6,
    anonEth: MARKET_ADDR.anonEth4,
    anonTron: MARKET_ADDR.anonTron4,
    igorBtc: MARKET_ADDR.igorBtc,
    darekBtc: MARKET_ADDR.darekBtc,
  }),
  // Część „dowody i ich podróbki" (data/proofs.ts).
  ...proofLedger({
    exchangeBtc: ADDR.exchangeBtc,
    exchangeEth: ADDR.exchangeEth,
    exchangeTron: ADDR.exchangeTron,
    p2pTron: ADDR.p2pTron,
    anonBtc: MARKET_ADDR.anonBtc6,
    anonEth: MARKET_ADDR.anonEth4,
    anonTron: MARKET_ADDR.anonTron4,
  }),
];
export const accounts: Account[] = [...baseAccounts, ...marketAccounts, ...relatedAccounts, ...proofAccounts];
export const pages: Page[] = [...basePages, ...marketPages, ...relatedPages, ...proofPages];
export const threads: Thread[] = [...baseThreads, ...marketThreads, ...proofThreads];

export const scenario = { accounts, pages, threads, snapshots, labeledAddresses, ledger };
export type Scenario = typeof scenario;
