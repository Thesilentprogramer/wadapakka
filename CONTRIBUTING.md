# Contributing to WadaPakka

Thanks for helping improve the reliability layer. Please keep changes small, tested, and free of secrets or real borrower data.

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e ".[dev]"
cd web && npm ci && npm run build && cd ..
cp .env.example .env
```

Add `GNANI_API_KEY` to `.env` only if you need live Prisma STT or Timbre TTS. Text fixtures, typed turns, and the SDK quickstart run without a key.

## Tests

```sh
.venv/bin/pytest -q
cd web && npm run build
```

Please add or update tests for parser, confirmation, ledger, and handoff changes. Do not weaken an existing assertion to make a change pass.

## Branch and pull requests

1. Create a branch from `main` (`fix/...`, `feat/...`, or `docs/...`).
2. Keep the pull request focused on one change.
3. Describe what you changed and how you tested it.
4. Do not include `.env`, API keys, credentials, or generated secrets.

## Code style

- Python 3.10+, match the existing naming and module layout.
- Keep SDK behavior in `wadapakka/` aligned with the demo engine in `app.py` — do not fork the Hinglish rules.
- Prefer clear names over comments. Leave comments only where the rule is subtle.
- Do not commit `__pycache__/`, `.venv/`, `web/node_modules/`, or build artifacts.

## Synthetic data only

This project is a demo for collection-call reliability. Use only synthetic or fictional borrower data.

Do not add, commit, or paste:

- real phone numbers
- Aadhaar or PAN numbers
- real names, account numbers, or addresses of actual borrowers
- recordings of real collection calls

Fixture transcripts, personas, and screenshots must stay fictional.

## Secrets

Never commit `.env`, API keys, tokens, or webhook secrets. `.env` is gitignored; keep it that way. If a secret is committed by mistake, rotate it and remove it from git history.
