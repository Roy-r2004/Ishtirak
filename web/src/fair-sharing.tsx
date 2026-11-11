import { Check, Clock, LoaderCircle, Play, Scale, Square, Zap } from 'lucide-react'
import {names, num, time, type Grid} from './data'
import {barPercent, barScale, fairnessScore, percent, policyLabel, shareRows, type Policy} from './lab/fairness'
import {OVERLOAD, dwellProgress, overload, type Capture, type RunState} from './lab/scenarios'
const policies:Policy[]=['fair_share','first_come']
const amp=(v:number|null)=>v===null?'—':`${num(v,1)} A`
const pct=(v:number,max:number)=>`${max>0?Math.max(0,Math.min(100,v/max*100)):0}%`
export type OverloadResults=Partial<Record<Policy,Capture>>
type Props={grid:Grid;enabled:boolean;fresh:boolean;run:RunState|null;running:boolean;runPolicy:Policy;onRunPolicy:(p:Policy)=>void;onStart:()=>void;onCancel:()=>void;results:OverloadResults}
function Choice({label,value,onPick,disabled,describedBy,describe}:{label:string;value:Policy|null;onPick:(p:Policy)=>void;disabled:boolean;describedBy?:string;describe?:(p:Policy)=>string}){
 return <div className="segmented fs-seg" role="group" aria-label={label} aria-describedby={describedBy}>{policies.map(p=><button key={p} type="button" aria-pressed={value===p} aria-label={describe?.(p)} className={value===p?'active':''} disabled={disabled} onClick={()=>onPick(p)}>{policyLabel[p]}</button>)}</div>
}
/** The Fair sharing panel: policy switch, per-building demand/reserved/fair-share bars, fairness score, total reserved, and the Overload demonstration. Every number is an observation. */
export function FairSharing({grid,enabled,fresh,run,running,runPolicy,onRunPolicy,onStart,onCancel,results}:Props){
 const c=grid.cluster,leader=!grid.stale&&!!grid.data?.nodes.some(n=>n.online&&n.data?.state==='Leader'),metersKnown=!!grid.data?.meters.online&&!!grid.data.meters.data
 const rows=shareRows(grid.buildings.map(b=>b.id),c?.wants,c?.leases,c?.fair_shares),scale=barScale(rows,c?.capacity_amps??0),score=fairnessScore(c?.wants,c?.leases)
 const reported=!!c&&Array.isArray(c.wants)&&Array.isArray(c.fair_shares),total=c?.granted_amps,capacity=c?.capacity_amps
 const lock=!enabled?'Demo controls are disabled.':!leader?'Waiting for a verified leader.':grid.policy===null?'The coordinators have not reported an allocation policy.':running?'The overload run is using the policy switch.':grid.busy?'Another action is in progress.':''
 const startLock=!enabled?'Demo controls are disabled.':!fresh?'Needs fresh observations.':!leader?'Waiting for a verified leader.':grid.policy===null?'The coordinators have not reported an allocation policy.':!metersKnown?'The meter simulator is not reporting.':running?'A scenario is running.':grid.busy?'Another action is in progress.':''
 const mine=run?.id==='overload',dwell=mine&&run?dwellProgress(run,grid.now):null,live=mine&&run?.status==='running'
 return <section className={`panel fs ${fresh?'':'fs-stale'}`} aria-labelledby="fs-title">
  <div className="fs-head"><div><div className="fs-title"><span className="fs-title-icon"><Scale size={18}/></span><h2 id="fs-title">Fair sharing</h2><span className={`state-chip ${fresh?'green':'amber'}`}><i/>{fresh?'Observed':'No fresh data'}</span></div><p>When buildings want more than the generator can supply, power is split into equal shares instead of the first building taking it all.</p></div>
   <div className="fs-switch"><Choice label="Allocation policy" value={grid.policy} onPick={p=>{if(p!==grid.policy)void grid.setPolicy(p)}} disabled={!!lock} describedBy={lock?'fs-lock':undefined}/>{lock&&<small id="fs-lock">{lock}</small>}</div></div>
  <div className="fs-body">
   <div className="fs-buildings">
    {c?<ul className="fs-rows">{rows.map(r=><li className="fs-row" key={r.id}>
     <div className="fs-row-head"><strong>{names[r.id]??r.id}</strong><dl><div><dt>Wants</dt><dd>{amp(r.want)}</dd></div><div><dt>Reserved</dt><dd>{amp(r.reserved)}</dd></div><div><dt>Fair share</dt><dd>{amp(r.fair)}</dd></div></dl></div>
     <div className="fs-bars" aria-hidden="true"><div className="fs-track"><i className="fs-want" style={{width:pct(r.want??0,scale)}}/></div><div className="fs-track"><i className="fs-res" style={{width:pct(r.reserved??0,scale)}}/></div>{r.fair!==null&&<b className="fs-mark" style={{left:pct(r.fair,scale)}}/>}</div>
    </li>)}</ul>:<div className="fs-empty" role="status"><Clock size={20}/><strong>{fresh?'Nothing reported yet':'No fresh data'}</strong><p>Per-building requests and shares appear once a coordinator reports them.</p></div>}
    <div className="fs-legend" aria-hidden="true"><span><i className="fs-k fs-k-want"/>Wants</span><span><i className="fs-k fs-k-res"/>Reserved</span><span><i className="fs-k fs-k-mark"/>Fair share</span><em>Bars share one scale: 0 to {num(scale)} A</em></div>
    {c&&!reported&&<p className="fs-note">These coordinators do not report per-building requests or fair shares, so only the reserved amps are shown.</p>}
   </div>
   <div className="fs-side">
    <div className="fs-stat"><span className="fs-label">Fairness score</span><strong className="fs-big">{percent(score)}</strong><div className="fs-meter" aria-hidden="true"><i style={{width:score===null?'0%':pct(score,1)}}/></div><p>How evenly reserved amps are spread across the buildings that want power; 100% means equal shares.</p>{score===null&&<small>Needs at least two buildings that want power.</small>}</div>
    <div className="fs-stat"><span className="fs-label">Total reserved</span><strong className="fs-big">{total===undefined?'—':num(total)}<small> of {capacity===undefined?'—':num(capacity)} A</small></strong>{total!==undefined&&capacity!==undefined&&<div className="fs-meter" role="meter" aria-label="Total reserved against generator capacity" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={total} aria-valuetext={`${num(total)} of ${num(capacity)} amps`}><i style={{width:pct(total,capacity)}}/></div>}<p>{fresh?'Observed':'Last observed'}{grid.lastSeen?` ${time(grid.lastSeen)}`:''}.</p></div>
   </div>
  </div>
  <section className="fs-overload" aria-labelledby="fs-overload-title">
   <div className="fs-ov-main">
    <div className="fs-ov-top"><span className="fs-title-icon"><Zap size={18}/></span><h3 id="fs-overload-title">{overload.title}</h3></div>
    <p>{overload.blurb}</p>
    <div className="fs-ov-run"><span className="fs-label">Run with</span><Choice label="Run with" value={runPolicy} onPick={onRunPolicy} disabled={running} describe={p=>`Overload with ${policyLabel[p].toLowerCase()}`}/>
     <div className="fs-ov-actions"><button type="button" className="button primary" disabled={!!startLock} aria-describedby={startLock&&!live?'fs-start-lock':undefined} onClick={onStart}>{live?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}{live?'Running…':'Start overload'}</button>{live&&<button type="button" className="button secondary" onClick={onCancel}><Square size={14}/>Stop overload and restore</button>}</div>
     {startLock&&!live&&<small id="fs-start-lock">{startLock}</small>}</div>
    {dwell&&<div className="fs-progress"><div className="fs-meter" role="progressbar" aria-label="Observation window" aria-valuemin={0} aria-valuemax={Math.round(dwell.totalMs/1000)} aria-valuenow={Math.round(dwell.elapsedMs/1000)} aria-valuetext={`${Math.round(dwell.elapsedMs/1000)} s of ${Math.round(dwell.totalMs/1000)} s observed`}><i style={{width:pct(dwell.elapsedMs,dwell.totalMs)}}/></div><span>{Math.round(dwell.elapsedMs/1000)} s of {Math.round(dwell.totalMs/1000)} s observed</span></div>}
   </div>
   <ol className="fs-steps">{overload.steps.map((st,i)=>{const state=!mine||!run?'':i<run.step||run.status==='done'?'done':i===run.step&&run.status==='running'?'now':'';return <li key={i} className={state}><span aria-hidden="true">{state==='done'?<Check size={11}/>:state==='now'?<Clock size={11}/>:i+1}</span>{st.label}{state==='now'&&<b className="rl-sr"> (in progress)</b>}</li>})}</ol>
   <div className="fs-results"><span className="fs-label">Last overload results in this session</span><p>Fairness score, reserved amps and total wanted amps observed at the end of the {OVERLOAD.peakMs/1000} s window with {OVERLOAD.peak.meter_count} meters.</p><dl>{policies.map(p=>{const r=results[p];return <div key={p}><dt>{policyLabel[p]}</dt><dd>{r?<><strong>{percent(r.fairness)}</strong> fairness · {num(r.reserved)} of {num(r.capacity)} A reserved · {num(r.wanted)} A wanted <time className="mono">{time(r.at)}</time></>:<em>not run yet</em>}</dd></div>})}</dl></div>
  </section>
 </section>
}
