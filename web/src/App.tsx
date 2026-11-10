import { useState } from 'react'
import { AudioLines, Check, Mic2 } from 'lucide-react'
import TurnPanel from './components/TurnPanel'
import LivePanel from './components/LivePanel'

export function App() {
  const [mode, setMode] = useState<'turn'|'live'>('turn')
  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Check size={22} strokeWidth={3}/></span>WadaPakka</div><span className="top-note"><i className="top-note-dot"/>Reliability layer lab · Synthetic borrower only</span></header>
    <section className="hero"><h1>Reliability layer for<br/><span>Gnani voice agents.</span></h1><div className="hero-copy">From first utterance to verified promise: listen, read back, confirm, then write.<div className="model-badges"><span className="badge">Prisma v3.0</span><span className="badge">Timbre v2.5</span></div></div></section>
    <div className="tabs" role="tablist" aria-label="Call mode"><button className={`tab ${mode==='turn'?'active':''}`} role="tab" aria-selected={mode==='turn'} onClick={()=>setMode('turn')}><Mic2 size={16}/>Turn-based · L1</button><button className={`tab ${mode==='live'?'active':''}`} role="tab" aria-selected={mode==='live'} onClick={()=>setMode('live')}><AudioLines size={16}/>Live streaming · L2</button></div>
    <div hidden={mode!=='turn'} role="tabpanel" aria-label="Turn-based comparison"><TurnPanel active={mode==='turn'}/></div>
    <div hidden={mode!=='live'} role="tabpanel" aria-label="Live streaming call"><LivePanel active={mode==='live'}/></div>
    <p className="foot">Prisma v3.0 STT · Timbre v2.5 voice Poorvi · No model confidence score. Demo data and account are fictional. Microphone needs browser permission and an API key. L1 WebM clips also need ffmpeg on the server.</p>
  </main>
}
