// Migawka bazy PGlite na dysku: opcjonalne szyfrowanie AES-256-GCM i bezpieczny zapis.
//
// Format pliku zaszyfrowanego: znacznik `OLCYS-MIGAWKA-AES256GCM-1\n` (ASCII), 12 bajtów IV,
// 16 bajtów znacznika uwierzytelnienia GCM, dalej szyfrogram archiwum tar.gz z PGlite.
// Plik bez znacznika to migawka starszego formatu (niezaszyfrowany tar.gz) — nadal się wczytuje.
//
// Zapis nigdy nie niszczy poprzedniej migawki: nowa treść trafia do pliku tymczasowego, jest
// odczytywana z powrotem i sprawdzana (odszyfrowanie + SHA-256), dopiero potem poprzednia migawka
// staje się kopią `.bak`, a plik tymczasowy zajmuje jej miejsce. Kopia `.bak` znika dopiero wtedy,
// gdy nowa migawka na swoim docelowym miejscu przejdzie ponowne sprawdzenie.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const MAGIC = Buffer.from('OLCYS-MIGAWKA-AES256GCM-1\n', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Błąd wczytania migawki — serwer nie może wtedy wystartować na pustej bazie (groziłoby to nadpisaniem danych). */
export class SnapshotError extends Error {}

/**
 * Klucz z OLCYS_SNAPSHOT_KEY: 64 znaki szesnastkowe albo base64 32 bajtów.
 * Pusta wartość = brak szyfrowania; nieprawidłowa = błąd (lepiej nie wystartować niż zapisać jawnie).
 */
export function parseSnapshotKey(raw: string | undefined): Buffer | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === 32) return decoded;
  }
  throw new SnapshotError('OLCYS_SNAPSHOT_KEY musi mieć 32 bajty: 64 znaki szesnastkowe albo base64 (np. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`).');
}

export const isEncryptedSnapshot = (data: Buffer): boolean => data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);

export function encryptSnapshot(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Zwraca treść migawki (tar.gz). Migawka starszego formatu (niezaszyfrowana) wraca bez zmian. */
export function decodeSnapshot(data: Buffer, key: Buffer | undefined): { plain: Buffer; encrypted: boolean } {
  if (!isEncryptedSnapshot(data)) return { plain: data, encrypted: false };
  if (!key) {
    throw new SnapshotError('Migawka bazy jest zaszyfrowana, a OLCYS_SNAPSHOT_KEY nie jest ustawiony — ustaw ten sam klucz, którym ją zapisano. Serwer nie startuje, żeby nie nadpisać danych pustą bazą.');
  }
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = data.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const body = data.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return { plain: Buffer.concat([decipher.update(body), decipher.final()]), encrypted: true };
  } catch {
    throw new SnapshotError('Nie udało się odszyfrować migawki bazy: zły klucz OLCYS_SNAPSHOT_KEY albo uszkodzony plik. Serwer nie startuje, żeby nie nadpisać danych.');
  }
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export interface SnapshotIo {
  /** Dziennik (bez treści danych i bez klucza). */
  log?: (message: string) => void;
}

/**
 * Wczytuje migawkę: najpierw plik główny, a gdy go brak — kopię `.bak` (przerwany zapis).
 * `null` = brak migawki (pierwsze uruchomienie). Uszkodzona albo nieczytelna migawka to błąd, nie pusta baza.
 */
export function readSnapshot(file: string, key: Buffer | undefined, io: SnapshotIo = {}): { plain: Buffer; encrypted: boolean; source: string } | null {
  const backup = `${file}.bak`;
  const source = existsSync(file) ? file : existsSync(backup) ? backup : null;
  if (!source) return null;
  if (source === backup) io.log?.('Migawka bazy: brak pliku głównego — wczytano kopię zapasową .bak (poprzedni zapis został przerwany).');
  const decoded = decodeSnapshot(readFileSync(source), key);
  if (!decoded.encrypted && key) io.log?.('Migawka bazy nie jest zaszyfrowana — zostanie zaszyfrowana (AES-256-GCM) przy najbliższym zapisie.');
  return { ...decoded, source };
}

/**
 * Zapisuje migawkę bez ryzyka utraty danych: plik tymczasowy → sprawdzenie → `.bak` z poprzedniej
 * → podmiana → ponowne sprawdzenie → usunięcie `.bak`. Przy nieudanym sprawdzeniu poprzednia migawka wraca na miejsce.
 */
export function writeSnapshot(file: string, plain: Buffer, key: Buffer | undefined, io: SnapshotIo = {}): void {
  const expected = sha256(plain);
  const content = key ? encryptSnapshot(plain, key) : plain;
  const temporary = `${file}.tmp`;
  const backup = `${file}.bak`;
  const verify = (path: string) => {
    const read = decodeSnapshot(readFileSync(path), key);
    if (sha256(read.plain) !== expected) throw new SnapshotError(`Sprawdzenie migawki ${path} nie powiodło się (niezgodny skrót SHA-256).`);
  };

  writeFileSync(temporary, content);
  verify(temporary);
  const hadPrevious = existsSync(file);
  const wasEncrypted = hadPrevious && isEncryptedSnapshot(readFileSync(file).subarray(0, MAGIC.length));
  if (hadPrevious) renameSync(file, backup);
  try {
    renameSync(temporary, file);
    verify(file);
  } catch (error) {
    // Przywrócenie poprzedniej migawki — nowa nie przeszła sprawdzenia.
    if (hadPrevious && existsSync(backup)) renameSync(backup, file);
    throw error;
  }
  if (hadPrevious) rmSync(backup, { force: true });
  if (key && hadPrevious && !wasEncrypted) io.log?.('Migawka bazy została zaszyfrowana (AES-256-GCM); poprzednia, niezaszyfrowana wersja została zastąpiona.');
}
