# Task: real landing page + product redesign for WadaPakka (React app in web/)

The owner says: "I don't want anything mock, I want a good landing page design. Get inspiration and build accordingly." Deadline is tonight, so ship something polished and working within about 40 minutes. Do not commit (git is read-only for you).

## 1. Get inspiration first (network is on)
Look at 4–6 top voice-AI and dev-infra landing pages, e.g. vapi.ai, retellai.com, deepgram.com, elevenlabs.io, gnani.ai, linear.app, vercel.com, resend.com. Also browse 21st.dev, reactbits.dev, component.gallery and opensourceui.in for sections such as hero, logo or model strip, feature grid, bento, how-it-works steps, stats band, CTA and footer. Write down in 5–8 bullets at the top of docs/landing_inspiration.md what you borrowed from each one. Copy the patterns, not their code, brand or copy.

## 2. Build a single scrolling landing page at "/" with the working product inside it
Keep the theme: blue #1A4FD6 / #2F6BFF, white, near-black #0B0B0F. Keep GradientASCII and FolderFloat (both in web/src/components/reactbits/).

Sections, in this order:
1. **Nav**: WadaPakka logo, anchor links (Problem, How it works, Live demo, Results, Architecture), and a "Try live demo" button. It turns sticky with a blur once you scroll.
2. **Hero**: full-width GradientASCII background. Big headline, e.g. "Every promise your voice agent hears, verified before it's written." Subline: "A reliability layer between Gnani Prisma STT and Timbre TTS for Hinglish collection calls." Two CTAs, "Try it live" (jumps to the demo) and "See how it works". Show a "Built on Gnani Prisma v3 · Timbre v2.5" strip.
3. **Problem**: three cards about where voice agents silently fail on PTP calls. Hinglish numbers ("dhai hazaar", "sawa teen sau"), relative dates ("parso", "kal" ambiguity), false barge-in from echo, and duplicate ledger writes. Use real examples from fixtures/eval_cases.json.
4. **How it works**: a 5-step pipeline: Normalize → Verify → Read back (Timbre) → Confirm → Idempotent commit, with a handoff branch. Animate it on scroll with framer-motion.
5. **Live demo**: the existing working product (L1 turn-based, L2 live streaming, Eval, Ledger, Handoff desk), switched with FolderFloat plus the accessible tab fallback. It must keep calling the real backend endpoints. Do not change any call logic.
6. **Results**: use ONLY real measured numbers from docs/eval_results.md and docs/api_notes.md, e.g. final STT about 700 ms after speech ends, first TTS byte about 1.0–1.27 s, scripted barge-in reacting in 266 ms, and live audio 2 of 3 correct (say honestly what missed: "sawa teen sau" heard as 3500). Never invent a number. If a number isn't in those files, leave it out.
7. **Architecture**: a clean SVG or HTML diagram: Caller → Prisma STT (REST and WebSocket stream) → WadaPakka (normalizer, verifier, state machine, idempotent ledger, handoff, observability) → Timbre TTS → Caller.
8. **CTA and footer**: "Built for the Great Indian AI Internship Challenge by Gnani.ai", plus GitHub placeholder href "#" labelled "GitHub" and the author name Shubham Indulkar.

## 3. Remove every mock or placeholder feel
- Delete copy like "Reliability layer lab · Synthetic borrower only", "Demo data and account are fictional", "Waiting for a turn…", "No promises recorded yet." Replace them with useful, product-grade empty states such as "Speak or type a borrower line to start", along with a one-click sample line that fills the input with a real Hinglish phrase.
- The footer note about the API key and ffmpeg moves into a small "Requirements" tooltip or details element.
- Keep borrower names and account IDs fictional (no real PII), but don't label them as "mock" or "synthetic".

## 4. Quality bar
- Responsive at 1440, 1024 and 390 widths, with no horizontal scroll.
- Typography: Inter or Geist, a large tight-tracked headline, generous whitespace and section spacing of 96–128px.
- Subtle motion only, and respect prefers-reduced-motion.
- Code-split matter-js and GradientASCII with React.lazy so the main chunk shrinks.
- Run `cd web && npm run build` (PATH=/opt/homebrew/bin:$PATH) with zero TypeScript errors, and run `.venv/bin/pytest -q` (all must pass).
- If Chrome exists at /Applications/Google Chrome.app, take headless screenshots at 1440x900 (top) and full-page with --virtual-time-budget=4000 to docs/shots/landing_top.png and docs/shots/landing_full.png against a test server on port 8001 (never touch port 8000). Look at them and fix obvious layout problems.
- Finish with a short summary of what changed and anything you couldn't do.
