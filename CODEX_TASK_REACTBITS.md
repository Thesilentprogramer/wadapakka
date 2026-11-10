# Add two React Bits components to the React UI in web/ (finish in ~45 min)

Keep the current blue/white/black theme (docs/palette_ref.png), all features, hooks, audio/VAD logic and API calls unchanged.

## 1. GradientASCII (React Bits): hero background
Get the official source (JS + CSS variant, WebGL2, no extra deps) from React Bits: start at https://reactbits.dev/llms.txt and https://reactbits.dev/get-started/index, or the React Bits GitHub repo (DavidHDev/react-bits). Copy it in as web/src/components/reactbits/GradientASCII.(jsx|tsx) + GradientASCII.css (a .jsx file is fine; add a d.ts or allowJs if TS complains).
Use it as the animated full-bleed background of the hero/header (about 420-520 px tall) behind the WadaPakka title, tagline and model badges:
<GradientASCII colors={['#1e3fd8', '#f6f8ff', '#a5d8ff', '#38bdf8']} shape="horizon" characters=" =+xX0S8#@" cellSize={18} density={0.8} glow={0.2} grain={0.08} mouseInteraction clickEffect="wave" intro />
Its props include colors, shape ('horizon'|'pinch'|'rise'|'eclipse'), characters, cellSize, density, glyphOpacity, gradientOpacity, glow, depthOfField, flicker, softness, scale, flow, speed, grain, variation, mouseInteraction, scrambleRadius, clickEffect ('wave'|'burst'|'none'), intro, lightMode, fontFamily, dpr, className and style. It needs a positioned parent with an explicit height. Keep the hero text readable on top (z-index, maybe a subtle white text shadow). Also consider shape="rise" as a subtle glow behind the mic orb in L2. Fall back gracefully if WebGL2 isn't available.

## 2. FolderFloat (React Bits): mode switcher
Get the official FolderFloat source (JS + CSS, dependency matter-js: `npm i matter-js`) from React Bits the same way. Props: items (Array<string|{label,value}>), label, sublabel, trigger ('hover'|'click'), defaultOpen, closeOnSelect, physics, drift, onSelect(value,index), onOpenChange, folderColor, frontColor, paperColor, itemColor, itemTextColor, labelColor, width, height, radius, spread, lift, tilt, flapAngle, restAngle, openDuration, stagger, bounce, className.
Use it as the mode switcher: items = [{label:'L1 · Turn-based', value:'l1'}, {label:'L2 · Live streaming', value:'l2'}, {label:'Eval', value:'eval'}, {label:'Ledger', value:'ledger'}, {label:'Handoff desk', value:'handoff'}]. onSelect switches the active mode or scrolls to the section. label = the current mode name, sublabel = "Switch mode", trigger="click", closeOnSelect, physics, drift={0.5}. Theme it to the palette: folderColor '#1A4FD6', frontColor '#2F6BFF', paperColor '#FFFFFF', itemColor '#FFFFFF', itemTextColor '#0B0B0F', labelColor '#FFFFFF'. Place it prominently (e.g. overlapping the bottom of the hero) with enough room above for the pills to float. Keep a small accessible fallback tab bar (keyboard reachable) so modes are still switchable without the folder.

If the official sources can't be fetched, stop and say so instead of inventing a replacement.

Run `npm run build` in web/ (no TypeScript errors) and `.venv/bin/pytest`. Don't git commit. Never print .env. Print a short summary when done.

## 3. component.gallery as a design reference
Use https://component.gallery/ (a catalogue of UI component patterns from real design systems) as a reference to polish the remaining UI pieces: tabs/segmented control, badges/chips for slot states, the table for the ledger, toasts for confirmations/handoff, an accordion for the timeline, a progress/meter for latency, and empty states. Follow the accessible patterns it documents (ARIA roles, keyboard focus). Do this after parts 1 and 2 and only if time allows.
