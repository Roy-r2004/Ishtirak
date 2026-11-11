import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export type DockTab = 'log' | 'tests' | 'sim' | 'chart'
const TABS: { id: DockTab; label: string }[] = [{ id: 'log', label: 'Allocation log' }, { id: 'tests', label: 'Failure tests' }, { id: 'sim', label: 'Simulation' }, { id: 'chart', label: 'Chart' }]

/**
 * The bottom dock: plain tabs over one panel at a time. Panels that are not shown stay mounted but hidden, so a typed search or a chosen meter count
 * survives a tab change. Arrow keys move between tabs and Enter or Space opens one (manual activation, so moving past Chart never steals focus).
 */
export function Dock({ tab, onTab, running, panels, status }: { tab: DockTab; onTab: (tab: DockTab, trigger: HTMLElement) => void; running: boolean; panels: Record<DockTab, ReactNode>; status?: ReactNode }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (e: KeyboardEvent, from: number) => {
    const n = TABS.length
    const next = e.key === 'ArrowRight' ? (from + 1) % n : e.key === 'ArrowLeft' ? (from - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault(); refs.current[next]?.focus()
  }
  return <section className="dock" data-testid="dock" aria-label="Logs, tests, simulation and chart">
    <div className="tabbar">
    <div className="tabs" role="tablist" aria-label="Dock">
      {TABS.map((t, i) => <button key={t.id} ref={el => { refs.current[i] = el }} type="button" role="tab" id={`tab-${t.id}`} className="tab" aria-selected={tab === t.id} aria-controls={t.id === 'chart' ? 'chart-panel' : `panel-${t.id}`} aria-expanded={t.id === 'chart' ? tab === 'chart' : undefined} tabIndex={tab === t.id ? 0 : -1} data-testid={t.id === 'chart' ? 'recorder-open-bottom' : `tab-${t.id}`} onClick={e => onTab(t.id, e.currentTarget)} onKeyDown={e => move(e, i)}>
        {t.label}{t.id === 'tests' && running && <><span className="tab-run" aria-hidden="true">Running</span><span className="sr"> (a test is running)</span></>}
      </button>)}
    </div>
    {status}
    </div>
    {TABS.map(t => <div key={t.id} role="tabpanel" id={t.id === 'chart' ? 'chart-panel' : `panel-${t.id}`} className="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={tab !== t.id}>{t.id === 'chart' ? (tab === 'chart' ? panels.chart : null) : panels[t.id]}</div>)}
  </section>
}
