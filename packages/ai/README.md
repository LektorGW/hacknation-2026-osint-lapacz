# @olcys/ai — pomocniczy model językowy

Model językowy pełni w narzędziu rolę **wyłącznie wspomagającą**. Czyta publiczną publikację i podpowiada analitykowi,
czyj jest adres, co to za oferta i czy treść wiąże się z Polską. **Nie przyznaje punktów i niczego nie rozstrzyga** —
Wskaźnik Pewności i sygnały monitoringu liczą jawne reguły (`packages/core/src/score.ts`, `apps/api/data/signals.json`),
a odczyt modelu jest do nich dodatkiem, nie zamiennikiem.

**Moduł jest domyślnie wyłączony.** Bez jawnej konfiguracji `createAiAssistant` zwraca `null` i żadna treść nie opuszcza narzędzia.

## Użycie

```ts
import { aiConfigFromEnv, createAiAssistant } from '@olcys/ai';

const assistant = createAiAssistant({ ...aiConfigFromEnv(process.env)!, log }); // null, gdy wyłączony
const insight = await assistant?.analyzePublication({ text, address, author, title }); // TextInsight | null
const summary = await assistant?.summarize(['Adres X opublikowano w 2 źródłach.', '…']); // { text, model, promptVersion } | null
const authors = await assistant?.compareAuthors(postsA, postsB); // { likelihood 5–85, reasons, model, promptVersion } | null
assistant?.usage(); // { tasks, requests, cacheHits, failures, rejected, inputTokens, outputTokens }
```

Każda metoda zwraca `null`, gdy model zawiedzie (sieć, limit czasu, błąd HTTP, odmowa) albo gdy odpowiedź nie przejdzie
weryfikacji. Powód trafia do dziennika (`log`), a analiza idzie dalej bez modelu.

## Jak włączyć

Dostawcę wskazują zmienne środowiskowe (albo obiekt `AiConfig` przekazany wprost):

| Zmienna | Znaczenie |
|---|---|
| `AI_PROVIDER` | `openai-compatible` (także `openai`), `anthropic` albo `none` |
| `AI_BASE_URL` | adres API; wymagany dla `openai-compatible` |
| `AI_API_KEY` | klucz; wymagany dla `anthropic`, zbędny dla serwerów lokalnych |
| `AI_MODEL` | nazwa modelu; **wymagana** dla `openai-compatible`, dla `anthropic` domyślnie `claude-fable-5-2` |
| `AI_TIMEOUT_MS`, `AI_MAX_INPUT_CHARS`, `AI_CONCURRENCY` | limit czasu zadania (30 000), długość treści (6000 znaków), liczba zadań naraz (4) |
| `AI_EFFORT`, `AI_REFUSAL_FALLBACK` | tylko `anthropic`: głębokość rozumowania (`low`), model zastępczy po odmowie (`0` wyłącza) |

Skróty: sam `OPENAI_API_KEY` włącza `openai-compatible` z adresem `https://api.openai.com/v1` (nazwę modelu i tak trzeba podać
w `AI_MODEL`), sam `ANTHROPIC_API_KEY` włącza `anthropic`. Gdy ustawione są oba klucze, a `AI_PROVIDER` nie — moduł zostaje
wyłączony: narzędzie nie zgaduje, dokąd wysłać treść. `AI_PROVIDER=none` wyłącza moduł zawsze. Klucz OpenAI nie jest wysyłany
pod inny adres niż OpenAI.

### Model lokalny — docelowy wariant dla KAS (Ollama z modelem Bielik lub PLLuM)

```bash
ollama pull SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M   # albo model PLLuM dostępny w Ollamie

AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M
```

Tak samo działa każdy serwer z API zgodnym z OpenAI: vLLM (`http://host:8000/v1`), llama.cpp (`http://host:8080/v1`),
wewnętrzny router modeli. Treść nie wychodzi wtedy poza infrastrukturę, a zmiana modelu to zmiana jednej zmiennej.

### OpenAI

```bash
OPENAI_API_KEY=sk-…
AI_MODEL=<nazwa modelu>   # pakiet nie zakłada żadnej nazwy
```

### Anthropic

```bash
ANTHROPIC_API_KEY=sk-ant-…
# AI_MODEL=claude-haiku-5-5   # domyślnie claude-fable-5-2 (najmocniejszy)
```

Do masowej klasyfikacji (cykliczny monitoring źródeł) znacznie tańszy będzie `claude-haiku-5-5`; pośrednie to
`claude-sonnet-5-5` i `claude-opus-5-5`. `claude-fable-5-2` odpowiada wolniej — przy dłuższych treściach warto podnieść `AI_TIMEOUT_MS`.

Próba ręczna po wpisaniu klucza: `node --env-file=.env scripts/try.ts [plik-lub-tekst] [adres]`.

## Co trafia do modelu

| Zadanie | Trafia do modelu | Nigdy nie trafia |
|---|---|---|
| `analyzePublication` | treść **publicznej** publikacji (do `maxInputChars` znaków, wycinek wokół adresu), jej tytuł, nazwa autora podana przez źródło, adres do oceny | nazwa i identyfikator sprawy, identyfikatory podmiotu podane przez analityka, dane analityka, notatki i decyzje, wyniki punktacji, inne publikacje |
| `summarize` | wyłącznie lista faktów przekazana przez wywołującego | wszystko, czego wywołujący nie umieścił na liście |
| `compareAuthors` | dwa zbiory publicznych wypowiedzi (łącznie do `maxInputChars` znaków) | nazwy autorów, adresy profili, informacja, którego podmiotu dotyczy porównanie |
| każde | stałe polecenie z `src/prompts.ts` — bez nazwy instytucji i celu analizy | klucz API (wyłącznie w nagłówku żądania; usuwany z dziennika) |

Uwaga dla wywołującego `summarize`: lista faktów to jedyne miejsce, przez które dane sprawy mogłyby trafić do modelu.
Przy dostawcy zewnętrznym należy przekazywać fakty bez imion, nazwisk i identyfikatorów sprawy — albo używać modelu lokalnego.

`assistant.description` zawiera nazwę modelu, adres usługi i informację, czy działa ona w sieci lokalnej, czy na zewnątrz —
do pokazania analitykowi. Dostawca zewnętrzny wymaga zatwierdzenia przez organizację; pakiet niczego nie wysyła, dopóki
dostawca nie zostanie wskazany w konfiguracji.

## Jak wynik modelu jest weryfikowany

Odpowiedź modelu jest traktowana jak niezaufane dane i sprawdzana zwykłym kodem (`src/verify.ts`):

| Co | Reguła | Skutek naruszenia |
|---|---|---|
| `quote` | musi występować **dosłownie** w treści publikacji (dopuszczalne różnice tylko w białych znakach; co najmniej 12 znaków) | cały odczyt odrzucony (`null`) |
| `ownership` | jedna z pięciu wartości słownika | `unclear` |
| `suggestedCategory` | kategoria z `core`, bez `cryptographic_proof` (dowodu kryptograficznego nie stwierdza się z tekstu) | pole usunięte |
| `offer.side` | wartość ze słownika | `offer` usunięte |
| `offer.amount` | liczba musi dać się odczytać z treści lub tłumaczenia (`150 000`, `150.000`, `150 tys.`, `0,5`) | pole usunięte (wraz z `currency`) |
| `offer.location` | miejscowość musi wystąpić w treści lub tłumaczeniu (z tolerancją na odmianę) | pole usunięte |
| `language` | dwuliterowy kod | `und` |
| `polishNexus.score` | liczba, przycinana do 0–100 | pole usunięte |
| streszczenie | żadnej liczby (kwoty, procentu, roku) ani adresu spoza faktów; najwyżej 160 słów | `null` |
| `compareAuthors` | wynik przycinany do 5–85; zawsze dopisywane zastrzeżenie o słabej wskazówce stylometrycznej | — |

Każdy odczyt zawiera `quote`, `model` (model, który faktycznie odpowiedział) i `promptVersion` (`publication-v1`,
`summary-v1`, `authors-v1`). Zmiana polecenia lub schematu oznacza nową wersję. Wynik jest zapamiętywany pod skrótem
(model + wersja polecenia + wejście), więc ta sama treść daje w obrębie analizy ten sam odczyt, a zapisany odczyt
można sprawdzić z treścią bez ponownego pytania modelu.

**Wstrzykiwanie poleceń.** Treść publikacji jest niezaufana. Trafia do modelu w bloku `<<<DANE id>>> … <<<KONIEC DANE id>>>`,
gdzie `id` to skrót treści (treść nie może zamknąć bloku sama), a polecenie systemowe każe ignorować instrukcje z danych.
Nawet skuteczna manipulacja niewiele daje: model nie ma narzędzi, zwraca tylko obiekt o ustalonym schemacie, cytat musi
pochodzić z treści, a o punktach decydują reguły.

## Dostawcy

Obaj dostawcy stoją za jednym interfejsem `Provider.complete({ system, user, jsonSchema, schemaName, maxTokens, signal })`;
dodanie kolejnego nie zmienia poleceń ani weryfikacji.

- **openai-compatible** — `POST {baseUrl}/chat/completions`. Strukturę wymusza `response_format: json_schema` (tryb ścisły);
  gdy serwer go odrzuci (HTTP 400/422), pakiet przechodzi na `json_object`, a potem na zwykły tekst ze schematem w poleceniu
  i wycinaniem JSON-a z odpowiedzi (znosi otoczkę tekstu, blok kodu, `<think>`). Tak samo dostosowuje `temperature` (domyślnie 0)
  i `max_tokens`/`max_completion_tokens`. Ustalony wariant zostaje na kolejne wywołania.
- **anthropic** — Messages API (`POST /v1/messages`, nagłówki `x-api-key`, `anthropic-version: 2026-10-21`). Strukturę wymusza
  `output_config.format` (schemat JSON); bez `thinking` i bez parametrów próbkowania, bo bieżące modele je odrzucają.
  Dla modeli, które to obsługują, włączony jest serwerowy model zastępczy po odmowie (`fallbacks: "default"`) — odczyt
  wskazuje wtedy w polu `model` model, który faktycznie odpowiedział. Po HTTP 400 jedno ponowienie zwykłym tekstem.
- Oba: jedna ponowna próba po 429/5xx (po czasie z `retry-after`), limit czasu na całe zadanie, ogranicznik współbieżności.

## Ograniczenia

- Modele bywają niedeterministyczne: ta sama treść może przy ponownym pytaniu dać inny odczyt. Odtwarzalność zapewnia
  zapisany odczyt z cytatem, modelem i wersją polecenia oraz to, że punktacja od modelu nie zależy.
- Weryfikacja chroni przed zmyślonym cytatem, kwotą i miejscowością — nie przed błędną interpretacją prawdziwego cytatu.
  `ownership` i `suggestedCategory` to sugestie do oceny przez analityka.
- Kwota i miejscowość mogą być potwierdzone tłumaczeniem, które samo pochodzi z modelu (potrzebne dla treści w innych
  alfabetach). Przy treści obcojęzycznej te dwa pola są więc słabiej chronione niż cytat.
- Sprawdzanie streszczenia obejmuje liczby zapisane cyframi i adresy; liczebniki słowne („dwa adresy”) i same sformułowania
  nie są sprawdzane.
- `translationPl` i przesłanki `polishNexus` to tekst modelu — pomoc w czytaniu, nie dowód.
- Treść dłuższa niż `maxInputChars` jest skracana do wycinka wokół adresu (wpis w dzienniku); model nie widzi reszty.
- Porównanie autorów to słaba wskazówka stylometryczna — nigdy podstawa ustalenia.
- Lokalne modele mogą nie obsługiwać ścisłego schematu; wtedy częściej zdarzy się odpowiedź odrzucona przez weryfikację.
- Dostawcy nie byli sprawdzani na żywo w testach automatycznych (testy używają zapisanych odpowiedzi, bez sieci).
