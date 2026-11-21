// `@olcys/core` (importowany wyłącznie jako typy) używa `node:crypto`, a aplikacja
// przeglądarkowa nie ma typów Node. Ta deklaracja służy tylko sprawdzaniu typów —
// żaden kod z core nie trafia do paczki.
declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
}
