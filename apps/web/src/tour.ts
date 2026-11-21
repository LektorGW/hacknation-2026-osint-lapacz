// Przewodnik pierwszego uruchomienia: dwa rozdziały (pulpit i teczka), każdy pokazywany raz.
// Kroki wskazują elementy atrybutem `data-tour`; brakujący element jest pomijany.
import { TOUR_PREFIX, clearFlags, readFlag, writeFlag } from './ux.ts';

export type TourChapter = 'dashboard' | 'dossier';

export interface TourStep {
  /** Wartość atrybutu `data-tour` elementu, który podświetlamy. */
  target: string;
  title: string;
  text: string;
}

export const TOUR: Record<TourChapter, TourStep[]> = {
  dashboard: [
    {
      target: 'search',
      title: 'Zacznij tutaj',
      text: 'Wpisz jedną znaną daną o osobie: nick, e-mail, imię i nazwisko albo adres krypto. Program poszuka adresów krypto w źródłach publicznych, oceni powiązanie, prześledzi pieniądze w blockchainie, a teczka pokaże, która giełda je przyjęła.',
    },
    {
      target: 'mode',
      title: 'Tryb analizy',
      text: 'Domyślnie tryb głęboki: szeroki przegląd forów i serwisów, zwykle 1–4 minuty. Gdy liczy się czas, wybierz „Szybki” — wynik po kilkunastu sekundach.',
    },
    {
      target: 'cases',
      title: 'Historia spraw',
      text: 'Każde sprawdzenie zostaje zapisane jako sprawa — najnowsze na górze. „Monitoruj” ponawia analizę automatycznie; zmiany pokaże zakładka Monitoring.',
    },
    {
      target: 'help',
      title: 'Pomoc zawsze pod ręką',
      text: 'Tu jest słownik pojęć, skróty klawiaturowe i ten przewodnik. Podkreślone kropkami słowa też można kliknąć — pokażą wyjaśnienie.',
    },
  ],
  dossier: [
    {
      target: 'summary',
      title: 'Odpowiedź w jednym miejscu',
      text: 'Kto to prawdopodobnie jest, ile adresów znaleźliśmy i dokąd trafiły pieniądze. Wszystko inne to szczegóły.',
    },
    {
      target: 'score',
      title: 'Jak mocne jest powiązanie',
      text: 'Pasek i słowo mówią, jak mocne są przesłanki. Przycisk „i” pokazuje, skąd wziął się wynik — krok po kroku.',
    },
    {
      target: 'findings',
      title: 'Fakty, obliczenia, wnioski',
      text: 'Ustalenia są podzielone według pewności. Bursztynowe to wnioski — wymagają Twojego sprawdzenia.',
    },
    {
      target: 'sections',
      title: 'Szczegóły w sekcjach',
      text: 'Osoba, adresy, pieniądze i graf. Każda sekcja zaczyna się od krótkiej odpowiedzi; resztę rozwiniesz jednym kliknięciem.',
    },
    {
      target: 'actions',
      title: 'Co dalej',
      text: 'Te przyciski prowadzą do następnego kroku: potwierdzenia adresu albo zapytania do giełdy. Każdą decyzję można później cofnąć.',
    },
  ],
};

export const tourKey = (chapter: TourChapter) => `${TOUR_PREFIX}${chapter}`;

export const isTourDone = (chapter: TourChapter, storage?: Pick<Storage, 'getItem'>) => readFlag(tourKey(chapter), storage);

export const markTourDone = (chapter: TourChapter, storage?: Pick<Storage, 'setItem' | 'removeItem'>) => writeFlag(tourKey(chapter), true, storage);

/** Ponowne uruchomienie z menu pomocy: oba rozdziały znów są „nowe”. */
export const resetTour = (storage?: Storage) => clearFlags(TOUR_PREFIX, storage);

/** Kroki, których cel istnieje na ekranie — w kolejności rozdziału. */
export function availableSteps(chapter: TourChapter, exists: (target: string) => boolean): TourStep[] {
  return TOUR[chapter].filter((step) => exists(step.target));
}

/** Zdarzenie: uruchom przewodnik dla bieżącego ekranu (od nowa). */
export const TOUR_EVENT = 'olcys:przewodnik';
