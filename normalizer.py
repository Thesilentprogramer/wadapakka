"""Indic / Hinglish number and date normalisation.

This is application logic, not a Gnani API. Prisma v2.5 ITN (format=transcribe)
covers some spoken numbers and dates; Prisma v3.0 writes numbers itself when
format=transcribe. Relative words such as parso or agle somvaar still need
this layer, and dual-pass comparison uses both spoken-form and written-form.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

ONES = {
    "zero": 0, "sunya": 0, "shunya": 0, "शून्य": 0,
    "ek": 1, "एक": 1, "one": 1,
    "do": 2, "दो": 2, "two": 2,
    "teen": 3, "tin": 3, "तीन": 3, "three": 3,
    "char": 4, "chaar": 4, "चार": 4, "four": 4,
    "paanch": 5, "panch": 5, "पांच": 5, "पाँच": 5, "five": 5,
    "chhe": 6, "che": 6, "छह": 6, "six": 6,
    "saat": 7, "sat": 7, "सात": 7, "seven": 7,
    "aath": 8, "ath": 8, "आठ": 8, "eight": 8,
    "nau": 9, "नो": 9, "नौ": 9, "nine": 9,
    "das": 10, "दस": 10, "ten": 10,
    "gyarah": 11, "ग्यारह": 11, "eleven": 11,
    "barah": 12, "बारह": 12, "twelve": 12,
    "terah": 13, "तेरह": 13, "thirteen": 13,
    "chaudah": 14, "चौदह": 14, "fourteen": 14,
    "pandrah": 15, "पंद्रह": 15, "fifteen": 15,
    "solah": 16, "सोलह": 16, "sixteen": 16,
    "satrah": 17, "सत्रह": 17, "seventeen": 17,
    "atharah": 18, "अठारह": 18, "eighteen": 18,
    "unnees": 19, "उन्नीस": 19, "nineteen": 19,
    "bees": 20, "बीस": 20, "twenty": 20,
    "pachees": 25, "pachchees": 25, "pachis": 25, "पच्चीस": 25,
    "tees": 30, "तीस": 30, "thirty": 30,
    "chalees": 40, "चालीस": 40, "forty": 40,
    "pachaas": 50, "पचास": 50, "fifty": 50,
}

FRACTIONS = {
    "sawa": 1.25, "sava": 1.25, "सवा": 1.25,
    "dedh": 1.5, "डेढ़": 1.5, "डेढ": 1.5,
    "dhai": 2.5, "dhayi": 2.5, "adhai": 2.5, "ढाई": 2.5,
}

SCALES = {
    "sau": 100, "so": 100, "सौ": 100, "hundred": 100,
    "hazaar": 1000, "hazar": 1000, "hazar": 1000, "हजार": 1000,
    "thousand": 1000,
    "lakh": 100000, "lac": 100000, "लाख": 100000,
    "crore": 10000000, "करोड़": 10000000, "करोड": 10000000,
}

WEEKDAYS = {
    "somvaar": 0, "somvar": 0, "monday": 0, "सोमवार": 0,
    "mangalvaar": 1, "tuesday": 1, "मंगलवार": 1,
    "budhvaar": 2, "wednesday": 2, "बुधवार": 2,
    "guruvaar": 3, "thursday": 3, "गुरुवार": 3,
    "shukravaar": 4, "friday": 4, "शुक्रवार": 4,
    "shanivaar": 5, "saturday": 5, "शनिवार": 5,
    "ravivaar": 6, "sunday": 6, "रविवार": 6,
}


def _fold(text: str) -> str:
    text = text.lower().replace("hazār", "hazaar").replace("हज़ार", "हजार")
    text = re.sub(r"[,₹]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_amount_inr(text: str) -> tuple[float | None, str]:
    """Return (amount, note). None if we cannot parse a single amount."""
    raw = _fold(text)
    # Digits already present (ITN or typed).
    digit = re.search(r"(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?", raw)
    spoken_scale = any(k in raw for k in FRACTIONS) or any(
        k in raw for k in ("hazaar", "hazar", "हजार", "lakh", "lac", "लाख", "crore", "sau", "सौ")
    )

    total = 0.0
    matched = False
    for name, value in FRACTIONS.items():
        if re.search(rf"\b{name}\b", raw):
            scale = 1
            for sname, sval in SCALES.items():
                if re.search(rf"\b{sname}\b", raw):
                    scale = max(scale, sval)
            total = value * scale
            matched = True
            break
    if not matched:
        tokens = re.findall(r"[a-zA-Z\u0900-\u097F]+|\d+", raw)
        acc = 0.0
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            if tok.isdigit():
                acc += float(tok)
                matched = True
            elif tok in ONES:
                acc += ONES[tok]
                matched = True
            elif tok in SCALES:
                if acc == 0:
                    acc = 1
                acc *= SCALES[tok]
                total += acc
                acc = 0
                matched = True
            i += 1
        total += acc

    if not matched and not digit:
        return None, "no_amount_found"
    if digit and not spoken_scale:
        whole = digit.group(0).replace(",", "")
        try:
            return float(whole), "digit_span"
        except ValueError:
            return None, "bad_digit_span"
    if matched:
        return float(total), "spoken_form"
    return None, "unparsed"


def parse_relative_date(text: str, today: date | None = None) -> tuple[date | None, str]:
    today = today or date.today()
    raw = _fold(text)
    if re.search(r"\bparso\b|\bपरसों\b|\bपरसो\b", raw):
        return today + timedelta(days=2), "parso"
    if re.search(r"\baaj\b|\bआज\b|\btoday\b", raw):
        return today, "aaj"
    if re.search(r"\bkal\b|\bकल\b", raw):
        # Kal is ambiguous (yesterday or tomorrow). Force confirmation.
        return today + timedelta(days=1), "kal_ambiguous"
    m = re.search(r"\b(agle|agla|next|अगले|अगला)\s+([a-z\u0900-\u097F]+)", raw)
    if m:
        day = WEEKDAYS.get(m.group(2))
        if day is not None:
            delta = (day - today.weekday()) % 7
            if delta == 0:
                delta = 7
            return today + timedelta(days=delta), "next_weekday"
    # ISO or numeric date
    m = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", raw)
    if m:
        dd, mm, yy = int(m.group(1)), int(m.group(2)), m.group(3)
        year = int(yy) if yy else today.year
        if year < 100:
            year += 2000
        try:
            return date(year, mm, dd), "numeric_date"
        except ValueError:
            return None, "invalid_numeric_date"
    return None, "no_date_found"


def parse_mode(text: str) -> tuple[str | None, str]:
    raw = _fold(text)
    if re.search(r"\bupi\b|\byu.?p.?i\b|\byupi\b", raw):
        return "UPI", "upi"
    if re.search(r"\bcash\b|\bnagad\b|\bनकद\b", raw):
        return "CASH", "cash"
    if re.search(r"\bneft\b|\bimps\b|\brtgs\b|\bbank\b|\btransfer\b", raw):
        return "BANK", "bank"
    return None, "no_mode_found"
