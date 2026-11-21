// Dane trybu demo dla ekranu monitoringu: fikcyjne źródła i trafienia cyklicznego przeglądu.
import type { MonitorSourceStatus, Network, WatchHit } from '@olcys/core';
import { fakeHash } from './demo-data.ts';

type SourceSpec = [id: string, service: string, label: string, seen: number, hits: number, enabled?: boolean, error?: string];

const SOURCES: SourceSpec[] = [
  ['pl-forum-gielda', 'forum-krypto.example', 'Dział „Giełda i wymiana”', 412, 9],
  ['pl-forum-p2p', 'forum-krypto.example', 'Dział „Kupię / sprzedam P2P”', 286, 14],
  ['pl-forum-podpisy', 'forum-krypto.example', 'Podpisy i profile nowych użytkowników', 150, 3],
  ['bazarek-oferty', 'bazarek-p2p.example', 'Nowe oferty wymiany', 198, 21],
  ['bazarek-komentarze', 'bazarek-p2p.example', 'Komentarze pod ofertami', 344, 2],
  ['ogloszenia-elektronika', 'ogloszenia.example', 'Ogłoszenia: elektronika, płatność krypto', 520, 6],
  ['ogloszenia-motoryzacja', 'ogloszenia.example', 'Ogłoszenia: motoryzacja, płatność krypto', 233, 4],
  ['ogloszenia-uslugi', 'ogloszenia.example', 'Ogłoszenia: usługi', 121, 1, false],
  ['bitrozmowy-polski', 'bitrozmowy.example', 'Forum międzynarodowe — dział polski', 640, 11],
  ['bitrozmowy-marketplace', 'bitrozmowy.example', 'Forum międzynarodowe — Marketplace (EN)', 1180, 7],
  ['bitrozmowy-services', 'bitrozmowy.example', 'Forum międzynarodowe — Services (EN)', 730, 2],
  ['czytnik-r-kryptopl', 'czytnik.example', 'Subforum r/kryptoPL', 310, 5],
  ['czytnik-r-p2pcash', 'czytnik.example', 'Subforum r/p2pcash (EN)', 890, 6],
  ['czytnik-r-europe-otc', 'czytnik.example', 'Subforum r/europe_otc (EN)', 402, 3, true, 'Źródło ograniczyło liczbę zapytań (HTTP 429) — przegląd wznowiony zostanie w kolejnym przebiegu.'],
  ['komunikator-kanal-otc', 'komunikator.example', 'Kanał publiczny „OTC Polska”', 260, 8],
  ['komunikator-kanal-usdt', 'komunikator.example', 'Kanał publiczny „USDT za gotówkę”', 190, 9],
  ['mikroblog-tag-krypto', 'mikroblog.example', 'Wpisy z tagiem #kryptowaluty', 455, 2],
  ['kodhub-readme', 'kodhub.example', 'Nowe pliki README z adresem do wpłat', 96, 1],
  ['pastebin-nowe', 'wklejka.example', 'Nowe publiczne wklejki', 1500, 0, true, 'Nie udało się pobrać listy (przekroczony czas odpowiedzi 30 s).'],
  ['darkforum-lustro', 'lustro-forum.example', 'Publiczne lustro forum (bez logowania)', 88, 1, false],
];

export const demoMonitorSources: MonitorSourceStatus[] = SOURCES.map(([connectorId, service, label, documentsSeen, hits, enabled = true, lastError]) => ({
  connectorId,
  service,
  label,
  enabled,
  lastRunAt: enabled ? '2026-11-20T08:30:00Z' : undefined,
  lastError,
  documentsSeen,
  hits,
}));

const address = (network: Network, seed: string) =>
  network === 'ethereum'
    ? `0x${fakeHash(seed).slice(0, 40)}`
    : network === 'tron'
      ? `T${fakeHash(seed).slice(0, 33).toUpperCase().replace(/0/g, 'x')}`
      : `bc1q${fakeHash(seed).slice(0, 38).replace(/[1bio]/g, 'q')}`;

interface HitSpec {
  source: string;
  author: string;
  title: string;
  /** `{a}` zostaje zastąpione adresem. */
  text: string;
  language: string;
  network: Network;
  polish: [number, string[]];
  suspicion: [number, string[]];
  when: string;
  /** Wynik automatycznej analizy: [najwyższy Wskaźnik Pewności, wypłaty na lata]. */
  lead?: [number, Record<string, number>];
  status?: WatchHit['status'];
}

const HITS: HitSpec[] = [
  {
    source: 'czytnik-r-p2pcash', author: 'wawa_cashout', title: 'Selling USDT for cash, Warsaw area', language: 'en', network: 'tron', when: '2026-11-20T07:42:00Z',
    text: 'Selling 40k USDT, cash in Warsaw, BLIK ok for smaller parts. No KYC, meet in person. Send to {a} after we agree. PLN only.',
    polish: [86, ['Miasto: Warsaw (Warszawa).', 'Płatność BLIK — system dostępny tylko w Polsce.', 'Waluta rozliczenia: PLN.']],
    suspicion: [82, ['Sprzedaż za gotówkę przy spotkaniu.', 'Deklaracja „no KYC”.', 'Duża kwota: 40 tys. USDT.']],
    lead: [70, { '2025': 310000, '2026': 468000 }],
  },
  {
    source: 'pl-forum-p2p', author: 'kantor_bez_pytan', title: 'Skup BTC/USDT — gotówka od ręki, cała Polska', language: 'pl', network: 'bitcoin', when: '2026-11-20T06:15:00Z',
    text: 'Skupuję BTC i USDT, gotówka od ręki, Katowice i okolice, większe kwoty dojazd. Bez zbędnych formalności. Adres do wpłaty testowej: {a}. Tel. +48 555 010 777.',
    polish: [97, ['Język polski.', 'Miasto: Katowice.', 'Numer telefonu +48.']],
    suspicion: [88, ['Skup za gotówkę „od ręki”.', 'Deklaracja braku formalności.', 'Oferta skierowana na większe kwoty.']],
    lead: [70, { '2026': 356000 }],
  },
  {
    source: 'komunikator-kanal-usdt', author: '@usdt_hurt_wlkp', title: 'USDT hurt — Poznań', language: 'pl', network: 'tron', when: '2026-11-19T21:03:00Z',
    text: 'USDT hurt od 20k, Poznań, odbiór osobisty albo przelew na telefon. Stali klienci lepszy kurs. Portfel: {a}',
    polish: [95, ['Język polski.', 'Miasto: Poznań.', 'Przelew na telefon (BLIK).']],
    suspicion: [76, ['Sprzedaż hurtowa od 20 tys. USDT.', 'Odbiór osobisty.', 'Stała, powtarzalna oferta.']],
    lead: [85, { '2025': 412000, '2026': 268000 }],
  },
  {
    source: 'bitrozmowy-polski', author: 'miner_z_garazu', title: 'Sprzedam koparki, przyjmę ETH/BTC', language: 'pl', network: 'ethereum', when: '2026-11-19T17:30:00Z',
    text: 'Likwidacja kopalni pod Rzeszowem, 12 koparek. Płatność ETH na {a} albo przelew. Faktury nie wystawiam.',
    polish: [92, ['Język polski.', 'Miasto: Rzeszów.']],
    suspicion: [64, ['Deklaracja braku faktury.', 'Sprzedaż sprzętu wysokiej wartości za kryptowalutę.']],
    lead: [70, { '2024': 122000 }],
  },
  {
    source: 'ogloszenia-motoryzacja', author: 'auto_komis_jg', title: 'BMW 5 2019 — możliwa zapłata w kryptowalutach', language: 'pl', network: 'bitcoin', when: '2026-11-19T12:11:00Z',
    text: 'Sprzedam BMW serii 5, 119 000 zł do negocjacji. Chętnie przyjmę zapłatę w BTC: {a}. Jelenia Góra, tel. +48 555 010 432.',
    polish: [98, ['Język polski.', 'Cena w PLN.', 'Miasto: Jelenia Góra.', 'Numer telefonu +48.']],
    suspicion: [58, ['Transakcja o wysokiej wartości (119 tys. zł) rozliczana w kryptowalucie.']],
    lead: [85, { '2025': 74000, '2026': 119000 }],
  },
  {
    source: 'czytnik-r-europe-otc', author: 'otc_baltic', title: 'OTC desk — EUR/PLN/USDT, in person', language: 'en', network: 'tron', when: '2026-11-19T10:48:00Z',
    text: 'OTC desk, Gdansk and Tricity. EUR or PLN cash, USDT TRC-20 to {a}. Volume 10k–200k. Polish and English spoken.',
    polish: [74, ['Miasto: Gdansk (Gdańsk), Trójmiasto.', 'Rozliczenie w PLN.', 'Deklaracja znajomości języka polskiego.']],
    suspicion: [79, ['Gotówka przy spotkaniu.', 'Wolumen do 200 tys.', 'Brak wzmianki o weryfikacji klienta.']],
  },
  {
    source: 'bazarek-oferty', author: 'bitkolekcjoner', title: 'Kupię USDT, płacę BLIK-iem', language: 'pl', network: 'tron', when: '2026-11-18T19:25:00Z',
    text: 'Kupię USDT do 15 tys., płacę BLIK-iem lub gotówką (Leszno). Wyślij na {a}, płacę po 1 potwierdzeniu.',
    polish: [94, ['Język polski.', 'Płatność BLIK.', 'Miasto: Leszno.']],
    suspicion: [61, ['Rozliczenie gotówką.', 'Powtarzalne oferty tego autora.']],
  },
  {
    source: 'komunikator-kanal-otc', author: '@gotowka_3city', title: 'Wymiana krypto ⇄ gotówka', language: 'pl', network: 'bitcoin', when: '2026-11-18T15:02:00Z',
    text: 'Wymiana BTC/ETH/USDT na gotówkę i odwrotnie. Sopot, spotkanie w miejscu publicznym. Prowizja 2%. Depozyt: {a}',
    polish: [93, ['Język polski.', 'Miasto: Sopot.']],
    suspicion: [84, ['Stała działalność wymiany za prowizję.', 'Gotówka przy spotkaniu.', 'Brak informacji o rejestracji działalności.']],
  },
  {
    source: 'bitrozmowy-marketplace', author: 'devpolska', title: '[WTS] Freelance dev work, crypto accepted', language: 'en', network: 'ethereum', when: '2026-11-18T09:40:00Z',
    text: 'Backend developer based in Krakow, Poland. Invoices on request. Pay in ETH/USDC to {a} or bank transfer (PLN/EUR).',
    polish: [81, ['Miasto: Krakow (Kraków), Poland.', 'Rozliczenie w PLN.']],
    suspicion: [22, ['Wynagrodzenie w kryptowalucie.', 'Autor deklaruje wystawianie faktur — sygnał łagodzący.']],
  },
  {
    source: 'pl-forum-gielda', author: 'nowy_w_krypto', title: 'Jak wypłacić z giełdy na konto w PL?', language: 'pl', network: 'bitcoin', when: '2026-11-17T20:19:00Z',
    text: 'Mam trochę BTC na {a}, chcę wypłacić na konto w polskim banku. Która giełda robi przelewy w PLN najszybciej?',
    polish: [96, ['Język polski.', 'Wzmianka o polskim banku i PLN.']],
    suspicion: [14, ['Pytanie o wypłatę na rachunek bankowy — typowe, bez cech obrotu.']],
  },
  {
    source: 'czytnik-r-kryptopl', author: 'zlecenia_it_24', title: 'Rozliczenie B2B w USDC — jak księgować?', language: 'pl', network: 'ethereum', when: '2026-11-17T11:05:00Z',
    text: 'Klient z USA płaci mi w USDC na {a}, ok. 6 tys. miesięcznie. Jak to wykazać w PIT? Ktoś ma doświadczenie z urzędem?',
    polish: [95, ['Język polski.', 'Wzmianka o PIT i urzędzie skarbowym.']],
    suspicion: [31, ['Regularne przychody w kryptowalucie.', 'Autor pyta o rozliczenie podatkowe — sygnał łagodzący.']],
    lead: [50, { '2026': 18500 }],
  },
  {
    source: 'ogloszenia-elektronika', author: 'elektro_okazje', title: 'iPhone 15 Pro, nowe, hurt — płatność BTC', language: 'pl', network: 'bitcoin', when: '2026-11-16T14:44:00Z',
    text: 'Hurtowe ilości iPhone 15 Pro, bez paragonu, wysyłka paczkomatem. Płatność BTC: {a}. Tylko poważne oferty.',
    polish: [90, ['Język polski.', 'Wysyłka paczkomatem — usługa dostępna w Polsce.']],
    suspicion: [72, ['Sprzedaż hurtowa bez paragonu.', 'Wyłącznie płatność kryptowalutą.']],
    status: 'dismissed',
  },
  {
    source: 'bitrozmowy-services', author: 'hodl_sven', title: 'Donations for my open-source wallet', language: 'en', network: 'bitcoin', when: '2026-11-16T08:12:00Z',
    text: 'If you like the project, donations are welcome: {a}. Based in Stockholm, happy to answer questions.',
    polish: [3, ['Brak sygnałów związku z Polską (lokalizacja: Sztokholm).']],
    suspicion: [6, ['Prośba o darowizny na projekt otwartoźródłowy — bez cech obrotu.']],
  },
  {
    source: 'mikroblog-tag-krypto', author: 'tomwzor', title: 'Wpis: nowy adres do rozliczeń', language: 'pl', network: 'ethereum', when: '2026-11-15T18:30:00Z',
    text: 'Zmieniłem adres do rozliczeń za zlecenia, teraz {a}. Stary już nieaktualny. #kryptowaluty #freelance',
    polish: [91, ['Język polski.', 'Profil z lokalizacją Poznań.']],
    suspicion: [47, ['Zmiana adresu do rozliczeń.', 'Regularne przyjmowanie płatności w kryptowalucie.']],
  },
];

/** Trafienia bez wyniku analizy; `lead` dokleja zastępnik API. */
export const demoHits: (WatchHit & { leadSpec?: [number, Record<string, number>] })[] = HITS.map((spec, index) => {
  const source = demoMonitorSources.find((item) => item.connectorId === spec.source)!;
  const value = address(spec.network, `${spec.author}0`);
  return {
    id: `trafienie-${index + 1}`,
    detectedAt: '2026-11-20T08:30:00Z',
    connectorId: source.connectorId,
    service: source.service,
    url: `https://${source.service}/wpis/${fakeHash(spec.title).slice(0, 8)}`,
    title: spec.title,
    author: spec.author,
    publishedAt: spec.when,
    excerpt: spec.text.replace('{a}', value),
    language: spec.language,
    addresses: [{ address: value, network: spec.network }],
    polishNexus: { score: spec.polish[0], reasons: spec.polish[1] },
    suspicion: { score: spec.suspicion[0], reasons: spec.suspicion[1] },
    status: spec.status ?? (spec.lead ? 'analyzed' : 'new'),
    leadSpec: spec.lead,
  };
});
