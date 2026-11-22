// Część scenariusza „ostrzeżenia o możliwym oszustwie”: fałszywe rozdanie i ostrzeżenia poszkodowanych.
// Wszystkie osoby, konta i adresy są ZMYŚLONE. Adresy wygenerowano skryptem scripts/generate-addresses.ts
// z losowych danych — nikt nie zna do nich kluczy.
//
// Przebieg (sprawa: sam adres Bitcoin SCAM_ADDR.giveawayBtc):
//   Web2 — wpis poszkodowanej na własnym profilu w serwisie Społeczność (cytuje reklamę „odeślemy x2”), komentarz
//          drugiej osoby; osobny wątek na forum z ostrzeżeniami i jedną KOPIĄ cudzego ostrzeżenia (ta sama treść —
//          jedno pochodzenie). Autorzy ostrzeżeń to poszkodowani i świadkowie, nie właściciele — właściciel nieustalony.
//   Blockchain — 10 drobnych wpłat od 10 różnych nadawców w ciągu ok. 30 godzin od pierwszej aktywności,
//          potem wyprowadzenie prawie całości na inny adres (wzorzec fałszywego rozdania — hipoteza).
// Plik nie dodaje ofert (rynek P2P bez zmian) i nie zmienia pozostałych części scenariusza.

import type { Account, LabeledAddress, LedgerRow, Thread } from './scenario.ts';

export const SCAM_ADDR = {
  /** Adres „rozdania” (Bitcoin) — przedmiot sprawy demonstracyjnej. */
  giveawayBtc: 'bc1qqaqykqddpsm50g6thsqju895cjntaedqynh3dw',
  /** Adres, na który wyprowadzono środki. */
  sweepBtc: 'bc1qay5ksep4fyzgd9llxn4ltdy0s9ksqkxns8ma5w',
  /** Nadawcy wpłat (ofiary). */
  victims: [
    '1FWxnYmwSeiX894vD7RRzRdJtQQSZh7tfC',
    '1Jjp8X1VwWEjVAcoUHprzGHsDGcU5RUG8u',
    '1NdLqrojq2L5PueEwiGVTTKgm4G7FQTw5Y',
    '1GfVW4tyJtJCShUfF82tBvW2wjrva3FeCE',
    '1LLM2sAbnm4qGZVoK6gHiy1pkTydqAHhEw',
    '1JkQDZehYWNWaCumEyT3Ls5AQWop5hEuBG',
    '1CfnMYQiQzRz1TPrxeAVmXMteuPtza6BBp',
    '1HEmZw4fAcZtMqDed5zYEaCXpLzmXToh3D',
    '1CG3unR2Qi1jPJUhH4oFULZKZn27TVek1x',
    '1MpizEM4ENMUer8m9pohwKgwd3v1G2DMaA',
  ],
} as const;

const S = SCAM_ADDR;
const code = (address: string) => `<code>${address}</code>`;
const entry = (author: string, publishedAt: string, text: string) => ({ author, publishedAt, html: `<p>${text}</p>` });

export const scamAccounts: Account[] = [
  { service: 'spolecznosc', handle: 'gosia_z_lodzi', createdAt: '2021-03-14T10:00:00Z' },
  { service: 'spolecznosc', handle: 'pan_tadeusz_btc', createdAt: '2020-11-02T10:00:00Z' },
  { service: 'forum', handle: 'ostrozny_inwestor', createdAt: '2019-06-21T10:00:00Z' },
  { service: 'forum', handle: 'kasia_poszkodowana', createdAt: '2023-01-09T10:00:00Z' },
  { service: 'forum', handle: 'moderator_bezpieczenstwo', createdAt: '2018-02-01T10:00:00Z' },
  { service: 'forum', handle: 'przeklejacz_ostrzezen', createdAt: '2024-07-30T10:00:00Z' },
];

const WARNING_COPY = `UWAGA OSZUSTWO! Fałszywe rozdanie BTC zbiera wpłaty na ${code(S.giveawayBtc)} — nic nie wraca. Nie wpłacajcie, zgłoszone na policję.`;

export const scamThreads: Thread[] = [
  {
    // Ostrzeżenie na WŁASNYM profilu poszkodowanej (kategoria „profil”) — mimo to autorka nie jest właścicielką adresu.
    service: 'spolecznosc',
    path: '/wpis/777',
    title: 'UWAGA: fałszywe rozdanie BTC',
    opening: {
      kind: 'post',
      author: 'gosia_z_lodzi',
      publishedAt: '2026-05-11T12:30:00Z',
      html: `<p>UWAGA! Reklama obiecywała: „Rozdajemy 50 BTC! Wyślij 0,05 BTC, a w godzinę odeślemy x2”. Wysłałam 0,05 BTC na ${code(S.giveawayBtc)} i nic nie wróciło. To oszustwo, nie wpłacajcie!</p>`,
    },
    itemKind: 'comment',
    itemSegment: 'komentarz',
    items: [entry('pan_tadeusz_btc', '2026-05-11T15:10:00Z', `Scam! Ukradli mi 0,08 BTC. Adres ${code(S.giveawayBtc)} zgłoszony do CERT.`)],
  },
  {
    service: 'forum',
    path: '/watek/88',
    title: 'Ostrzeżenie: fałszywe rozdanie BTC w serwisie Społeczność',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      entry('ostrozny_inwestor', '2026-05-11T18:00:00Z', WARNING_COPY),
      entry('kasia_poszkodowana', '2026-05-12T08:15:00Z', `Potwierdzam, ten sam adres ${code(S.giveawayBtc)} — wpłaciłam 0,1 BTC po reklamie „odeślemy x2”. Phishing, uważajcie.`),
      // Kopia cudzego ostrzeżenia — ta sama treść, jedno pochodzenie (liczy się raz).
      entry('przeklejacz_ostrzezen', '2026-05-12T09:00:00Z', WARNING_COPY),
      entry('moderator_bezpieczenstwo', '2026-05-12T10:30:00Z', `Wątek przypięty. Adres ${code(S.giveawayBtc)} oznaczony jako oszustwo — fałszywa akcja podszywa się pod znany profil.`),
    ],
  },
];

export const scamLabeledAddresses: LabeledAddress[] = [
  { address: S.giveawayBtc, network: 'bitcoin', addressClass: 'private' },
  { address: S.sweepBtc, network: 'bitcoin', addressClass: 'private' },
];

const row = (time: string, from: string, to: string, amount: number): LedgerRow => ({ time, from, to, asset: 'BTC', amount });

/** 10 wpłat od 10 nadawców w ciągu ok. 30 godzin, potem wyprowadzenie 95% środków. */
export function scamLedger(): LedgerRow[] {
  const amounts = [0.05, 0.08, 0.1, 0.02, 0.04, 0.06, 0.03, 0.05, 0.07, 0.02];
  const inbound = S.victims.map((victim, index) => row(`2026-05-${index < 6 ? '10' : '11'}T${String(10 + (index % 6) * 2).padStart(2, '0')}:15:00Z`, victim, S.giveawayBtc, amounts[index]!));
  const total = amounts.reduce((sum, value) => sum + value, 0);
  return [...inbound, row('2026-05-11T22:40:00Z', S.giveawayBtc, S.sweepBtc, Math.round(total * 0.95 * 1e8) / 1e8)];
}
