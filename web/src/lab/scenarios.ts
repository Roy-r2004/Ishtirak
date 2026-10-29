export type Observation = {at:number; leader:string|null; nodesUp:string[]; buildingsUp:string[]; granted:number; capacity:number; quorum:boolean; stale:boolean; postgresUp?:boolean}
export type TimelineEvent = {at:number; kind:'leader_elected'|'leader_lost'|'node_down'|'node_up'|'quorum_lost'|'quorum_restored'; detail:string}
export type Command = {service:string; action:'stop'|'start'}
export type RunState = {id:string; step:number; startedAt:number; stepStartedAt:number; stopped:string[]; status:'running'|'restoring'|'done'|'timeout'|'cancelled'; log:string[]}
export type Step = {label:string; command?:Command|((o:Observation)=>Command|null); until:(o:Observation)=>boolean; timeoutMs:number}
export type Scenario = {id:string; title:string; blurb:string; steps:Step[]}

export const coordinators=['coordinator1','coordinator2','coordinator3']
/** An observation must be this much newer than a restore command before it can confirm the service is back. */
export const CONFIRM_DELAY_MS=2500

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

const find=(id:string)=>{const s=scenarios.find(x=>x.id===id);if(!s)throw Error(`Unknown scenario ${id}`);return s}

/** Enter a step: resolve its command from this observation (e.g. which node is leader right now). */
function enter(run:RunState,scenario:Scenario,step:number,o:Observation,now:number):{run:RunState;commands:Command[]}{
 const s=scenario.steps[step],log=[...run.log,`${stamp(now)} Step ${step+1}/${scenario.steps.length}: ${s.label}`]
 const next={...run,step,stepStartedAt:now,log}
 const command=typeof s.command==='function'?s.command(o):s.command??null
 if(s.command&&!command){next.log=[...log,`${stamp(now)} No target could be resolved from the observation; command not issued.`];return{run:next,commands:[]}}
 if(!command)return{run:next,commands:[]}
 next.stopped=command.action==='stop'?[...new Set([...run.stopped,command.service])]:run.stopped.filter(s=>s!==command.service)
 return{run:next,commands:[command]}
}

/** Start a run. The first step's command (if any) is resolved from the observation passed in. */
export function begin(scenario:Scenario,o:Observation,now:number):{run:RunState;commands:Command[]}{
 const run:RunState={id:scenario.id,step:0,startedAt:now,stepStartedAt:now,stopped:[],status:'running',log:[`${stamp(now)} Started ${scenario.title}`]}
 return enter(run,scenario,0,o,now)
}

/** Request cancellation. Restoration is performed by the following advance calls. */
export function cancelRun(run:RunState,now:number):RunState{
 if(run.status!=='running'&&run.status!=='restoring')return run
 return{...run,status:'cancelled',stepStartedAt:now,log:[...run.log,`${stamp(now)} Cancelled; restoring stopped services`]}
}

const finish=(run:RunState,status:'done'|'timeout',now:number,why:string):{run:RunState;commands:Command[]}=>({
 run:{...run,status:status==='done'&&run.stopped.length?'restoring':status,stepStartedAt:now,log:[...run.log,`${stamp(now)} ${why}`]},
 commands:run.stopped.map(service=>({service,action:'start' as const})),
})

/**
 * Pure state machine. Never counts a stale observation as proof; on done/timeout/cancel it emits a start
 * command for every service in run.stopped and keeps re-emitting until a fresh observation shows it up.
 */
export function advance(run:RunState,o:Observation,now:number):{run:RunState;commands:Command[]}{
 const scenario=find(run.id)
 if(run.status==='running'){
  const s=scenario.steps[run.step]
  if(!o.stale&&s.until(o)){
   const done=`${stamp(now)} Observed: ${s.label}`
   const marked={...run,log:[...run.log,done]}
   if(run.step+1>=scenario.steps.length)return finish(marked,'done',now,run.stopped.length?'Scenario complete; restoring remaining services':'Scenario complete')
   return enter(marked,scenario,run.step+1,o,now)
  }
  if(now-run.stepStartedAt>=s.timeoutMs)return finish(run,'timeout',now,`Timed out after ${Math.round(s.timeoutMs/1000)} s waiting for: ${s.label}. Restoring stopped services`)
  return{run,commands:[]}
 }
 if(!run.stopped.length)return{run:run.status==='restoring'?{...run,status:'done',log:[...run.log,`${stamp(now)} All services observed running`]}:run,commands:[]}
 // Terminal or restoring: only an observation clearly newer than the restore command confirms recovery.
 const fresh=!o.stale&&o.at>=run.stepStartedAt+CONFIRM_DELAY_MS
 const pending=fresh?run.stopped.filter(service=>!isUp(service,o)):run.stopped
 const confirmed=run.stopped.filter(service=>!pending.includes(service))
 const next=confirmed.length?{...run,stopped:pending,log:[...run.log,...confirmed.map(service=>`${stamp(now)} Observed running again: ${service}`)]}:run
 return{run:run.status==='restoring'&&!pending.length?{...next,status:'done'}:next,commands:pending.map(service=>({service,action:'start' as const}))}
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
