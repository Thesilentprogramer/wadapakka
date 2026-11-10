# Retheme the React UI (web/) to match docs/palette_ref.png (finish in ~30-40 min)

Look at docs/palette_ref.png (a "Pimvest" banking app mockup; pass it as an image). Replace the current dark theme with that palette and feel. Change colours/visual style only; do NOT change features, hooks, audio/VAD logic or API calls.

Palette (verify against the image and refine):
- Primary royal blue ~#2F6BFF / #1E5EFF (header panel, accents, active states, links); deeper blue ~#1A4FD6 for hover and borders.
- Sky gradient: royal blue to light sky blue (~#8EC5FF) to near-white (~#EAF3FF) for the hero, like the top of the image.
- Page background: soft light blue-grey (~#EEF2F8), with a slate-blue outer frame tint (~#8FA3BF) for any page backdrop.
- Cards: white (#FFFFFF) with very soft shadows and 16-20 px radii; translucent white glass cards (white at 15-25% with backdrop blur and a subtle white border) on top of blue areas, like the VISA cards and action tiles.
- Primary CTA: solid black (#0B0B0F) buttons with white text and full rounded corners; secondary button light lavender-grey (~#E6E9F5) with dark text.
- Text: near-black headings (#0B0B0F), grey body (#6B7280), blue highlight words in headlines (as in "digital banking!").
- Status colours, kept soft: confirmed green (~#16A34A), pending amber (~#F59E0B), interrupted/naive error red (~#EF4444), used sparingly in chips.
- Icons: blue in white rounded-square tiles (like Transfer/Receive/Scan QR).
- Clean geometric sans font (Inter or Plus Jakarta Sans).
Apply to the hero, mode tabs, mic orb (blue gradient with a white glow), level meter, slot cards, naive vs layer split, ledger table (styled like the Transactions list), handoff card, stats bar and timeline. Keep good contrast and readability at 1080p.

Put the colours in Tailwind theme tokens / CSS variables. Run `npm run build` in web/ (no TypeScript errors) and `.venv/bin/pytest`. Don't git commit. Never print .env. Print a short summary when done.
