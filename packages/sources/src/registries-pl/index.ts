// Polskie rejestry publiczne (druga fala): CRBR (beneficjenci rzeczywiści) i orzeczenia sądów (SAOS).
// Werdykty dla pozostałych kandydatów (MSiG, KRZ, CBOSA, Portal Orzeczeń bez API, REGON BIR1) — w
// docs/ZRODLA-PODSTAWA-PRAWNA.md, sekcja 3. Te moduły nie mają zależności poza @olcys/core.

export {
  beneficialOwnerLine,
  createCrbrConnector,
  crbrDocument,
  crbrQueryOf,
  crbrRequestXml,
  parseCrbrResponse,
  queryCrbr,
  CRBR_DAILY_LIMIT,
  CRBR_ENDPOINT,
  CRBR_ID,
  CRBR_LABEL,
  CRBR_ROLE,
  CRBR_SEARCH_PAGE,
  CRBR_SERVICE,
} from './crbr.ts';
export type { CrbrBeneficialOwner, CrbrCompany, CrbrConnectorOptions, CrbrFetch, CrbrLookup, CrbrOptions, CrbrQuery } from './crbr.ts';
export { courtDecisionLabel, parseSaosSearch, saosPhraseFor, saosSearchUrl, searchCourtDecisions, SAOS_SEARCH_API, SAOS_SERVICE, SAOS_TERMS } from './saos.ts';
export type { CourtDecision, SaosOptions } from './saos.ts';

/** Czy operator wyłączył zapytania do CRBR (zmienna CRBR_DISABLE=1). */
export const crbrDisabled = (env: Record<string, string | undefined> = process.env): boolean => /^(1|true|tak)$/i.test(env.CRBR_DISABLE?.trim() ?? '');
/** Czy operator wyłączył zapytania do SAOS (zmienna SAOS_DISABLE=1). */
export const saosDisabled = (env: Record<string, string | undefined> = process.env): boolean => /^(1|true|tak)$/i.test(env.SAOS_DISABLE?.trim() ?? '');
