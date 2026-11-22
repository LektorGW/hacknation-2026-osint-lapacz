// Minimalny odczyt XML bez zależności: elementy wybierane po nazwie lokalnej (bez prefiksu przestrzeni nazw).
// Wystarcza do odpowiedzi SOAP usług rejestrów (stała, płaska struktura) — nie jest ogólnym parserem XML.

const NAME = /^[A-Za-z_][\w.-]*$/;

/** Dekoduje encje XML (&amp;, &lt;, &#261; …) w treści elementu. */
export function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const pattern = (localName: string): RegExp => {
  if (!NAME.test(localName)) throw new Error(`niepoprawna nazwa elementu: ${localName}`);
  // `(?![\w.-])` — „Nazwa” nie dopasuje „NazwaRejestru”; elementy puste (`<x:Nazwa/>`) dają pustą treść.
  return new RegExp(`<(?:[\\w.-]+:)?${localName}(?![\\w.-])[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}\\s*>)`, 'g');
};

/** Treści (surowe, z elementami podrzędnymi) wszystkich elementów o danej nazwie lokalnej. */
export function xmlBlocks(xml: string, localName: string): string[] {
  return [...xml.matchAll(pattern(localName))].map((match) => match[1] ?? '');
}

/** Tekst pierwszego elementu o danej nazwie lokalnej (zdekodowany, przycięty) albo `undefined`. */
export function xmlText(xml: string, localName: string): string | undefined {
  const block = xmlBlocks(xml, localName)[0];
  if (block === undefined || /<[A-Za-z]/.test(block)) return undefined;
  const value = decodeXml(block).trim();
  return value || undefined;
}

/** Usuwa z fragmentu elementy o podanych nazwach (np. listy zagnieżdżone przed odczytem pól nadrzędnych). */
export function withoutBlocks(xml: string, ...localNames: string[]): string {
  return localNames.reduce((rest, name) => rest.replace(pattern(name), ''), xml);
}
