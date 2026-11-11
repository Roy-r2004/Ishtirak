import { useEffect, useRef, useState } from 'react'
import { useGrid } from '../data'
import { useDemoActive } from '../demo/install'
import { AboutDrawer, BuildingDrawer, ClusterDrawer, FullLogDrawer } from './Drawers'
import { AllocationLog } from './AllocationLog'
import { CapacityPanel } from './CapacityPanel'
import { ChartPanel } from './ChartPanel'
import { CoordinatorsTable } from './CoordinatorsTable'
import { Diagram } from './Diagram'
import { Dock, type DockTab } from './Dock'
import { FailureTests } from './FailureTests'
import { Simulation } from './Simulation'
import { TopBar } from './TopBar'
import { Glyph } from './controls'
import { describeNotice } from './copy'
import { readTheme, saveTheme, themeAttribute, type Theme } from './console-logic'
import { useLab } from './use-lab'

/** The whole product: one operations console. The single-line diagram is the hero; everything else is a panel, a dock tab or a drawer. */
export function Board() {
  const grid = useGrid(), lab = useLab(grid), demo = useDemoActive()
  const [about, setAbout] = useState(false), [building, setBuilding] = useState<string | null>(null), [logDrawer, setLogDrawer] = useState(false), [clusterDrawer, setClusterDrawer] = useState(false)
  const [tab, setTab] = useState<DockTab>('log'), [theme, setTheme] = useState<Theme>(() => readTheme(typeof localStorage === 'undefined' ? null : localStorage))
  const returnTo = useRef<HTMLElement | null>(null), aboutRef = useRef<HTMLButtonElement>(null), chartTrigger = useRef<HTMLElement | null>(null), previousTab = useRef<DockTab>('log')
  const enabled = !!grid.data?.demo_enabled, chartOpen = tab === 'chart', reachable = grid.nodes.filter(n => n.online).length
  // The trigger is remembered explicitly: Safari does not focus a button on click, so document.activeElement would be the body.
  const remember = (trigger: HTMLElement | null) => { returnTo.current = trigger }
  const restore = () => returnTo.current?.focus()
  // One chart, two ways in (the Chart button in the capacity panel and the Chart tab): one state, and focus goes back to whichever opened it.
  const openChart = (trigger: HTMLElement) => { chartTrigger.current = trigger; if (tab !== 'chart') previousTab.current = tab; setTab('chart') }
  const closeChart = () => { setTab(previousTab.current === 'chart' ? 'log' : previousTab.current); requestAnimationFrame(() => chartTrigger.current?.focus()) }
  const chooseTab = (next: DockTab, trigger: HTMLElement) => { if (next === 'chart') { if (!chartOpen) openChart(trigger) } else setTab(next) }
  const toggleChart = (trigger: HTMLElement) => { if (chartOpen) { chartTrigger.current = trigger; closeChart() } else openChart(trigger) }
  const chooseTheme = (next: Theme) => { setTheme(next); saveTheme(typeof localStorage === 'undefined' ? null : localStorage, next) }
  // On a phone the dock sits far below the Chart button in the capacity panel, so the chart is scrolled into view when it opens.
  useEffect(() => { if (chartOpen) requestAnimationFrame(() => document.getElementById('chart-panel')?.scrollIntoView({ block: 'nearest' })) }, [chartOpen])
  useEffect(() => { const attr = themeAttribute(theme); if (attr) document.documentElement.dataset.theme = attr; else delete document.documentElement.dataset.theme }, [theme])
  // Success notices clear themselves; failures stay until dismissed because they say what to do next.
  useEffect(() => { if (!grid.notice || grid.notice.failed) return; const t = setTimeout(() => grid.setNotice(null), 9000); return () => clearTimeout(t) }, [grid.notice])
  return <div className="console">
    <a href="#board" className="skip-link">Skip to the console</a>
    <TopBar grid={grid} lab={lab} demo={demo} aboutRef={aboutRef} onAbout={() => { remember(aboutRef.current); setAbout(true) }} />
    {!grid.quorum && !grid.stale && <div className="alarm" role="alert" data-testid="majority-alarm"><Glyph tone="fault" /><strong>New grants are paused.</strong><span>Only {reachable} of {grid.nodes.length} coordinators can be reached; a majority needs 2. Existing leases stop serving at their safe deadlines. Start a stopped coordinator to resume.</span></div>}
    <main id="board" tabIndex={-1} className="main" data-testid="board" data-lamptest="false" data-demo={demo} data-tray={chartOpen}>
      <Diagram grid={grid} enabled={enabled} onOpenBuilding={(id, trigger) => { remember(trigger); setBuilding(id) }} onOpenCluster={trigger => { remember(trigger); setClusterDrawer(true) }} />
      <div className="side">
        <CapacityPanel grid={grid} lab={lab} chartOpen={chartOpen} onOpenChart={toggleChart} />
        <CoordinatorsTable grid={grid} enabled={enabled} />
      </div>
    </main>
    <Dock tab={tab} onTab={chooseTab} running={lab.running} status={grid.notice && <div className={`toast ${grid.notice.failed ? 'toast-red' : ''}`} role="status" data-testid="notice"><span>{describeNotice(grid.notice.text)}</span><button type="button" className="btn btn-sm" onClick={() => grid.setNotice(null)}>Dismiss</button></div>} panels={{
      log: <AllocationLog grid={grid} onOpenFull={trigger => { remember(trigger); setLogDrawer(true) }} />,
      tests: <FailureTests grid={grid} lab={lab} />,
      sim: <Simulation grid={grid} />,
      chart: <ChartPanel grid={grid} onClose={closeChart} />,
    }} />
    <AboutDrawer open={about} onClose={() => setAbout(false)} restore={restore} demo={demo} theme={theme} onTheme={chooseTheme} />
    <BuildingDrawer grid={grid} id={building} onClose={() => setBuilding(null)} restore={restore} />
    <FullLogDrawer grid={grid} open={logDrawer} onClose={() => setLogDrawer(false)} restore={restore} />
    <ClusterDrawer grid={grid} open={clusterDrawer} onClose={() => setClusterDrawer(false)} restore={restore} />
  </div>
}
