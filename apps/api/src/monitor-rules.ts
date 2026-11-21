// Kiedy publikacja jest TRAFIENIEM monitoringu — jedna definicja dla przebiegu i dla
// ponownego przeliczenia zapisanych trafień.
//
// Trafieniem jest publikacja, która spełnia jeden z warunków:
//   own_address    — zawiera adres kryptowalutowy, który autor podaje jako WŁASNY (odczyt modelu
//                    `own_address`, a bez modelu reguły: „mój adres”, „wpłaty na”, „donate”, oferta + adres);
//                    niezależnie od kraju;
//   offer_poland   — oferta kupna, sprzedaży lub wymiany kryptowaluty (reguła albo odczyt modelu)
//                    ze związkiem z Polską od progu; nie dotyczy kanałów wiadomości i artykułów;
//   address_poland — adres kryptowalutowy i związek z Polską od progu.
// Sama publikacja z adresem (np. post na forum zarządzania DAO z adresem kontraktu) trafieniem
// nie jest — zostaje tylko w indeksie publikacji. Adresy rozpoznane jako kontrakty są pomijane.

import type { ProfileAttributes, ScoredSignal, TextInsight } from '@olcys/core';
import { ADDRESS_LIST_MIN } from './analysis.ts';
import { SIGNAL_RULES, isCryptoAsset, isGovernanceForum, isNewsSource, ownershipClaim, polishNexus, suspicion, tradeOfferAt } from './signals.ts';

export type HitBasis = 'own_address' | 'offer_poland' | 'address_poland';

/** Publikacja w postaci potrzebnej do oceny (z monitoringu albo z indeksu publikacji). */
export interface Publication {
  connectorId: string;
  service: string;
  url: string;
  title: string;
  text: string;
  author?: string;
  profile?: ProfileAttributes;
}

export interface PublicationAddress {
  address: string;
  network: string;
}

/** Ocena publikacji samymi regułami. */
export interface Evaluation {
  addresses: PublicationAddress[];
  polishNexus: ScoredSignal;
  language: string;
  suspicion: ScoredSignal;
  /** Cytat z ofertą obrotu kryptowalutą wykrytą regułami. */
  offer?: string;
  /** Cytat ze zwrotem, którym autor podaje adres jako własny (reguła). */
  ownership?: string;
  /** Kanał wiadomości albo artykuł redakcyjny. */
  news: boolean;
  /** Forum zarządzania protokołem lub DAO — tu liczy się tylko wyraźne podanie adresu jako własnego. */
  governance: boolean;
  /** Publikacja przeszła wstępny filtr: ma adres albo ofertę obrotu kryptowalutą — tylko takie czyta model. */
  candidate: boolean;
}

export function evaluatePublication(doc: Publication, addresses: PublicationAddress[]): Evaluation {
  const nexus = polishNexus(doc);
  const found = tradeOfferAt(doc);
  const offer = found?.quote;
  const hasAddress = addresses.length > 0;
  // Artykuł redakcyjny: długa publikacja bez adresu i bez autora albo taka, w której „oferta”
  // pada dopiero w głębi tekstu (ogłoszenie zaczyna się od oferty, artykuł — nie).
  const article =
    !hasAddress &&
    ((!doc.author && doc.text.length > SIGNAL_RULES.thresholds.newsMinLength) || (found !== undefined && found.index > SIGNAL_RULES.thresholds.offerMaxPosition));
  return {
    addresses,
    polishNexus: { score: nexus.score, reasons: nexus.reasons },
    language: nexus.language,
    suspicion: suspicion(doc, { hasAddress }),
    ...(offer ? { offer } : {}),
    // Oferta z adresem do wpłaty też jest podaniem adresu jako własnego — poza forami zarządzania,
    // gdzie „buying/selling ETH” to język propozycji, a adresy to kontrakty i multisigi.
    ...(hasAddress ? (() => {
      const governance = isGovernanceForum(doc.service, doc.connectorId);
      const claim = ownershipClaim(doc.text, addresses.map((item) => item.address)) ?? (offer && !governance ? `oferta z adresem: ${offer}` : undefined);
      return claim ? { ownership: claim } : {};
    })() : {}),
    news: isNewsSource(doc.connectorId) || article,
    governance: isGovernanceForum(doc.service, doc.connectorId),
    candidate: hasAddress || offer !== undefined,
  };
}

export interface HitDecision {
  hit: boolean;
  basis?: HitBasis;
  /** Zdanie dla analityka: dlaczego to jest (albo nie jest) trafienie. */
  reason: string;
  /** Adresy po odsianiu kontraktów. */
  addresses: PublicationAddress[];
}

/**
 * Decyzja według definicji trafienia. `insight` — odczyt modelu (gdy publikację czytał model);
 * `contracts` — adresy rozpoznane jako kontrakty (małymi literami).
 */
export function decideHit(evaluation: Evaluation, insight?: TextInsight, contracts: Set<string> = new Set()): HitDecision {
  const threshold = SIGNAL_RULES.thresholds.hitPolishNexus;
  const addresses = evaluation.addresses.filter((item) => !contracts.has(item.address.toLowerCase()));
  const removed = evaluation.addresses.length - addresses.length;
  const nexus = Math.max(evaluation.polishNexus.score, insight?.polishNexus?.score ?? 0);
  const polish = nexus >= threshold;
  // Gdy publikację czytał model, o własności adresu rozstrzyga jego odczyt; reguła jest zastępstwem.
  const own = insight ? insight.ownership === 'own_address' : evaluation.ownership !== undefined;
  // Oferta odczytana przez model liczy się tylko wtedy, gdy dotyczy kryptowaluty (aktywo z listy kryptowalut) —
  // sprzedaż komputera czy monitora też jest „ofertą”, ale nie obrotem kryptowalutą.
  const offer = evaluation.offer !== undefined || isCryptoAsset(insight?.offer?.asset);

  // Publikacja z wieloma adresami to zestawienie (lista kontraktów, odbiorców, „najbogatszych portfeli”),
  // a nie czyjś adres.
  if (evaluation.addresses.length >= ADDRESS_LIST_MIN) {
    return { hit: false, addresses, reason: `Nie spełnia kryteriów trafienia: publikacja jest zestawieniem ${evaluation.addresses.length} adresów.` };
  }
  if (addresses.length > 0 && own) {
    return { hit: true, basis: 'own_address', addresses, reason: insight ? `Autor podaje adres jako własny (odczyt modelu ${insight.model}${insight.quote ? `: „${insight.quote}”` : ''}).` : `Autor podaje adres jako własny: „${evaluation.ownership}”.` };
  }
  if (offer && polish && !evaluation.news) {
    return { hit: true, basis: 'offer_poland', addresses, reason: `Oferta obrotu kryptowalutą ze związkiem z Polską (${nexus}/100, próg ${threshold}).` };
  }
  // Na forach zarządzania sam adres z polską treścią nie wystarcza — adresy to tam kontrakty i multisigi.
  if (addresses.length > 0 && polish && !evaluation.governance) {
    return { hit: true, basis: 'address_poland', addresses, reason: `Adres kryptowalutowy i związek z Polską (${nexus}/100, próg ${threshold}).` };
  }
  const why =
    removed > 0 && addresses.length === 0
      ? 'adresy w publikacji to kontrakty, nie adresy osób'
      : addresses.length > 0
        ? 'adres bez przesłanki, że należy do autora, i bez związku z Polską'
        : offer && polish
          ? 'oferta w kanale wiadomości lub artykule redakcyjnym'
          : 'brak adresu oraz brak oferty obrotu kryptowalutą ze związkiem z Polską';
  return { hit: false, addresses, reason: `Nie spełnia kryteriów trafienia: ${why}.` };
}
