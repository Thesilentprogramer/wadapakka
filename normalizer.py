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
    "dhai": 2.5, "dhayi": 2.5, "adhai": 2.5, "ढाई": 2.5, "दाई": 2.5,
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
    text = re.sub(r"(?<!\d),(?!\d)|₹", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_amount_inr(text: str) -> tuple[float | None, str]:
    """Return (amount, note). None if we cannot parse a single amount."""
    raw = _fold(text)
    # In a partial-payment utterance the amount following "only" is the
    # offered payment; the outstanding balance is context, not a promise.
    partial = re.search(r"\b(?:only|sirf|bas)\s+(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)\b", text, re.I)
    if partial:
        return float(partial.group(1).replace(",", "")), "partial_payment"
    raw = re.sub(r"\b\d{4}-\d{1,2}-\d{1,2}\b", " ", raw)
    raw = re.sub(r"\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b", " ", raw)
    raw = re.sub(r"\b\d{10}\b", " ", raw)
    # Find a contiguous number phrase. Unrelated dates, phone numbers and words
    # elsewhere in the turn must not be added to the promised amount.
    words = re.findall(r"[a-zA-Z\u0900-\u097F]+|\d[\d,]*(?:\.\d+)?", raw)
    number_words = {**ONES, **FRACTIONS, **SCALES, "and": 0, "aur": 0}
    candidates = []
    run = []
    for word in words + ["END"]:
        if word in number_words or re.fullmatch(r"\d[\d,]*(?:\.\d+)?", word):
            run.append(word)
        elif run:
            candidates.append(run)
            run = []
    if not candidates:
        return None, "no_amount_found"
    # Prefer a scaled phrase; otherwise the first plausible numeric span.
    phrase = next((c for c in candidates if any(w in SCALES for w in c)), candidates[0])
    if any(w in FRACTIONS for w in phrase):
        frac = next(FRACTIONS[w] for w in phrase if w in FRACTIONS)
        scale = next((SCALES[w] for w in phrase if w in SCALES), 1)
        if any(w in {"sawa", "sava", "सवा"} for w in phrase):
            base = next((float(w.replace(',', '')) if w.replace(',', '').replace('.', '', 1).isdigit() else ONES[w] for w in phrase if w in ONES or w.replace(',', '').replace('.', '', 1).isdigit()), 1)
            value = (base + .25) * scale
        else:
            value = frac * scale
    else:
        value = 0.0
        current = 0.0
        for word in phrase:
            if word in SCALES:
                current = (current or 1) * SCALES[word]
                value += current
                current = 0
            elif word.replace(',', '').replace('.', '', 1).isdigit():
                current += float(word.replace(',', ''))
            else:
                current += ONES.get(word, 0)
        value += current
    if value <= 0 or value > 10_000_000:
        return None, "implausible_amount"
    return float(value), "spoken_form" if any(w in number_words for w in phrase) else "digit_span"


def parse_relative_date(text: str, today: date | None = None) -> tuple[date | None, str]:
    today = today or date.today()
    raw = _fold(text)
    m = re.search(r"\b(20\d{2})-(\d{1,2})-(\d{1,2})\b", raw)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))), "iso_date"
        except ValueError:
            return None, "invalid_numeric_date"
    month_names = {"november": 11, "nov": 11, "नवंबर": 11, "नवम्बर": 11}
    m = re.search(r"\b(\d{1,2}|pandrah|solah|पंद्रह|सोलह)\s+(november|nov|नवंबर|नवम्बर)\b", raw)
    if m:
        day = ONES.get(m.group(1), None)
        if day is None:
            day = int(m.group(1))
        try:
            return date(today.year, month_names[m.group(2)], day), "month_name"
        except ValueError:
            return None, "invalid_numeric_date"
    if re.search(r"\bparso\b|परसों|परसो", raw):
        return today + timedelta(days=2), "parso"
    if re.search(r"\baaj\b|आज|\btoday\b", raw):
        return today, "aaj"
    if re.search(r"\bkal\b|कल", raw):
        return None, "kal_ambiguous"
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
    if re.search(r"\bcash\b|\bnagad\b|\bनकद\b|कैश", raw):
        return "CASH", "cash"
    if re.search(r"\bneft\b|\bimps\b|\brtgs\b|\bbank\b|\btransfer\b|बैंक|ट्रांसफर", raw):
        return "BANK", "bank"
    return None, "no_mode_found"
