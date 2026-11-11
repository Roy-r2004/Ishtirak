import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Building2, Check, Clock, Cpu, Database, LoaderCircle, Network, Play, ShieldCheck, Square, TriangleAlert, X } from 'lucide-react'
import {time, num, type Grid} from './data'
import {advance, begin, cancelRun, catalogue, commandKey, commandRequest, deriveTimeline, dwellProgress, hasPending, isService, isStress, overload, proof, restoreCommands, scenarios, type Command, type Observation, type RunState, type Scenario, type TimelineEvent} from './lab/scenarios'
import type {Policy} from './lab/fairness'
import {FairSharing, type OverloadResults} from './fair-sharing'
import './resilience-lab.css'
const icons:Record<string,typeof Network>={'leader-failover':Network,'majority-loss':Cpu,'gateway-crash':Building2,'database-outage':Database}
const kindLabel:Record<TimelineEvent['kind'],string>={leader_elected:'Leader observed',leader_lost:'Leader lost',node_down:'Unreachable',node_up:'Reachable',quorum_lost:'Majority lost',quorum_restored:'Majority restored'}
const RETRY_MS=5000
function observe(grid:Grid):Observation{
 const c=grid.cluster
 return{at:Date.now(),leader:grid.data?.nodes.find(n=>n.online&&n.data?.state==='Leader')?.id??null,nodesUp:grid.nodes.filter(n=>n.online).map(n=>n.id),buildingsUp:grid.buildings.filter(b=>b.online).map(b=>b.id),granted:c?.granted_amps??0,capacity:c?.capacity_amps??0,quorum:grid.quorum,stale:grid.stale||!c||!grid.data,postgresUp:c?c.postgres_connected:undefined,policy:grid.policy,meters:grid.data?.meters.online&&grid.data.meters.data?{meter_count:grid.data.meters.data.meter_count,demand_factor:grid.data.meters.data.demand_factor}:null,wants:c?.wants,reserved:c?.leases}
}
const active=(r:RunState|null)=>!!r&&(r.status==='running'||r.status==='restoring'||hasPending(r))
const outcome:Record<RunState['status'],string>={running:'Running',restoring:'Restoring services',done:'Completed',timeout:'Timed out',cancelled:'Cancelled'}
const seconds=(ms:number)=>`${Math.max(0,Math.round(ms/1000))} s`
export function ResilienceLab({grid}:{grid:Grid}){
 const [history,setHistory]=useState<Observation[]>([]),[timeline,setTimeline]=useState<TimelineEvent[]>([]),[run,setRunState]=useState<RunState|null>(null),[runPolicy,setRunPolicy]=useState<Policy>('fair_share'),[results,setResults]=useState<OverloadResults>({})
 const runRef=useRef<RunState|null>(null),obsRef=useRef<Observation|null>(null),baseline=useRef<Observation|null>(null),queue=useRef<Command[]>([]),sentAt=useRef<Record<string,number>>({})
 const setRun=(next:RunState|null)=>{runRef.current=next;setRunState(next)}
 const enqueue=(commands:Command[])=>{for(const c of commands)if(!queue.current.some(q=>commandKey(q)===commandKey(c)))queue.current.push(c)}
 function send(cmd:Command){
  if(isService(cmd))return grid.act(cmd.service,cmd.action)
  if(cmd.kind==='policy')return void grid.setPolicy(cmd.policy)
  const {path,body}=commandRequest(cmd);void grid.post(path,body,'meters-config',`Meters set to ${cmd.meter_count} at ${cmd.demand_factor.toFixed(1)}× demand.`)
 }
 const enabled=!!grid.data?.demo_enabled,running=active(run)
 // Record one observation whenever new grid data arrives or freshness changes.
 useEffect(()=>{
  const o=observe(grid);obsRef.current=o
  setHistory(prev=>[...prev,o].slice(-600))
  const events=deriveTimeline(baseline.current,o)
  if(events.length)setTimeline(prev=>[...events.reverse(),...prev].slice(0,40))
  if(!o.stale)baseline.current=o
 },[grid.data,grid.cluster,grid.stale,grid.quorum])
 // Drive the scenario state machine on every dashboard tick (timeouts must advance without new data).
 useEffect(()=>{
  const r=runRef.current,o=obsRef.current
  if(!r||!o||!active(r))return
  const x=advance(r,o,Date.now())
  if(x.run!==r)setRun(x.run)
  enqueue(x.commands)
 },[grid.now])
 // Send queued commands one at a time through the label-checked controller.
 useEffect(()=>{
  if(!queue.current.length||grid.busy||!enabled)return
  const cmd=queue.current.shift()!
  if(isStress(cmd,runRef.current)&&runRef.current?.status!=='running')return
  const key=commandKey(cmd),t=Date.now()
  if(t-(sentAt.current[key]??0)<RETRY_MS)return
  sentAt.current[key]=t;send(cmd)
 },[grid.now,grid.busy,enabled])
 // Always restore on unmount or page close, bypassing the shared action lock.
 useEffect(()=>{
  const restoreNow=()=>{const r=runRef.current;if(!r)return;for(const c of restoreCommands(r)){const {path,body}=commandRequest(c);void fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive:true}).catch(()=>{})}}
  window.addEventListener('pagehide',restoreNow)
  return()=>{window.removeEventListener('pagehide',restoreNow);restoreNow()}
 },[])
 // Keep the last completed overload window per observed policy so both outcomes can be compared.
 useEffect(()=>{const cap=run?.id==='overload'?run.captured:undefined;if(cap?.final&&cap.policy){const p=cap.policy;setResults(prev=>prev[p]?.at===cap.at?prev:{...prev,[p]:cap})}},[run])
 const stats=useMemo(()=>proof(history),[history])
 const fresh=!grid.stale&&!!grid.cluster&&!!grid.data
 function start(s:Scenario,params?:{policy:Policy}){
  const current=obsRef.current
  if(!current||current.stale||!enabled||active(runRef.current))return
  queue.current=[]
  const x=begin(s,current,Date.now(),params);setRun(x.run);enqueue(x.commands)
 }
 function cancel(){const r=runRef.current;if(r&&r.status==='running'){queue.current=queue.current.filter(c=>!isStress(c,r));setRun(cancelRun(r,Date.now()))}}
 const current=run?catalogue.find(s=>s.id===run.id):undefined,step=run&&current?current.steps[Math.min(run.step,current.steps.length-1)]:undefined
 const safe=stats.samples===0?null:stats.violations===0,pending=!!run&&hasPending(run),settings=!!run?.snapshot,dwell=run?dwellProgress(run,grid.now):null
 return <div className="rl">
 <section className="panel rl-intro"><div><span className="eyebrow">CONTROLLED FAILURE EXPERIMENTS</span><h2>Break it on purpose. Watch the invariant hold.</h2><p>Each scenario stops real containers in the local Compose project through the label-checked controller, waits for the grid to show the effect, then restores everything. All values below are observations from dashboard polling, not guarantees.</p></div><div className="rl-intro-state"><span className={`state-chip ${enabled?'green':'muted'}`}><i/>{enabled?'Controls enabled':'Demo controls disabled'}</span><span className={`state-chip ${fresh?'green':'amber'}`}><i/>{fresh?'Fresh observations':'Observations stale or missing'}</span></div></section>
 {(!enabled||!fresh)&&!running&&<div className="rl-note" role="status"><TriangleAlert size={17}/><span>{!enabled?'The dashboard controller is not enabled, so scenarios cannot run.':'Scenarios start only on fresh observations. Stale or missing data is never treated as proof.'}</span></div>}
 <FairSharing grid={grid} enabled={enabled} fresh={fresh} run={run} running={running} runPolicy={runPolicy} onRunPolicy={setRunPolicy} onStart={()=>start(overload,{policy:runPolicy})} onCancel={cancel} results={results}/>
 {run&&current&&<section className={`rl-run rl-${run.status}`} role="status" aria-live="polite" aria-label="Scenario status"><div className="rl-run-top"><span className="rl-run-icon">{run.status==='running'||run.status==='restoring'||pending?<LoaderCircle size={20} className="spin"/>:run.status==='done'?<Check size={20}/>:<TriangleAlert size={20}/>}</span><div><strong>{current.title}: {pending&&run.status!=='running'&&run.status!=='restoring'?`${outcome[run.status]}, restoring ${settings?'what this run changed':'services'}`:outcome[run.status]}</strong><p>{run.status==='running'&&step?`Step ${run.step+1} of ${current.steps.length}: ${step.label}. ${seconds(grid.now-run.stepStartedAt)} of ${seconds(step.timeoutMs)} allowed.${dwell?` Observing: ${seconds(dwell.elapsedMs)} of ${seconds(dwell.totalMs)}.`:''}`:pending?`Waiting to observe ${[...run.stopped.length?[`${run.stopped.join(', ')} running again`]:[],...run.touched?.meters?['the starting meter setup restored']:[],...run.touched?.policy?['the starting allocation policy restored']:[]].join(' and ')}. ${settings?'Restoration':'Restart'} is retried until a fresh observation confirms it.`:run.status==='done'?(settings?'Scenario complete. The starting meter setup and policy were observed restored.':'Scenario complete. Every stopped service was observed running again.'):(settings?'Run ended. Everything this run changed was observed restored.':'Run ended. Every stopped service was observed running again.')}</p></div>{run.status==='running'?<button className="button secondary rl-cancel" onClick={cancel}><Square size={14}/>Cancel and restore</button>:!pending&&<button className="button secondary rl-cancel" onClick={()=>setRun(null)}><X size={14}/>Dismiss</button>}</div>
  <div className="rl-bar" aria-hidden="true"><i style={{width:`${Math.min(100,(run.status==='done'?current.steps.length:run.step)/current.steps.length*100)}%`}}/></div>
  <details className="rl-log"><summary>Run log ({run.log.length})</summary><ol>{run.log.map((l,i)=><li key={i}>{l}</li>)}</ol></details></section>}
 <section className="panel rl-proof" aria-label="Capacity proof"><div className="rl-proof-head"><div><h2>Capacity proof</h2><p>Observed in this browser since the lab opened. Stale samples are excluded.</p></div><span className={`state-chip ${safe===null?'muted':safe?'green':'amber'}`}><ShieldCheck size={12}/>{safe===null?'No fresh samples':safe?'No violation observed':'Violation observed'}</span></div>
  <div className="rl-stats"><div><span>Peak granted</span><strong>{stats.samples?num(stats.peak):'—'}<small>{stats.samples?` of ${num(stats.capacity)} A`:''}</small></strong></div><div><span>Violations</span><strong className={stats.violations?'rl-bad':''}>{stats.samples?num(stats.violations):'—'}</strong></div><div><span>Fresh samples</span><strong>{num(stats.samples)}</strong></div><div><span>Observed since</span><strong>{stats.observedSince?time(stats.observedSince):'—'}</strong></div></div>
  <p className="rl-foot">{safe===null?'Nothing is proven until a fresh observation arrives.':safe?`Across ${num(stats.samples)} fresh samples, total granted amps never exceeded capacity. This is evidence from sampled observations, not a proof for unsampled instants.`:`${num(stats.violations)} sampled observation(s) showed granted amps above capacity.`}</p></section>
 <section aria-label="Scenarios"><div className="rl-heading"><h2>Scenarios</h2><p>One at a time. Services are restored on success, timeout, cancel, or leaving this view.</p></div><div className="rl-cards">{scenarios.map(s=>{const Icon=icons[s.id],mine=run?.id===s.id,busy=running,label=`Run ${s.title}`;return <article className={`rl-card ${mine&&running?'rl-card-live':''}`} key={s.id}><div className="rl-card-top"><span className="rl-card-icon"><Icon size={20}/></span><h3>{s.title}</h3></div><p>{s.blurb}</p><ol className="rl-steps">{s.steps.map((st,i)=>{const state=!mine?'':i<run!.step||(run!.status==='done')?'done':i===run!.step&&run!.status==='running'?'now':'';return <li key={i} className={state}><span aria-hidden="true">{state==='done'?<Check size={11}/>:state==='now'?<Clock size={11}/>:i+1}</span>{st.label}{state==='now'&&<b className="rl-sr"> (in progress)</b>}</li>})}</ol><button className="button primary full" disabled={!enabled||!fresh||busy||!!grid.busy} onClick={()=>start(s)} aria-label={label}>{mine&&running?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}{mine&&running?'Running…':'Run scenario'}</button></article>})}</div></section>
 <div className="rl-columns">
 <section className="panel rl-panel" aria-label="Raft nodes"><div className="rl-panel-head"><div><h2>Raft view</h2><p>Per coordinator, from its own latest response.</p></div><Network size={18}/></div><div className="rl-nodes">{grid.nodes.map(n=>{const raft=n.data?.raft,state=!n.online?'Offline':raft?.state??n.data?.state??'—';return <article key={n.id} className={`rl-node ${n.online&&n.data?.state==='Leader'?'leader':''} ${!n.online?'offline':''}`}><div><strong>{n.id}</strong><span className={`state-chip ${!n.online?'muted':n.data?.state==='Leader'?'green':''}`}><i/>{state}</span></div><dl><div><dt>Term</dt><dd>{n.online?raft?.term??'—':'—'}</dd></div><div><dt>Applied index</dt><dd>{n.online?raft?.applied_index??'—':'—'}</dd></div><div><dt>Last log index</dt><dd>{n.online?raft?.last_log_index??'—':'—'}</dd></div></dl>{grid.stale&&<small className="rl-stale">Stale observation</small>}</article>})}</div></section>
 <section className="panel rl-panel" aria-label="Observed timeline"><div className="rl-panel-head"><div><h2>Observed timeline</h2><p>Changes seen between fresh polls. Times are when this browser saw them.</p></div><Activity size={18}/></div>{timeline.length?<ol className="rl-timeline">{timeline.map((e,i)=><li key={`${e.at}-${i}`} className={e.kind}><time className="mono">{time(e.at)}</time><div><b>{kindLabel[e.kind]}</b><span>{e.detail}</span></div></li>)}</ol>:<div className="rl-empty"><Clock size={20}/><strong>No changes observed yet</strong><p>Leader elections and outages appear here once a fresh observation differs from the previous one.</p></div>}</section>
 </div>
 </div>
}
