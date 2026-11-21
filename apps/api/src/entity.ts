// Profile widziane w analizie: dokumenty jednego konta (serwis + nazwa konta) złożone
// w jedną kartę z atrybutami, adresami i sposobem odnalezienia. Ocenę, czyj to profil,
// wystawia `persons.ts` — tutaj tylko porządkujemy materiał.

import type { AnalysisRun, Identifier, ProfileAttributes, ProfileCard } from '@olcys/core';
import { normalizeProfileUrl } from './diff.ts';
import { matchRank, normalize } from './identity.ts';
import type { IdentityAssessment } from './identity.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { RunIntel, Sighting } from './intel.ts';

/** Karta profilu wraz z materiałem roboczym do łączenia profili w osoby. */
export interface ProfileNode {
  card: ProfileCard;
  sightings: Sighting[];
  /** Najmocniejsza ocena sposobu odnalezienia wśród dokumentów profilu. */
  base: IdentityAssessment;
  /** Identyfikator, po którym profil odnaleziono (dla najmocniejszej oceny). */
  matchedIdentifier: Identifier;
  /** Krok wyszukiwania, w którym profil pojawił się po raz pierwszy. */
  step: number;
  /** Nazwy, pod którymi inne profile mogą wskazywać ten profil (nick, adres URL). */
  names: Set<string>;
  /** Wartości wskazywane przez ten profil (odkryte identyfikatory, odnośniki). */
  refs: Set<string>;
}

const cleanUrl = (url: string): string => normalizeProfileUrl(url).toLowerCase();

function handleOf(sighting: Sighting): string | undefined {
  const fromMatch = sighting.matchedIdentifier.type === 'nick' || sighting.matchedIdentifier.type === 'login';
  const raw = sighting.profile?.handle ?? sighting.author ?? (fromMatch ? sighting.matchedIdentifier.value : undefined);
  return raw ? raw.trim().replace(/^@/, '') : undefined;
}

/** Klucz profilu: `serwis|nazwa konta`, a gdy źródło nie podaje konta — adres dokumentu. */
export function profileKey(sighting: Sighting): string {
  const handle = handleOf(sighting);
  return handle ? `${sighting.service.toLowerCase()}|${normalize(handle)}` : cleanUrl(sighting.url);
}

/**
 * Dokumenty analizy jako widziane profile. Starsze analizy nie mają zapisanego
 * materiału (`intel`) — wtedy odtwarzamy go ze śladów przy adresach.
 */
export function sightingsOf(run: AnalysisRun, intel?: RunIntel | null): Sighting[] {
  if (intel) return intel.sightings;
  const byKey = new Map<string, Sighting>();
  for (const finding of run.findings) {
    for (const evidence of finding.evidence) {
      const key = sightingKey(evidence);
      const existing = byKey.get(key);
      if (existing) {
        existing.addresses.push(addressKey(finding));
        continue;
      }
      byKey.set(key, {
        url: evidence.url,
        service: evidence.service,
        connectorId: evidence.connectorId,
        title: evidence.title,
        author: evidence.author,
        publishedAt: evidence.publishedAt,
        archivedAt: evidence.archivedAt,
        fetchedAt: evidence.capturedAt,
        category: evidence.category,
        matchedIdentifier: evidence.matchedIdentifier,
        discoveredIdentifiers: [],
        identity: { match: evidence.identityMatch, reasons: evidence.identityReasons ?? [] },
        step: 0,
        addresses: [addressKey(finding)],
        role: 'subject',
      });
    }
  }
  return [...byKey.values()];
}

const union = (target: string[] | undefined, extra: string[] | undefined): string[] | undefined => {
  const merged = [...new Set([...(target ?? []), ...(extra ?? [])])];
  return merged.length > 0 ? merged : undefined;
};

function mergeAttributes(target: ProfileAttributes, extra: ProfileAttributes | undefined): void {
  if (!extra) return;
  target.handle ??= extra.handle;
  target.displayName ??= extra.displayName;
  target.location ??= extra.location;
  target.avatarUrl ??= extra.avatarUrl;
  target.bio ??= extra.bio;
  target.createdAt ??= extra.createdAt;
  target.emails = union(target.emails, extra.emails);
  target.phones = union(target.phones, extra.phones);
  target.urls = union(target.urls, extra.urls);
}

/** Karty profili z dokumentów w podanej roli (domyślnie: przypisanych podmiotowi). */
export function buildProfileNodes(run: AnalysisRun, sightings: Sighting[], role: Sighting['role'] = 'subject'): ProfileNode[] {
  const groups = new Map<string, Sighting[]>();
  for (const sighting of sightings) {
    if (sighting.role !== role) continue;
    const key = profileKey(sighting);
    groups.set(key, [...(groups.get(key) ?? []), sighting]);
  }

  const evidenceByDoc = new Map<string, string[]>();
  for (const finding of run.findings) {
    for (const evidence of finding.evidence) {
      const key = sightingKey(evidence);
      evidenceByDoc.set(key, [...(evidenceByDoc.get(key) ?? []), evidence.id]);
    }
  }

  const nodes: ProfileNode[] = [];
  for (const [id, items] of groups) {
    // Wizytówką profilu jest bieżąca strona własna, a nie wpis czy kopia archiwalna.
    const front =
      items.find((item) => !item.archivedAt && item.category === 'own_profile') ?? items.find((item) => !item.archivedAt) ?? items[0]!;
    const best = [...items].sort((a, b) => matchRank(b.identity.match) - matchRank(a.identity.match) || a.step - b.step)[0]!;
    const handle = handleOf(front) ?? handleOf(best);
    const attributes: ProfileAttributes = {};
    for (const item of [front, ...items]) mergeAttributes(attributes, item.profile);
    if (handle) attributes.handle ??= handle;

    const names = new Set<string>([...items.map((item) => cleanUrl(item.url))]);
    if (handle) names.add(normalize(handle));
    const refs = new Set<string>();
    for (const item of items) {
      for (const identifier of item.discoveredIdentifiers) {
        refs.add(identifier.type === 'profile_url' ? cleanUrl(identifier.value) : normalize(identifier.value));
      }
    }
    for (const url of attributes.urls ?? []) refs.add(cleanUrl(url));
    // Profil często podaje sam siebie — to nie jest odnośnik do innego profilu.
    for (const name of names) refs.delete(name);

    nodes.push({
      card: {
        id,
        service: front.service,
        url: front.url,
        ...(handle ? { handle } : {}),
        attributes,
        identityMatch: best.identity.match,
        identityReasons: [...best.identity.reasons],
        identityScore: 0,
        addresses: [...new Set(items.flatMap((item) => item.addresses))],
        evidenceIds: [...new Set(items.flatMap((item) => evidenceByDoc.get(sightingKey(item)) ?? []))],
      },
      sightings: items,
      base: best.identity,
      matchedIdentifier: best.matchedIdentifier,
      step: Math.min(...items.map((item) => item.step)),
      names,
      refs,
    });
  }
  return nodes;
}

/** Czy klucz decyzji analityka wskazuje ten profil (`serwis|konto`, adres profilu lub dokumentu). */
export function decisionMatchesProfile(key: string, node: ProfileNode): boolean {
  const wanted = key.trim().toLowerCase();
  return (
    wanted === node.card.id.toLowerCase() ||
    cleanUrl(key.trim()) === cleanUrl(node.card.url) ||
    node.sightings.some((item) => cleanUrl(item.url) === cleanUrl(key.trim()))
  );
}
