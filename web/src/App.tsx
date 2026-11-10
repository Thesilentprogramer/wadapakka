import { useState } from 'react'
import { AudioLines, Check, Mic2 } from 'lucide-react'
import TurnPanel from './components/TurnPanel'
import LivePanel from './components/LivePanel'
import GradientASCII from './components/reactbits/GradientASCII'
import FolderFloat from './components/reactbits/FolderFloat'

type Destination = 'l1' | 'l2' | 'eval' | 'ledger' | 'handoff'

const destinations: { label: string; value: Destination }[] = [
  { label: 'L1 · Turn-based', value: 'l1' },
  { label: 'L2 · Live streaming', value: 'l2' },
  { label: 'Eval', value: 'eval' },
  { label: 'Ledger', value: 'ledger' },
  { label: 'Handoff desk', value: 'handoff' },
]

export function App() {
  const [mode, setMode] = useState<'turn'|'live'>('turn')
  const [destination, setDestination] = useState<Destination>('l1')

  function navigate(value: Destination) {
    setDestination(value)
    setMode(value === 'l2' ? 'live' : 'turn')
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = value === 'l1' ? 'turn-panel' : value === 'l2' ? 'live-panel' : value === 'eval' ? 'fixture-evaluation-title' : value === 'ledger' ? 'promise-ledger-title' : 'handoff-desk'
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }))
  }
  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Check size={22} strokeWidth={3}/></span>WadaPakka</div><span className="top-note"><i className="top-note-dot"/>Reliability layer lab · Synthetic borrower only</span></header>
    <section className="hero" aria-label="WadaPakka introduction">
      <GradientASCII className="hero-ascii" colors={['#1e3fd8', '#f6f8ff', '#a5d8ff', '#38bdf8']} shape="horizon" characters=" =+xX0S8#@" cellSize={18} density={0.8} glow={0.2} grain={0.08} mouseInteraction clickEffect="wave" intro />
      <div className="hero-content">
        <div className="hero-message"><h1>WadaPakka</h1><p className="hero-tagline">Reliability layer for<br/><span>Gnani voice agents.</span></p><div className="hero-copy">From first utterance to verified promise: listen, read back, confirm, then write.<div className="model-badges"><span className="badge">Prisma v3.0</span><span className="badge">Timbre v2.5</span></div></div></div>
        <div className="hero-switcher"><FolderFloat items={destinations} label={destinations.find(item => item.value === destination)?.label ?? 'L1 · Turn-based'} sublabel="Switch mode" trigger="click" closeOnSelect physics drift={0.5} onSelect={value => navigate(value as Destination)} folderColor="#1A4FD6" frontColor="#2F6BFF" paperColor="#FFFFFF" itemColor="#FFFFFF" itemTextColor="#0B0B0F" labelColor="#FFFFFF" width={220} height={140} spread={135} /></div>
      </div>
    </section>
    <nav className="mode-nav" aria-label="Mode and section navigation">
      <div className="mode-tabs" role="tablist" aria-label="Call mode" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'l1' : event.key === 'End' ? 'l2' : mode === 'turn' ? 'l2' : 'l1'
        navigate(next)
        document.getElementById(`tab-${next}`)?.focus()
      }}>
        <button id="tab-l1" type="button" role="tab" aria-controls="turn-panel" aria-selected={mode === 'turn'} tabIndex={mode === 'turn' ? 0 : -1} className={`mode-link ${mode === 'turn' ? 'active' : ''}`} onClick={() => navigate('l1')}><Mic2 size={15} aria-hidden="true"/>L1 · Turn-based</button>
        <button id="tab-l2" type="button" role="tab" aria-controls="live-panel" aria-selected={mode === 'live'} tabIndex={mode === 'live' ? 0 : -1} className={`mode-link ${mode === 'live' ? 'active' : ''}`} onClick={() => navigate('l2')}><AudioLines size={15} aria-hidden="true"/>L2 · Live streaming</button>
      </div>
      <div className="mode-sections">{destinations.slice(2).map(item => <button key={item.value} type="button" className={`mode-link ${destination === item.value ? 'section-active' : ''}`} aria-current={destination === item.value ? 'location' : undefined} onClick={() => navigate(item.value)}>{item.label}</button>)}</div>
    </nav>
    <div id="turn-panel" hidden={mode!=='turn'} role="tabpanel" aria-labelledby="tab-l1" tabIndex={0}><TurnPanel active={mode==='turn'}/></div>
    <div id="live-panel" hidden={mode!=='live'} role="tabpanel" aria-labelledby="tab-l2" tabIndex={0}><LivePanel active={mode==='live'}/></div>
    <p className="foot">Prisma v3.0 STT · Timbre v2.5 voice Poorvi · No model confidence score. Demo data and account are fictional. Microphone needs browser permission and an API key. L1 WebM clips also need ffmpeg on the server.</p>
  </main>
}
