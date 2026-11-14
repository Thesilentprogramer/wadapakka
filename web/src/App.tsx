import { lazy, Suspense, useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowDown, ArrowRight, AudioLines, CalendarDays, Check, IndianRupee, Mic2, ShieldCheck } from 'lucide-react'
import TurnPanel from './components/TurnPanel'
import LivePanel from './components/LivePanel'

const GradientASCII = lazy(() => import('./components/reactbits/GradientASCII'))
const FolderFloat = lazy(() => import('./components/reactbits/FolderFloat'))
type Destination = 'l1' | 'l2' | 'eval' | 'ledger' | 'handoff'
const destinations: { label: string; value: Destination }[] = [
  { label: 'L1 · Turn-based', value: 'l1' }, { label: 'L2 · Live streaming', value: 'l2' },
  { label: 'Eval', value: 'eval' }, { label: 'Ledger', value: 'ledger' }, { label: 'Handoff desk', value: 'handoff' },
]
const steps = [
  ['Normalize', 'Resolve Hinglish amounts, dates and payment methods from the transcript.'],
  ['Verify', 'Check that critical details are complete and unambiguous.'],
  ['Read back', 'Timbre speaks the amount, date and method back to the caller.'],
  ['Confirm', 'The borrower accepts or corrects the exact promise.'],
  ['Commit once', 'An idempotency key protects the ledger from repeat writes.'],
]

export function App() {
  const [mode, setMode] = useState<'turn' | 'live'>('turn')
  const [destination, setDestination] = useState<Destination>('l1')
  const [scrolled, setScrolled] = useState(false)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  function navigate(value: Destination) {
    setDestination(value)
    setMode(value === 'l2' ? 'live' : 'turn')
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = value === 'l1' ? 'turn-panel' : value === 'l2' ? 'live-panel' : value === 'eval' ? 'fixture-evaluation-title' : value === 'ledger' ? 'promise-ledger-title' : 'handoff-desk'
      document.getElementById(target)?.scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'start' })
    }))
  }
  return <main className="site-shell">
    <header className={`site-nav ${scrolled ? 'site-nav--scrolled' : ''}`}><div className="nav-inner">
      <a className="brand" href="#top" aria-label="WadaPakka home"><span className="brand-mark"><Check size={18} strokeWidth={3}/></span>WadaPakka<span className="brand-period">.</span></a>
      <nav className="nav-links" aria-label="Page sections"><a href="#problem">Problem</a><a href="#how-it-works">How it works</a><a href="#demo">Live demo</a><a href="#results">Results</a><a href="#architecture">Architecture</a></nav>
      <a className="nav-cta" href="#demo">Try live demo <ArrowRight size={15}/></a>
    </div></header>

    <section className="landing-hero" id="top" aria-labelledby="hero-title">
      <Suspense fallback={<div className="hero-ascii-fallback" aria-hidden="true"/>}><GradientASCII className="landing-ascii" colors={['#0a1844', '#1A4FD6', '#2F6BFF', '#82b8ff']} shape="horizon" characters=" =+xX0S8#@" cellSize={18} density={0.8} glow={0.2} grain={0.08} mouseInteraction clickEffect="wave" intro /></Suspense>
      <div className="hero-shade"/><div className="hero-inner"><div className="hero-copy-wrap">
        <p className="hero-overline"><span className="live-dot"/> THE RELIABILITY LAYER FOR VOICE AI</p>
        <h1 id="hero-title">Every promise your voice agent hears, <em>verified</em> before it's written.</h1>
        <p className="hero-description">A reliability layer between Gnani Prisma STT and Timbre TTS for Hinglish collection calls. Hear the promise. Read it back. Commit only after confirmation.</p>
        <div className="hero-actions"><a className="hero-button hero-button-primary" href="#demo">Try it live <ArrowRight size={18}/></a><a className="hero-button hero-button-secondary" href="#how-it-works">See how it works <ArrowDown size={17}/></a></div>
      </div><div className="hero-proof" aria-label="Underlying Gnani models"><span>BUILT ON GNANI</span><strong>Prisma v3.0</strong><span className="proof-divider"/><strong>Timbre v2.5</strong></div></div>
    </section>

    <section className="landing-section problem-section" id="problem" aria-labelledby="problem-title">
      <div className="section-heading"><p className="section-index">THE PROBLEM</p><h2 id="problem-title">A small misunderstanding.<br/><span>A very real ledger entry.</span></h2><p>Collection calls mix languages, shorthand and interruptions. A transcript alone is not a confirmed promise to pay.</p></div>
      <div className="problem-grid">
        <article className="problem-card"><span className="problem-glyph"><IndianRupee size={28}/></span><div><p className="example-line">“sawa teen sau” <ArrowRight size={14}/> <strong>₹3,500</strong></p><h3>Numbers change meaning</h3><p>In live audio, Prisma heard ₹3,500 where the spoken amount was ₹325. The read back gives the borrower a chance to catch it.</p></div></article>
        <article className="problem-card"><span className="problem-glyph"><CalendarDays size={28}/></span><div><p className="example-line">“kal” <ArrowRight size={14}/> <strong>Which day?</strong></p><h3>Dates need a second look</h3><p>“Kal” can point to yesterday or tomorrow. The fixture uses “parso” to show why an exact payment date matters.</p></div></article>
        <article className="problem-card"><span className="problem-glyph"><AudioLines size={28}/></span><div><p className="example-line">Echo / retry <ArrowRight size={14}/> <strong>False action</strong></p><h3>Audio and retries compound errors</h3><p>Echo can interrupt the agent. Repeated confirmations can write twice. Barge-in handling and an idempotent commit guard both paths.</p></div></article>
      </div>
    </section>

    <section className="landing-section process-section" id="how-it-works" aria-labelledby="process-title">
      <div className="section-heading"><p className="section-index">HOW IT WORKS</p><h2 id="process-title">Five checks between<br/>speech and a write.</h2><p>Each stage makes the next one safer. If the borrower refuses or the conversation needs help, the call moves to a human handoff.</p></div>
      <div className="process-rail">{steps.map(([title, detail], index) => <motion.article className="process-step" key={title} initial={reduceMotion ? false : { opacity: .45, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .42, delay: index * .08, ease: [0.16, 1, 0.3, 1] }}><span className="step-number">0{index + 1}</span><span className="step-line"/><h3>{title}</h3><p>{detail}</p></motion.article>)}</div>
      <div className="handoff-branch"><span>WHEN AUTOMATION SHOULD STOP</span><strong>Human handoff <ArrowRight size={17}/></strong><p>A concise brief carries the context forward.</p></div>
    </section>

    <section className="demo-section" id="demo" aria-labelledby="demo-title"><div className="demo-inner">
      <div className="demo-intro"><div><p className="section-index">LIVE PRODUCT</p><h2 id="demo-title">Put a promise through the pipeline.</h2><p>Speak into the live call or type a Hinglish borrower line. Compare the immediate write with the verified path, then inspect the ledger and handoff.</p></div><div className="demo-folder" aria-label="Demo destination switcher"><Suspense fallback={<span>Choose a demo view below</span>}><FolderFloat items={destinations} label={destinations.find(item => item.value === destination)?.label ?? 'L1 · Turn-based'} sublabel="Switch view" trigger="click" closeOnSelect physics drift={0.5} onSelect={value => navigate(value as Destination)} folderColor="#1A4FD6" frontColor="#2F6BFF" paperColor="#FFFFFF" itemColor="#FFFFFF" itemTextColor="#0B0B0F" labelColor="#FFFFFF" width={190} height={122} spread={135}/></Suspense></div></div>
      <nav className="mode-nav" aria-label="Demo navigation"><div className="mode-tabs" role="tablist" aria-label="Call mode" onKeyDown={event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'l1' : event.key === 'End' ? 'l2' : mode === 'turn' ? 'l2' : 'l1'; navigate(next); document.getElementById(`tab-${next}`)?.focus() }}><button id="tab-l1" type="button" role="tab" aria-controls="turn-panel" aria-selected={mode === 'turn'} tabIndex={mode === 'turn' ? 0 : -1} className={`mode-link ${mode === 'turn' ? 'active' : ''}`} onClick={() => navigate('l1')}><Mic2 size={15}/>L1 · Turn-based</button><button id="tab-l2" type="button" role="tab" aria-controls="live-panel" aria-selected={mode === 'live'} tabIndex={mode === 'live' ? 0 : -1} className={`mode-link ${mode === 'live' ? 'active' : ''}`} onClick={() => navigate('l2')}><AudioLines size={15}/>L2 · Live streaming</button></div><div className="mode-sections">{destinations.slice(2).map(item => <button key={item.value} type="button" className={`mode-link ${destination === item.value ? 'section-active' : ''}`} aria-current={destination === item.value ? 'location' : undefined} onClick={() => navigate(item.value)}>{item.label}</button>)}</div></nav>
      <div id="turn-panel" hidden={mode !== 'turn'} role="tabpanel" aria-labelledby="tab-l1" tabIndex={0}><TurnPanel active={mode === 'turn'}/></div><div id="live-panel" hidden={mode !== 'live'} role="tabpanel" aria-labelledby="tab-l2" tabIndex={0}><LivePanel active={mode === 'live'}/></div>
      <details className="requirements"><summary>Demo requirements</summary><p>Microphone access and a server-side Gnani API key are needed for audio. L1 WebM clips also need ffmpeg on the server. Typed turns and evaluation use the same backend endpoints.</p></details>
    </div></section>

    <section className="landing-section results-section" id="results" aria-labelledby="results-title"><div className="section-heading"><p className="section-index">MEASURED RESULTS</p><h2 id="results-title">What the current build actually did.</h2><p>These are small, documented checks from 10 November 2026. They are observations, not production benchmarks.</p></div><div className="results-grid"><article><strong>2 / 3</strong><h3>Live audio triples correct</h3><p>Clean generated speech, before borrower confirmation. “Sawa teen sau” was heard as ₹3,500 instead of ₹325.</p></article><article><strong>~700 ms</strong><h3>Speech end → final STT</h3><p>698–755 ms across documented scripted runs of one clean generated clip.</p></article><article><strong>1.0–1.27 s</strong><h3>Speech end → first TTS byte</h3><p>1,011–1,269 ms in the same scripted streaming checks.</p></article><article><strong>266 ms</strong><h3>Scripted barge-in reaction</h3><p>Caller WAV onset to Prisma cancellation in one injected-audio smoke run.</p></article></div><p className="results-note"><ShieldCheck size={17}/> The reliability layer made 0 unconfirmed writes in the three live audio cases. Text fixture scores use different supplied transcripts and do not measure STT improvement.</p></section>

    <section className="landing-section architecture-section" id="architecture" aria-labelledby="architecture-title"><div className="section-heading"><p className="section-index">ARCHITECTURE</p><h2 id="architecture-title">One layer between hearing and speaking.</h2><p>The browser streams audio through the backend. Credentials stay on the server; the ledger only receives confirmed promises.</p></div><div className="architecture-flow" role="img" aria-label="Caller audio goes to Prisma STT over REST or WebSocket, then to WadaPakka verification, then to Timbre TTS and back to caller"><div className="arch-node arch-caller">Caller<span>Hinglish voice</span></div><span className="arch-arrow">→</span><div className="arch-node">Prisma STT<span>REST + WebSocket</span></div><span className="arch-arrow">→</span><div className="arch-node arch-core"><strong>WadaPakka</strong><span>Normalize · Verify · State machine</span><small>Idempotent ledger · Handoff · Observability</small></div><span className="arch-arrow">→</span><div className="arch-node">Timbre TTS<span>Spoken read back</span></div><span className="arch-arrow">→</span><div className="arch-node arch-caller">Caller<span>Confirm or correct</span></div></div></section>

    <section className="final-cta"><div><h2>A promise is only useful<br/>when it’s the right one.</h2><p>Try the working verification flow with a Hinglish collection line.</p><a className="hero-button hero-button-primary" href="#demo">Try live demo <ArrowRight size={18}/></a></div><span className="cta-watermark" aria-hidden="true">✓</span></section>
    <footer className="site-footer"><div className="brand"><span className="brand-mark"><Check size={17} strokeWidth={3}/></span>WadaPakka<span className="brand-period">.</span></div><p>Built for the Great Indian AI Internship Challenge by Gnani.ai</p><div><span>Shubham Indulkar</span><a href="https://github.com/Thesilentprogramer/wadapakka" aria-label="WadaPakka GitHub repository">GitHub</a></div></footer>
  </main>
}
