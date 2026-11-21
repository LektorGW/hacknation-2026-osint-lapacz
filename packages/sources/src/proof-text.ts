// Dowody dysponowania adresem w treści publikacji: podpisane wiadomości.
// Wykrywane zapisy:
//   1) blok `-----BEGIN BITCOIN SIGNED MESSAGE----- … -----BEGIN SIGNATURE----- … -----END BITCOIN SIGNED MESSAGE-----`
//      (także warianty `BEGIN BITCOIN SIGNATURE` / `END BITCOIN SIGNATURE` oraz bloki ETHEREUM / TRON),
//   2) JSON w stylu Etherscan „Verified Signatures": {"address":"0x…","msg":"…","sig":"0x…"},
//   3) trójki „Address / Message / Signature" (także po polsku: „Adres / Wiadomość / Podpis").
// Każdy podpis jest sprawdzany lokalnie (`verifySignedMessage` z @olcys/core) — bez żadnych żądań do sieci.
//
// Zasada dowodowa (`applyOwnershipProofs`):
//   • podpis POPRAWNY, a podpisana wiadomość wymienia konto publikujące → osobny dokument kategorii
//     `cryptographic_proof` dla tego jednego adresu (pozostałe adresy publikacji zachowują swoją kategorię),
//   • podpis POPRAWNY, ale wiadomość nie wymienia konta publikującego → bez podniesienia: dowodzi dysponowania
//     kluczem przez podpisującego, nie tego, że publikujący jest podpisującym (podpis można skopiować),
//   • podpis NIEPOPRAWNY → nigdy nie podnosi kategorii; dopisywana jest uwaga — sfałszowany „dowód" sam jest ustaleniem.

import { validateAddress, verifySignedMessage } from '@olcys/core';
import type { Network, SourceDocument } from '@olcys/core';

export type ProofFormat = 'signed_block' | 'json' | 'labelled_triple';

/** Podpisana wiadomość znaleziona w treści wraz z wynikiem weryfikacji. */
export interface OwnershipProof {
  address: string;
  network: Network;
  /** Wiadomość w brzmieniu, dla którego podpis się zweryfikował (albo odczytana z treści, gdy się nie zweryfikował). */
  message: string;
  signature: string;
  valid: boolean;
  /** Schemat podpisu, np. `bitcoin-message/p2wpkh`, `eip191-personal-sign`. */
  scheme: string;
  /** Powód odrzucenia podpisu (gdy `valid` jest `false`). */
  reason?: string;
  format: ProofFormat;
  /** Fragment treści z dowodem — do pokazania analitykowi. */
  excerpt: string;
}

const MAX_PROOFS = 8;
const MAX_MESSAGE_CHARS = 2000;
const EXCERPT_CHARS = 600;

const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86,88}={0,2}$/;
const HEX_SIGNATURE = /^(?:0x)?[0-9a-fA-F]{130}$/;

const isSignature = (token: string): boolean => (BASE64_SIGNATURE.test(token) && token.length === 88) || HEX_SIGNATURE.test(token);

const stripEdges = (token: string): string => token.replace(/^[\s"'`„“”«»(<[]+|[\s"'`„“”«»)>\],;.]+$/g, '');

interface Candidate {
  address: string;
  message: string;
  signature: string;
  format: ProofFormat;
  excerpt: string;
}

const excerptOf = (text: string): string => {
  const flat = text.replace(/[ \t]+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
};

/** Adres i podpis z listy wyrazów (kolejność dowolna; etykiety „Address:", „Version:" są pomijane). */
function addressAndSignature(block: string): { address?: string; signature?: string } {
  let address: string | undefined;
  let signature: string | undefined;
  for (const raw of block.split(/\s+/)) {
    const token = stripEdges(raw);
    if (!token) continue;
    if (!signature && isSignature(token)) signature = token;
    else if (!address && validateAddress(token)) address = validateAddress(token)!.address;
  }
  return { ...(address ? { address } : {}), ...(signature ? { signature } : {}) };
}

const SIGNED_BLOCK =
  /-----BEGIN (?:BITCOIN |ETHEREUM |TRON )?SIGNED MESSAGE-----[ \t]*\r?\n?([\s\S]{1,4000}?)\r?\n?[ \t]*-----BEGIN (?:BITCOIN |ETHEREUM |TRON )?SIGNATURE-----([\s\S]{1,1200}?)-----END (?:BITCOIN |ETHEREUM |TRON )?(?:SIGNED MESSAGE|SIGNATURE)-----/g;

function fromSignedBlocks(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(SIGNED_BLOCK)) {
    const { address, signature } = addressAndSignature(match[2]!);
    if (!address || !signature) continue;
    found.push({ address, message: match[1]!, signature, format: 'signed_block', excerpt: excerptOf(match[0]) });
  }
  return found;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

function fromJson(source: string): Candidate[] {
  const found: Candidate[] = [];
  // Obiekt płaski (bez zagnieżdżeń) zawierający pole podpisu — tak publikuje je Etherscan i portfele.
  for (const match of source.matchAll(/\{[^{}]{20,4000}\}/g)) {
    if (!/"(?:sig|signature)"\s*:/i.test(match[0])) continue;
    let parsed: Record<string, unknown>;
    try {
      // Cudzysłowy typograficzne wstawiane przez edytory zamieniamy na proste.
      parsed = JSON.parse(match[0].replace(/[“”„]/g, '"')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const address = text(parsed.address) ?? text(parsed.addr) ?? text(parsed.signer);
    const message = text(parsed.msg) ?? text(parsed.message);
    const signature = text(parsed.sig) ?? text(parsed.signature);
    const valid = address ? validateAddress(address.trim()) : null;
    if (!valid || message === undefined || !signature || !isSignature(signature.trim())) continue;
    found.push({ address: valid.address, message, signature: signature.trim(), format: 'json', excerpt: excerptOf(match[0]) });
  }
  return found;
}

const LABEL = /(?:^|[\s|;,(>*-])(address|adres|message|wiadomość|wiadomosc|msg|signature|podpis|sig)[ \t]*[:=][ \t]*/giu;

const FIELD_OF: Record<string, 'address' | 'message' | 'signature'> = {
  address: 'address',
  adres: 'address',
  message: 'message',
  wiadomość: 'message',
  wiadomosc: 'message',
  msg: 'message',
  signature: 'signature',
  podpis: 'signature',
  sig: 'signature',
};

function fromLabelledTriples(source: string): Candidate[] {
  const labels = [...source.matchAll(LABEL)].map((match) => ({
    field: FIELD_OF[match[1]!.toLowerCase()]!,
    start: match.index,
    valueStart: match.index + match[0].length,
  }));
  const found: Candidate[] = [];
  let current: { address?: string; message?: string; signature?: string; start: number } | null = null;
  labels.forEach((label, i) => {
    const lineEnd = source.indexOf('\n', label.valueStart);
    const nextLabel = labels[i + 1]?.start ?? source.length;
    const end = Math.min(lineEnd < 0 ? source.length : lineEnd, nextLabel);
    const value = source.slice(label.valueStart, end);
    // Etykieta powtórzona przed skompletowaniem trójki zaczyna nową.
    if (!current || current[label.field] !== undefined || label.start - current.start > 3000) current = { start: label.start };
    if (label.field === 'message') current.message = value;
    else {
      const parsed = addressAndSignature(value);
      if (label.field === 'address' && parsed.address) current.address = parsed.address;
      if (label.field === 'signature' && parsed.signature) current.signature = parsed.signature;
    }
    if (current.address && current.signature && current.message !== undefined) {
      found.push({
        address: current.address,
        message: current.message,
        signature: current.signature,
        format: 'labelled_triple',
        excerpt: excerptOf(source.slice(current.start, end)),
      });
      current = null;
    }
  });
  return found;
}

/** Brzmienia wiadomości do sprawdzenia: zamiana HTML na tekst mogła zmienić odstępy i cudzysłowy wokół niej. */
function messageVariants(message: string): string[] {
  const trimmed = message.trim();
  const unquoted = trimmed.replace(/^["'„“«]+|["'”»]+$/g, '');
  const variants = [message, trimmed, unquoted, trimmed.replace(/\r?\n/g, '\r\n'), trimmed.replace(/\r\n/g, '\n'), `${trimmed}\n`];
  return [...new Set(variants)].filter((variant) => variant.length <= MAX_MESSAGE_CHARS);
}

function check(candidate: Candidate): OwnershipProof | null {
  const network = validateAddress(candidate.address)?.network;
  if (!network || network === 'lab') return null;
  // Podpis Bitcoina jest w Base64, pozostałych sieci — szesnastkowy; niepasujący zapis to nie ten sam dowód.
  let failure: { scheme: string; reason?: string } | undefined;
  for (const message of messageVariants(candidate.message)) {
    const result = verifySignedMessage(candidate.address, message, candidate.signature);
    if (result.valid) return { ...candidate, network, message, valid: true, scheme: result.scheme };
    failure ??= result;
  }
  return {
    ...candidate,
    network,
    message: candidate.message.trim(),
    valid: false,
    scheme: failure?.scheme ?? 'nieznany',
    reason: failure?.reason ?? 'wiadomość jest zbyt długa, by ją sprawdzić',
  };
}

/**
 * Wszystkie podpisane wiadomości w treści, każda z wynikiem weryfikacji. Funkcja czysta: nie łączy się
 * z siecią i nie rzuca wyjątków. Ten sam adres z tym samym podpisem jest zwracany raz.
 */
export function findOwnershipProofs(source: string): OwnershipProof[] {
  if (typeof source !== 'string' || !/sig|podpis/i.test(source)) return [];
  const proofs = new Map<string, OwnershipProof>();
  for (const candidate of [...fromSignedBlocks(source), ...fromJson(source), ...fromLabelledTriples(source)]) {
    if (proofs.size >= MAX_PROOFS) break;
    const key = `${candidate.address}|${candidate.signature}`;
    const existing = proofs.get(key);
    if (existing?.valid) continue;
    const proof = check(candidate);
    if (proof && (!existing || proof.valid)) proofs.set(key, proof);
  }
  return [...proofs.values()];
}

// ---------- Zastosowanie do dokumentu ----------

/** Początek każdej uwagi dopisywanej do treści — po nim analityk (i testy) rozpoznają wpis narzędzia. */
export const PROOF_NOTE_PREFIX = '[OŁCyŚ — weryfikacja podpisu]';
/**
 * Parametr adresu URL dokumentu-dowodu: `<adres publikacji>?podpis=<adres>` (albo `&podpis=…`, gdy adres ma już parametry).
 * Parametr, a nie fragment `#…`: analiza porównuje adresy publikacji bez fragmentu, więc dokument-dowód z samym
 * fragmentem zlałby się z publikacją źródłową i dowód nie zostałby policzony. Serwisy ignorują nieznany parametr,
 * więc adres nadal otwiera publikację źródłową.
 */
export const PROOF_URL_PARAM = 'podpis';

/** Adres dokumentu-dowodu dla podpisanego adresu z danej publikacji. */
export function proofUrl(sourceUrl: string, address: string): string {
  const base = sourceUrl.replace(/#.*$/, '');
  return `${base}${base.includes('?') ? '&' : '?'}${PROOF_URL_PARAM}=${address}`;
}

const IS_PROOF_URL = new RegExp(`[?&]${PROOF_URL_PARAM}=[0-9A-Za-z]{25,90}$`);

const MIN_NAME_CHARS = 3;

/** Nazwy, pod którymi występuje konto publikujące: autor, nazwa konta, nazwa wyświetlana. */
function publisherNames(doc: SourceDocument): string[] {
  const names = [doc.author, doc.profile?.handle, doc.profile?.displayName]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().replace(/^@/, ''))
    .filter((value) => value.length >= MIN_NAME_CHARS);
  return [...new Set(names)];
}

/** Nazwa konta publikującego wymieniona w podpisanej wiadomości (całe słowo, bez względu na wielkość liter). */
export function publisherNamedIn(message: string, doc: SourceDocument): string | undefined {
  const haystack = message.toLowerCase();
  return publisherNames(doc).find((name) => {
    const needle = name.toLowerCase();
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      const before = haystack[at - 1] ?? ' ';
      const after = haystack[at + needle.length] ?? ' ';
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    }
    return false;
  });
}

const quote = (message: string): string => {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
};

/**
 * Stosuje zasadę dowodową do dokumentu. Zwraca dokument pierwotny (z dopisanymi uwagami o każdym
 * znalezionym podpisie; kategoria bez zmian) oraz — dla każdego ważnego dowodu wymieniającego konto
 * publikujące — dodatkowy dokument kategorii `cryptographic_proof`, zawierający wyłącznie ten dowód.
 * Dokument-dowód ma własny adres (`…?podpis=<adres>`), ten sam serwis i autora, więc nie jest liczony
 * jako niezależne źródło; ocena, czy konto należy do badanego podmiotu (`identityMatch`), zostaje bez zmian.
 * Dokument bez podpisanych wiadomości wraca nietknięty (ten sam obiekt).
 */
export function applyOwnershipProofs(doc: SourceDocument): SourceDocument[] {
  // Dokument-dowód (np. odczytany ponownie z indeksu publikacji) nie jest przetwarzany drugi raz.
  if (IS_PROOF_URL.test(doc.url) || doc.text.includes(PROOF_NOTE_PREFIX)) return [doc];
  const proofs = findOwnershipProofs(doc.text);
  if (proofs.length === 0) return [doc];

  const notes: string[] = [];
  const extra: SourceDocument[] = [];
  const names = publisherNames(doc);
  const who = names.length > 0 ? `„${names[0]}"` : 'nieznanego autora';
  for (const proof of proofs) {
    if (!proof.valid) {
      notes.push(
        `${PROOF_NOTE_PREFIX} UWAGA: podpis nie weryfikuje się dla tego adresu (${proof.address}; ${proof.reason ?? 'podpis niepoprawny'}). ` +
          'Opublikowany „dowód" jest nieważny — możliwa podróbka albo skopiowany cudzy podpis. Kategoria źródła bez zmian.',
      );
      continue;
    }
    const named = publisherNamedIn(proof.message, doc);
    if (!named) {
      notes.push(
        `${PROOF_NOTE_PREFIX} Podpis jest poprawny dla adresu ${proof.address} (${proof.scheme}), ale podpisana wiadomość nie wymienia konta publikującego (${who}). ` +
          'Dowodzi to dysponowania kluczem przez podpisującego, a nie tego, że publikujący jest podpisującym — podpis można skopiować. Kategoria źródła bez zmian.',
      );
      continue;
    }
    notes.push(
      `${PROOF_NOTE_PREFIX} Podpis poprawny: wiadomość wymieniająca konto „${named}" została podpisana kluczem adresu ${proof.address} (${proof.scheme}). ` +
        'To dowód kryptograficzny dysponowania adresem przez autora publikacji.',
    );
    if (doc.category === 'cryptographic_proof') continue;
    const { discoveredIdentifiers: _discovered, ...base } = doc;
    extra.push({
      ...base,
      url: proofUrl(doc.url, proof.address),
      title: `Podpisana wiadomość: dowód dysponowania adresem ${proof.address} (${doc.title})`,
      category: 'cryptographic_proof',
      text: [
        `${PROOF_NOTE_PREFIX} Dowód kryptograficzny sprawdzony lokalnie, bez udziału serwisów zewnętrznych.`,
        `Adres: ${proof.address}`,
        `Podpisana wiadomość: ${quote(proof.message)}`,
        `Podpis: ${proof.signature}`,
        `Schemat podpisu: ${proof.scheme}`,
        `Wiadomość wymienia konto publikujące „${named}", a podpis weryfikuje się kluczem tego adresu — autor publikacji dysponuje kluczem prywatnym adresu.`,
        `Publikacja źródłowa: ${doc.url}`,
        'Ograniczenie: podpis dowodzi dysponowania kluczem w chwili podpisania; o tym, czy konto należy do badanej osoby, rozstrzyga osobna ocena tożsamości profilu.',
      ].join('\n'),
    });
  }
  return [{ ...doc, text: `${doc.text}\n${notes.join('\n')}` }, ...extra];
}

/** Zasada dowodowa zastosowana do listy dokumentów (wynik jednego wyszukiwania łącznika). */
export function applyOwnershipProofsToAll(documents: SourceDocument[]): SourceDocument[] {
  return documents.flatMap((doc) => {
    try {
      return applyOwnershipProofs(doc);
    } catch {
      // Błąd w analizie podpisu nie może zabrać analitykowi samej publikacji.
      return [doc];
    }
  });
}
