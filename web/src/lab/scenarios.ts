import {fairnessScore, policyLabel, sumAmps, type MeterConfig, type Policy, type Share} from './fairness'

export type Observation = {at:number; leader:string|null; nodesUp:string[]; buildingsUp:string[]; granted:number; capacity:number; quorum:boolean; stale:boolean; postgresUp?:boolean; policy?:Policy|null; meters?:MeterConfig|null; wants?:Share[]; reserved?:Share[]}
export type TimelineEvent = {at:number; kind:'leader_elected'|'leader_lost'|'node_down'|'node_up'|'quorum_lost'|'quorum_restored'; detail:string}
export type ServiceCommand = {service:string; action:'stop'|'start'}
export type MetersCommand = {kind:'meters'; meter_count:number; demand_factor:number}
export type PolicyCommand = {kind:'policy'; policy:Policy}
export type Command = ServiceCommand|MetersCommand|PolicyCommand
/** What the overload window looked like, from the last fresh observation inside it. `final` once the window completed. */
export type Capture = {at:number; policy:Policy|null; fairness:number|null; reserved:number; wanted:number; capacity:number; final:boolean}
export type RunState = {id:string; step:number; startedAt:number; stepStartedAt:number; stopped:string[]; status:'running'|'restoring'|'done'|'timeout'|'cancelled'; log:string[]
 /** Chosen by the presenter when the run starts (scenarios that set the allocation policy). */
 params?:{policy:Policy}
 /** Meter setup and policy remembered by a `remember` step, used for every restore. */
 snapshot?:{meters:MeterConfig; policy:Policy}
 /** Settings this run has changed and not yet seen restored, like `stopped` is for services. */
 touched?:{meters:boolean; policy:boolean}
 /** When the current step's `until` first held (continuously) for a step with `dwellMs`. */
 matchedAt?:number
 captured?:Capture}
type StepCommand = Command|Command[]|((o:Observation,run:RunState)=>Command|Command[]|null)
export type Step = {label:string; command?:StepCommand; until:(o:Observation,run:RunState)=>boolean; timeoutMs:number
 /** After `until` first holds, keep observing this long (it must keep holding) before the step completes. */
 dwellMs?:number
 /** On completion, remember the meter setup and policy from the observation. */
 remember?:boolean
 /** While `until` holds, record the fairness picture; marked final when the step completes. */
 capture?:boolean
 /** The step re-sends the restore commands until observed, and completing it clears what the run changed. */
 restores?:boolean}
export type Scenario = {id:string; title:string; blurb:string; steps:Step[]}

export const coordinators=['coordinator1','coordinator2','coordinator3']
/** An observation must be this much newer than a restore command before it can confirm the service is back. */
export const CONFIRM_DELAY_MS=2500

export const isService=(c:Command):c is ServiceCommand=>'service' in c
/** Identity of a command for de-duplication and retry throttling. Meter and policy keys include their values, so a restore never waits behind the change it undoes. */
export const commandKey=(c:Command)=>isService(c)?`${c.action}-${c.service}`:c.kind==='meters'?`meters-${c.meter_count}-${c.demand_factor}`:`policy-${c.policy}`
/** Whether the command adds stress (stops a service, changes meters or policy away from the remembered values) rather than restoring. Stress commands are dropped once a run stops running. */
export const isStress=(c:Command,run:RunState|null)=>isService(c)?c.action==='stop':c.kind==='meters'?!sameMeters(c,run?.snapshot?.meters):c.policy!==run?.snapshot?.policy
export const sameMeters=(a?:MeterConfig|null,b?:MeterConfig|null)=>!!a&&!!b&&a.meter_count===b.meter_count&&Math.abs(a.demand_factor-b.demand_factor)<1e-6
/** Whether the run still has something to put back: a stopped service or a changed meter setup or policy. */
export const hasPending=(run:RunState)=>run.stopped.length>0||!!run.touched?.meters||!!run.touched?.policy
/** The commands that put back everything the run changed. */
export function restoreCommands(run:RunState):Command[]{
 const commands:Command[]=run.stopped.map(service=>({service,action:'start' as const}))
 if(run.snapshot&&run.touched?.meters)commands.push({kind:'meters',...run.snapshot.meters})
 if(run.snapshot&&run.touched?.policy)commands.push({kind:'policy',policy:run.snapshot.policy})
 return commands
}

/** The HTTP request that carries a command to the control service (same-origin POST with a JSON body). */
export const commandRequest=(c:Command):{path:string;body:object}=>isService(c)?{path:'/api/actions',body:{service:c.service,action:c.action}}:c.kind==='meters'?{path:'/api/meters/config',body:{meter_count:c.meter_count,demand_factor:c.demand_factor}}:{path:'/api/policy',body:{policy:c.policy}}

const gatewayService=(building:string)=>`gateway-${building.replaceAll('_','-')}`
/** Whether the observation proves the service is running. Stale observations prove nothing. */
export function isUp(service:string,o:Observation){
 if(o.stale)return false
 if(coordinators.includes(service))return o.nodesUp.includes(service)
 if(service.startsWith('gateway-'))return o.buildingsUp.some(b=>gatewayService(b)===service)
 if(service==='postgres')return o.postgresUp===true
 return false
}
const healthy=(o:Observation)=>!o.stale&&o.quorum&&o.leader!==null&&o.nodesUp.length===coordinators.length
const stamp=(at:number)=>new Date(at).toISOString().slice(11,19)
const firstDown=(o:Observation)=>{const id=coordinators.find(c=>!o.nodesUp.includes(c));return id?{service:id,action:'start' as const}:null}

export const scenarios:Scenario[]=[
 {id:'leader-failover',title:'Leader failover',blurb:'Stop the elected Raft leader. The remaining majority should elect a replacement and keep granting within capacity.',steps:[
  {label:'Confirm a verified leader and three coordinators',until:healthy,timeoutMs:20000},
  {label:'Stop the current leader',command:o=>o.leader?{service:o.leader,action:'stop'}:null,until:o=>!o.stale&&o.leader!==null&&o.nodesUp.length===2&&o.quorum,timeoutMs:30000},
  {label:'Restart the stopped coordinator',command:firstDown,until:healthy,timeoutMs:45000},
 ]},
 {id:'majority-loss',title:'Majority loss',blurb:'Stop two of three coordinators. Without a majority no new grants can commit. Both are restarted afterwards.',steps:[
  {label:'Confirm a verified leader and three coordinators',until:healthy,timeoutMs:20000},
  {label:'Stop the current leader',command:o=>o.leader?{service:o.leader,action:'stop'}:null,until:o=>!o.stale&&o.leader!==null&&o.nodesUp.length===2&&o.quorum,timeoutMs:30000},
  {label:'Stop a second coordinator to remove the majority',command:o=>{const id=o.leader??o.nodesUp[0];return id?{service:id,action:'stop'}:null},until:o=>!o.stale&&!o.quorum&&o.nodesUp.length===1,timeoutMs:30000},
  {label:'Restart the first stopped coordinator',command:firstDown,until:o=>!o.stale&&o.nodesUp.length===2,timeoutMs:30000},
  {label:'Restart the remaining coordinator',command:firstDown,until:healthy,timeoutMs:45000},
 ]},
 {id:'gateway-crash',title:'Gateway crash',blurb:'Stop the Hamra gateway. Its lease is not renewed and local service stops at the safe deadline. Gateways are not replicated.',steps:[
  {label:'Confirm all three gateways report',until:o=>!o.stale&&o.buildingsUp.length===3,timeoutMs:20000},
  {label:'Stop the Hamra gateway',command:{service:'gateway-hamra',action:'stop'},until:o=>!o.stale&&!o.buildingsUp.includes('hamra'),timeoutMs:30000},
  {label:'Restart the Hamra gateway',command:{service:'gateway-hamra',action:'start'},until:o=>!o.stale&&o.buildingsUp.length===3,timeoutMs:45000},
 ]},
 {id:'database-outage',title:'Database outage',blurb:'Stop PostgreSQL. Grants continue through Raft and audit writes catch up after recovery. PostgreSQL has no failover.',steps:[
  {label:'Confirm PostgreSQL is connected',until:o=>!o.stale&&o.postgresUp===true,timeoutMs:20000},
  {label:'Stop PostgreSQL',command:{service:'postgres',action:'stop'},until:o=>!o.stale&&o.postgresUp===false,timeoutMs:30000},
  {label:'Restart PostgreSQL',command:{service:'postgres',action:'start'},until:o=>!o.stale&&o.postgresUp===true,timeoutMs:60000},
 ]},
]

/** Overload: a calm period, then a flood of meters, under a chosen allocation policy. Shown in the Fair sharing panel, not as a fifth service card. */
export const OVERLOAD={calm:{meter_count:10,demand_factor:1} as MeterConfig,calmMs:15000,peak:{meter_count:200,demand_factor:1} as MeterConfig,peakMs:25000}
const ready=(o:Observation)=>!o.stale&&o.quorum&&o.leader!==null
export const overload:Scenario={id:'overload',title:'Overload',blurb:'Settle at 10 meters, then flood the grid with 200 under the chosen allocation policy and watch how the generator is shared. The starting meter setup and policy are restored afterwards.',steps:[
 {label:'Remember the starting meter setup and allocation policy',remember:true,until:o=>ready(o)&&!!o.policy&&!!o.meters,timeoutMs:20000},
 {label:'Apply the chosen allocation policy',command:(_,run)=>run.params?{kind:'policy',policy:run.params.policy}:null,until:(o,run)=>ready(o)&&!!run.params&&o.policy===run.params.policy,timeoutMs:20000},
 {label:`Set ${OVERLOAD.calm.meter_count} meters and let reservations settle`,command:{kind:'meters',...OVERLOAD.calm},until:o=>ready(o)&&sameMeters(o.meters,OVERLOAD.calm),dwellMs:OVERLOAD.calmMs,timeoutMs:OVERLOAD.calmMs+30000},
 {label:`Set ${OVERLOAD.peak.meter_count} meters at ${OVERLOAD.peak.demand_factor.toFixed(1)}× demand and observe the sharing`,command:{kind:'meters',...OVERLOAD.peak},until:o=>ready(o)&&sameMeters(o.meters,OVERLOAD.peak),dwellMs:OVERLOAD.peakMs,capture:true,timeoutMs:OVERLOAD.peakMs+30000},
 {label:'Restore the starting meter setup and policy',restores:true,command:(_,run)=>run.snapshot?[{kind:'meters',...run.snapshot.meters},{kind:'policy',policy:run.snapshot.policy}]:null,until:(o,run)=>!!run.snapshot&&o.at>=run.stepStartedAt+CONFIRM_DELAY_MS&&sameMeters(o.meters,run.snapshot.meters)&&o.policy===run.snapshot.policy,timeoutMs:30000},
]}
/** Every scenario the step machine can run. `scenarios` stays the four service scenarios shown as cards. */
export const catalogue:Scenario[]=[...scenarios,overload]

const find=(id:string)=>{const s=catalogue.find(x=>x.id===id);if(!s)throw Error(`Unknown scenario ${id}`);return s}

/** The fairness picture in one observation. */
export const capture=(o:Observation,final=false):Capture=>({at:o.at,policy:o.policy??null,fairness:fairnessScore(o.wants,o.reserved),reserved:o.granted,wanted:sumAmps(o.wants),capacity:o.capacity,final})

/** Enter a step: resolve its command from this observation (e.g. which node is leader right now). */
function enter(run:RunState,scenario:Scenario,step:number,o:Observation,now:number):{run:RunState;commands:Command[]}{
 const s=scenario.steps[step],log=[...run.log,`${stamp(now)} Step ${step+1}/${scenario.steps.length}: ${s.label}`]
 const next:RunState={...run,step,stepStartedAt:now,log}
 delete next.matchedAt
 const raw=typeof s.command==='function'?s.command(o,run):s.command
 // Meter and policy changes need a remembered starting point, otherwise they could never be restored.
 const commands=(raw?[raw].flat():[]).filter(c=>isService(c)||!!run.snapshot)
 if(s.command&&!commands.length){next.log=[...log,`${stamp(now)} No target could be resolved from the observation; command not issued.`];return{run:next,commands:[]}}
 for(const command of commands){
  if(isService(command))next.stopped=command.action==='stop'?[...new Set([...next.stopped,command.service])]:next.stopped.filter(s=>s!==command.service)
  else next.touched={meters:!!next.touched?.meters||command.kind==='meters',policy:!!next.touched?.policy||command.kind==='policy'}
 }
 return{run:next,commands}
}

/** Start a run. The first step's command (if any) is resolved from the observation passed in. */
export function begin(scenario:Scenario,o:Observation,now:number,params?:{policy:Policy}):{run:RunState;commands:Command[]}{
 const run:RunState={id:scenario.id,step:0,startedAt:now,stepStartedAt:now,stopped:[],status:'running',log:[`${stamp(now)} Started ${scenario.title}${params?` with ${policyLabel[params.policy]}`:''}`],...(params?{params}:{})}
 return enter(run,scenario,0,o,now)
}

/** Request cancellation. Restoration is performed by the following advance calls. */
export function cancelRun(run:RunState,now:number):RunState{
 if(run.status!=='running'&&run.status!=='restoring')return run
 return{...run,status:'cancelled',stepStartedAt:now,log:[...run.log,`${stamp(now)} Cancelled; restoring everything this run changed`]}
}

const finish=(run:RunState,status:'done'|'timeout',now:number,why:string):{run:RunState;commands:Command[]}=>({
 run:{...run,status:status==='done'&&hasPending(run)?'restoring':status,stepStartedAt:now,log:[...run.log,`${stamp(now)} ${why}`]},
 commands:restoreCommands(run),
})

/** Progress of the observation window of the current step, null when the step has none or has not started holding. */
export function dwellProgress(run:RunState,now:number):{elapsedMs:number;totalMs:number}|null{
 const s=find(run.id).steps[run.step]
 if(run.status!=='running'||!s?.dwellMs||run.matchedAt===undefined)return null
 return{elapsedMs:Math.min(s.dwellMs,Math.max(0,now-run.matchedAt)),totalMs:s.dwellMs}
}

/**
 * Pure state machine. Never counts a stale observation as proof; on done/timeout/cancel it emits the restore commands
 * (start every service in run.stopped, put back the remembered meter setup and policy) and keeps re-emitting
 * until a fresh observation shows each of them back.
 */
export function advance(run:RunState,o:Observation,now:number):{run:RunState;commands:Command[]}{
 const scenario=find(run.id)
 if(run.status==='running'){
  const s=scenario.steps[run.step],holds=!o.stale&&s.until(o,run)
  let cur=run
  if(!holds&&run.matchedAt!==undefined){cur={...run};delete cur.matchedAt} // an observation window needs continuous, fresh evidence
  if(holds){
   if(s.capture)cur={...cur,captured:capture(o)}
   const since=cur.matchedAt??now
   if(!s.dwellMs||now-since>=s.dwellMs){
    const marked:RunState={...cur,log:[...cur.log,`${stamp(now)} Observed: ${s.label}`]}
    delete marked.matchedAt
    if(s.remember&&o.meters&&o.policy)marked.snapshot={meters:{meter_count:o.meters.meter_count,demand_factor:o.meters.demand_factor},policy:o.policy}
    if(s.capture)marked.captured=capture(o,true)
    if(s.restores)marked.touched={meters:false,policy:false}
    if(run.step+1>=scenario.steps.length)return finish(marked,'done',now,hasPending(marked)?'Scenario complete; restoring remaining services':'Scenario complete')
    return enter(marked,scenario,run.step+1,o,now)
   }
   cur={...cur,matchedAt:since}
  }
  if(now-run.stepStartedAt>=s.timeoutMs)return finish(cur,'timeout',now,`Timed out after ${Math.round(s.timeoutMs/1000)} s waiting for: ${s.label}. Restoring what this run changed`)
  return{run:cur,commands:s.restores&&!holds?restoreCommands(cur):[]}
 }
 if(!hasPending(run))return{run:run.status==='restoring'?{...run,status:'done',log:[...run.log,`${stamp(now)} All services observed running`]}:run,commands:[]}
 // Terminal or restoring: only an observation clearly newer than the restore command confirms recovery.
 const fresh=!o.stale&&o.at>=run.stepStartedAt+CONFIRM_DELAY_MS,snap=run.snapshot
 const pending=fresh?run.stopped.filter(service=>!isUp(service,o)):run.stopped
 const confirmed=run.stopped.filter(service=>!pending.includes(service))
 const metersBack=!!run.touched?.meters&&fresh&&!!snap&&sameMeters(o.meters,snap.meters),policyBack=!!run.touched?.policy&&fresh&&!!snap&&o.policy===snap.policy
 const logs=[...confirmed.map(service=>`${stamp(now)} Observed running again: ${service}`),...metersBack?[`${stamp(now)} Observed the starting meter setup restored`]:[],...policyBack?[`${stamp(now)} Observed the starting allocation policy restored`]:[]]
 const next:RunState=logs.length?{...run,stopped:pending,...run.touched?{touched:{meters:run.touched.meters&&!metersBack,policy:run.touched.policy&&!policyBack}}:{},log:[...run.log,...logs]}:run
 return{run:run.status==='restoring'&&!hasPending(next)?{...next,status:'done'}:next,commands:restoreCommands(next)}
}

/** Peak/violation summary over fresh observations only; "no data" is not proof. */
export function proof(history:Observation[]):{peak:number;capacity:number;violations:number;samples:number;observedSince:number|null}{
 const fresh=history.filter(o=>!o.stale)
 if(!fresh.length)return{peak:0,capacity:0,violations:0,samples:0,observedSince:null}
 return{peak:Math.max(...fresh.map(o=>o.granted)),capacity:fresh[fresh.length-1].capacity,violations:fresh.filter(o=>o.granted>o.capacity).length,samples:fresh.length,observedSince:fresh[0].at}
}

/** Events observed between two fresh observations. Nothing is claimed without a fresh baseline. */
export function deriveTimeline(prev:Observation|null,next:Observation):TimelineEvent[]{
 if(!prev||prev.stale||next.stale)return[]
 const at=next.at,events:TimelineEvent[]=[]
 for(const id of prev.nodesUp)if(!next.nodesUp.includes(id))events.push({at,kind:'node_down',detail:`${id} observed unreachable`})
 for(const id of next.nodesUp)if(!prev.nodesUp.includes(id))events.push({at,kind:'node_up',detail:`${id} observed reachable`})
 for(const id of prev.buildingsUp)if(!next.buildingsUp.includes(id))events.push({at,kind:'node_down',detail:`gateway ${id.replaceAll('_','-')} observed unreachable`})
 for(const id of next.buildingsUp)if(!prev.buildingsUp.includes(id))events.push({at,kind:'node_up',detail:`gateway ${id.replaceAll('_','-')} observed reachable`})
 if(prev.leader&&prev.leader!==next.leader)events.push({at,kind:'leader_lost',detail:`${prev.leader} no longer observed as leader`})
 if(prev.quorum&&!next.quorum)events.push({at,kind:'quorum_lost',detail:'Majority no longer observed'})
 if(!prev.quorum&&next.quorum)events.push({at,kind:'quorum_restored',detail:'Majority observed again'})
 if(next.leader&&prev.leader!==next.leader)events.push({at,kind:'leader_elected',detail:`${next.leader} observed as leader`})
 return events
}
