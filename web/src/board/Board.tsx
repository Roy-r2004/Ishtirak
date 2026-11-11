import { useEffect, useRef, useState } from 'react'
import { time, useGrid } from '../data'
import { useDemoActive } from '../demo/install'
import { Ammeter } from './Ammeter'
import { Council } from './Council'
import { ClusterDoor, FeederDoor, HelpDoor, LedgerDoor } from './Doors'
import { Feeders } from './Feeders'
import { Ledger } from './Ledger'
import { Recorder } from './Recorder'
import { TestPanel } from './TestPanel'
import { TopPlate } from './TopPlate'
import { describeNotice } from './copy'
import { useLab } from './use-lab'
import { useReducedMotion, useSelfTest } from './use-motion'

/** The whole product: one wall-mounted distribution board. Detail opens as an inspection door over it, never as a new page. */
export function Board() {
  const grid = useGrid(), lab = useLab(grid), demo = useDemoActive(), reduced = useReducedMotion(), selfTest = useSelfTest(reduced)
  const [help, setHelp] = useState(false), [door, setDoor] = useState<string | null>(null), [tray, setTray] = useState(false), [ledgerDoor, setLedgerDoor] = useState(false), [clusterDoor, setClusterDoor] = useState(false)
  const returnTo = useRef<HTMLElement | null>(null), helpRef = useRef<HTMLButtonElement>(null), trayTrigger = useRef<HTMLElement | null>(null)
  const enabled = !!grid.data?.demo_enabled
  // The trigger is remembered explicitly: Safari does not focus a button on click, so document.activeElement would be the body.
  const remember = (trigger: HTMLElement | null) => { returnTo.current = trigger }
  const restore = () => returnTo.current?.focus()
  // One tray, two buttons (top plate and bottom of the board). Focus goes back to whichever one opened it, and the tray is scrolled into view
  // because on a phone the bottom button sits far below the ledger the tray opens over.
  const toggleTray = (trigger: HTMLElement) => { trayTrigger.current = trigger; setTray(t => !t) }
  useEffect(() => { if (tray) requestAnimationFrame(() => document.getElementById('recorder-tray')?.scrollIntoView({ block: 'nearest' })) }, [tray])
  // Success notices clear themselves; failures stay until dismissed because they say what to do next.
  useEffect(() => { if (!grid.notice || grid.notice.failed) return; const t = setTimeout(() => grid.setNotice(null), 9000); return () => clearTimeout(t) }, [grid.notice])
  return <div className="cabinet">
    <a href="#board" className="skip-link">Skip to the board</a>
    <main id="board" tabIndex={-1} className="board" data-testid="board" data-lamptest={selfTest !== 'done'} data-demo={demo} data-tray={tray}>
      <TopPlate grid={grid} lab={lab} demo={demo} helpRef={helpRef} onHelp={() => { remember(helpRef.current); setHelp(true) }} />
      {grid.notice && <div className={`plate notice ${grid.notice.failed ? 'plate-alarm' : 'plate-notice'}`} role="status" data-testid="notice"><span>{describeNotice(grid.notice.text)}</span><button type="button" className="push" onClick={() => grid.setNotice(null)}>Dismiss</button></div>}
      <div className="cell-meter">
        <Ammeter grid={grid} lab={lab} selfTest={selfTest} />
        <button type="button" className="push tray-pull" aria-expanded={tray} aria-controls="recorder-tray" data-testid="recorder-open" onClick={e => toggleTray(e.currentTarget)}>Chart recorder</button>
      </div>
      <div className="cell-council"><Council grid={grid} enabled={enabled} onOpenCluster={trigger => { remember(trigger); setClusterDoor(true) }} /></div>
      <div className="cell-feeders"><Feeders grid={grid} enabled={enabled} onOpen={(id, trigger) => { remember(trigger); setDoor(id) }} /></div>
      <div className="cell-ledger">
        <Ledger grid={grid} onOpenFull={trigger => { remember(trigger); setLedgerDoor(true) }} />
        {tray && <Recorder grid={grid} onClose={() => { setTray(false); trayTrigger.current?.focus() }} />}
      </div>
      <div className="cell-test"><TestPanel grid={grid} lab={lab} /></div>
      <footer className="board-foot">
        <p className="foot-note">Telemetry history since this page opened.<span className="sr"> Last update {grid.lastSeen ? time(grid.lastSeen) : 'none yet'}.</span></p>
        <button type="button" className="push push-foot" aria-expanded={tray} aria-controls="recorder-tray" data-testid="recorder-open-bottom" onClick={e => toggleTray(e.currentTarget)}>Chart recorder</button>
      </footer>
    </main>
    <HelpDoor open={help} onClose={() => setHelp(false)} restore={restore} demo={demo} />
    <FeederDoor grid={grid} id={door} onClose={() => setDoor(null)} restore={restore} />
    <LedgerDoor grid={grid} open={ledgerDoor} onClose={() => setLedgerDoor(false)} restore={restore} />
    <ClusterDoor grid={grid} open={clusterDoor} onClose={() => setClusterDoor(false)} restore={restore} />
  </div>
}
