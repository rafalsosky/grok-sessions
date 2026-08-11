#!/usr/bin/env python3
"""Zamazuje stopkę z danymi konta na zrzucie ekranu aplikacji.

Lepszą drogą jest tryb prywatności w samej aplikacji (⌘⇧P przed zrzutem) —
wtedy nie ma czego zamazywać. Ten skrypt jest dla zrzutów już zrobionych.

    python3 scripts/zamaz-konto.py zrzut.png              # zamaż i zapisz obok
    python3 scripts/zamaz-konto.py zrzut.png --podglad    # tylko pokaż ramkę
    python3 scripts/zamaz-konto.py zrzut.png --w-miejscu  # nadpisz oryginał

Domyślnie celuje w stopkę lewego panelu (imię + e-mail). Obszar liczony
proporcjonalnie, więc działa dla Retiny i zwykłego ekranu. Można podać
własny prostokąt: --obszar x,y,szer,wys (w pikselach obrazu).
"""

import sys
from pathlib import Path

try:
    from PIL import Image, ImageFilter, ImageDraw
except ImportError:
    sys.exit("Brak Pillow. Zainstaluj: pip3 install Pillow")

# Stopka konta w układzie aplikacji: lewy panel ma 272 px CSS przy oknie
# 1280 px, a sama stopka ok. 56 px wysokości na samym dole.
RAIL_UDZIAL = 272 / 1280
STOPKA_WYS_CSS = 56
OKNO_WYS_CSS = 820


def obszar_stopki(szer, wys):
    skala = wys / OKNO_WYS_CSS
    h = int(STOPKA_WYS_CSS * skala)
    w = int(szer * RAIL_UDZIAL)
    # avatar zostawiamy, zamazujemy tekst obok niego
    x = int(w * 0.16)
    return (x, wys - h, w - x, h)


def zamaz(sciezka, obszar=None, podglad=False, w_miejscu=False):
    im = Image.open(sciezka).convert("RGB")
    szer, wys = im.size
    x, y, w, h = obszar or obszar_stopki(szer, wys)
    x, y = max(0, x), max(0, y)
    w, h = min(w, szer - x), min(h, wys - y)
    if w <= 0 or h <= 0:
        sys.exit("Pusty obszar — sprawdź --obszar")

    if podglad:
        rys = ImageDraw.Draw(im)
        rys.rectangle([x, y, x + w, y + h], outline=(255, 60, 60), width=3)
        cel = Path(sciezka).with_name(Path(sciezka).stem + "-podglad.png")
        im.save(cel)
        print(f"Podgląd ramki: {cel}")
        print("Pasuje? Uruchom bez --podglad. Nie pasuje? Użyj --obszar x,y,szer,wys")
        return

    wycinek = im.crop((x, y, x + w, y + h))
    # pikseloza + rozmycie: nieodwracalne, w przeciwieństwie do samego blura
    maly = wycinek.resize((max(1, w // 22), max(1, h // 10)), Image.BILINEAR)
    wycinek = maly.resize((w, h), Image.NEAREST).filter(ImageFilter.GaussianBlur(4))
    im.paste(wycinek, (x, y))

    cel = Path(sciezka) if w_miejscu else Path(sciezka).with_name(
        Path(sciezka).stem + "-bez-danych.png"
    )
    im.save(cel)
    print(f"Zapisane: {cel}")
    print("Sprawdź wzrokiem, czy nic nie zostało widoczne.")


def main():
    args = [a for a in sys.argv[1:]]
    if not args or args[0] in ("-h", "--help"):
        sys.exit(__doc__)
    plik = args[0]
    if not Path(plik).exists():
        sys.exit(f"Nie ma pliku: {plik}")
    obszar = None
    if "--obszar" in args:
        wartosc = args[args.index("--obszar") + 1]
        obszar = tuple(int(v) for v in wartosc.split(","))
        if len(obszar) != 4:
            sys.exit("--obszar wymaga czterech liczb: x,y,szer,wys")
    zamaz(
        plik,
        obszar=obszar,
        podglad="--podglad" in args,
        w_miejscu="--w-miejscu" in args,
    )


if __name__ == "__main__":
    main()
