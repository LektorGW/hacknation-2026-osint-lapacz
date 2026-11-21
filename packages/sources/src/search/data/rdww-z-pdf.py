# Jednorazowa konwersja opublikowanego pliku PDF „Rejestr działalności w zakresie walut
# wirtualnych" (Izba Administracji Skarbowej w Katowicach, gov.pl/web/ias-katowice) do
# migawki JSON używanej przez łącznik `rejestry-publiczne`. Wymaga pakietu pymupdf —
# tylko do odświeżenia migawki, samo narzędzie go nie potrzebuje.
#
#   python rdww-z-pdf.py <plik.pdf> <adres pobrania> <stan na RRRR-MM-DD> > rdww.json

import json
import re
import sys

import pymupdf

ENTRY = re.compile(r"^RDWW-\d+$")
DATE = re.compile(r"^\d{1,2}\.\d{2}\.\d{4}$")
DIGITS10 = re.compile(r"^\d{10}$")
SKIP = (
    "WERSJA ARCHIWALNA",
    "Wpis do Rejestru",
    "jak również do działalności",
    "mogą być świadczone",
    "The entry in the Register",
    "does not grant the authorization",
    "Within the EU",
    "Rejestr działalności w zakresie walut wirtualnych",
)
HEADER = {
    "Numer", "w rejestrze", "Data wpisu", "Imię i Nazwisko / Nazwa firmy", "Numer KRS", "NIP",
    "Rodzaj świadczonych usług", "Informacja o", "zawieszeniu", "zakończeniu", "działalności",
}
SERVICES = [
    ("wymiana_na_srodki_platnicze", "walutami wirtualnymi i środkami płatniczymi"),
    ("wymiana_miedzy_walutami", "walutami wirtualnymi(?! i środkami)"),
    ("posrednictwo", "pośrednictwo w wymianie"),
    ("prowadzenie_rachunkow", "prowadzenie rachunków"),
]


def lines_of(path):
    for page in pymupdf.open(path):
        for raw in page.get_text("text").splitlines():
            line = raw.strip()
            if not line or line in HEADER or any(line.startswith(prefix) for prefix in SKIP):
                continue
            yield line


def parse(path):
    entries = []
    current = None
    for line in lines_of(path):
        if ENTRY.match(line):
            current = {"numer": line, "lines": []}
            entries.append(current)
        elif current is not None:
            current["lines"].append(line)
    result = []
    for entry in entries:
        lines = entry["lines"]
        if not lines or not DATE.match(lines[0]):
            continue
        day, month, year = lines[0].split(".")
        name_parts = []
        index = 1
        while index < len(lines) and not DIGITS10.match(lines[index]) and not lines[index].startswith("wymiana") and not lines[index].startswith("pośrednictwo") and not lines[index].startswith("prowadzenie"):
            name_parts.append(lines[index])
            index += 1
        numbers = []
        while index < len(lines) and DIGITS10.match(lines[index]) and len(numbers) < 2:
            numbers.append(lines[index])
            index += 1
        rest = " ".join(lines[index:])
        services = [key for key, pattern in SERVICES if re.search(pattern, rest)]
        # Osoby fizyczne mają w kolumnie KRS znak „---".
        name = re.sub(r"\s+", " ", " ".join(part for part in name_parts if part != "---")).strip()
        # Na granicy stron PDF końcówka formy prawnej trafia poza wpis; jedyne możliwe dokończenie dopisujemy.
        if name.endswith("SPÓŁKA Z OGRANICZONĄ"):
            name += " ODPOWIEDZIALNOŚCIĄ"
        elif name.endswith("SPÓŁKA Z"):
            name += " OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ"
        if not name or not numbers:
            continue
        record = {
            "numer": entry["numer"],
            "dataWpisu": f"{year}-{month}-{int(day):02d}",
            "nazwa": name,
            "nip": numbers[-1],
        }
        if len(numbers) == 2:
            record["krs"] = numbers[0]
        if services:
            record["uslugi"] = services
        if "wykreślony" in rest:
            record["wykreslony"] = True
        suspended = re.search(r"zawiesz\w*[^-]*?(\d{1,2}\.\d{2}\.\d{4})", rest)
        if suspended:
            record["zawieszenie"] = suspended.group(1)
        result.append(record)
    return result


if __name__ == "__main__":
    pdf, url, as_of = sys.argv[1], sys.argv[2], sys.argv[3]
    records = parse(pdf)
    json.dump(
        {
            "zrodlo": "Rejestr działalności w zakresie walut wirtualnych — Dyrektor Izby Administracji Skarbowej w Katowicach",
            "strona": "https://www.gov.pl/web/ias-katowice/rejestr-dzialalnosci-w-zakresie-walut-wirtualnych",
            "plik": url,
            "stanNa": as_of,
            "wpisy": records,
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )
