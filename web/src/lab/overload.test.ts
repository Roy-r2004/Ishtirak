import { describe, expect, it } from 'vitest'
import type { MeterConfig, Policy, Share } from './fairness'
import { OVERLOAD, advance, begin, cancelRun, capture, catalogue, commandKey, commandRequest, dwellProgress, hasPending, isService, isStress, overload, restoreCommands, sameMeters, scenarios, type Command, type Observation, type RunState } from './scenarios'

const all=['coordinator1','coordinator2','coordinator3'],gws=['hamra','mar_mikhael','achrafieh']
const W=(a:number,b:number,c:number):Share[]=>[{building_id:'hamra',amps:a},{building_id:'mar_mikhael',amps:b},{building_id:'achrafieh',amps:c}]
const START:MeterConfig={meter_count:50,demand_factor:1.5},CALM=OVERLOAD.calm,PEAK=OVERLOAD.peak
const obs=(o:Partial<Observation>={}):Observation=>({at:1000,leader:'coordinator2',nodesUp:[...all],buildingsUp:[...gws],granted:90,capacity:120,quorum:true,stale:false,postgresUp:true,policy:'first_come',meters:{...START},wants:W(100,100,100),reserved:W(102,7,4),...o})
const meters=(c:MeterConfig):Command=>({kind:'meters',meter_count:c.meter_count,demand_factor:c.demand_factor})
const policy=(p:Policy):Command=>({kind:'policy',policy:p})

/** Drives the pure machine one fresh observation at a time. Every observation is stamped with the simulated clock. */
function drive(chosen:Policy,first:Partial<Observation>={}){
 const b=begin(overload,obs(first),1000,{policy:chosen})
 const sim={run:b.run,now:1000,first:b.commands,
  tick(ms:number,o:Partial<Observation>={}){sim.now+=ms;const x=advance(sim.run,obs({at:sim.now,...o}),sim.now);sim.run=x.run;return x.commands},
  /** Advance to the start of the observation window of step 3 (200 meters). */
  toPeak(){sim.tick(1000);sim.tick(1000,{policy:chosen});sim.tick(1000,{policy:chosen,meters:CALM});sim.tick(15000,{policy:chosen,meters:CALM});sim.tick(1000,{policy:chosen,meters:CALM});return sim.run.step}}
 return sim
}

describe('catalogue',()=>{
 it('keeps the four service scenarios as cards and adds Overload only to the machine catalogue',()=>{
  expect(scenarios.map(s=>s.id)).toEqual(['leader-failover','majority-loss','gateway-crash','database-outage'])
  expect(catalogue.map(s=>s.id)).toEqual(['leader-failover','majority-loss','gateway-crash','database-outage','overload'])
  expect(overload.steps).toHaveLength(5)
 })
})

describe('overload: remember, then change, then restore',()=>{
 it('logs the chosen policy and issues no command before the starting setup is observed',()=>{
  const sim=drive('fair_share')
  expect(sim.first).toEqual([]);expect(sim.run.log[0]).toContain('Started Overload with Fair sharing')
  expect(sim.tick(1000,{policy:null})).toEqual([]) // policy unknown
  expect(sim.tick(1000,{meters:null})).toEqual([]) // meter setup unknown
  expect(sim.tick(1000,{stale:true})).toEqual([])
  expect(sim.tick(1000,{quorum:false})).toEqual([])
  expect(sim.tick(1000,{leader:null})).toEqual([])
  expect(sim.run.step).toBe(0);expect(sim.run.snapshot).toBeUndefined();expect(hasPending(sim.run)).toBe(false)
 })
 it('remembers the setup from the observation that satisfied the first step, then applies the chosen policy',()=>{
  const sim=drive('fair_share')
  expect(sim.tick(1000)).toEqual([policy('fair_share')])
  expect(sim.run.snapshot).toEqual({meters:START,policy:'first_come'})
  expect(sim.run.touched).toEqual({meters:false,policy:true})
  // later observations never overwrite what was remembered
  sim.tick(1000,{meters:CALM,policy:'fair_share'});expect(sim.run.snapshot).toEqual({meters:START,policy:'first_come'})
 })
 it('does not copy extra fields of the observed meter setup into the snapshot',()=>{
  const sim=drive('fair_share',{meters:{meter_count:10,demand_factor:0.5,mqtt_connected:true} as MeterConfig})
  sim.tick(1000,{meters:{meter_count:10,demand_factor:0.5,mqtt_connected:true} as MeterConfig})
  expect(sim.run.snapshot?.meters).toEqual({meter_count:10,demand_factor:0.5})
 })
 it('waits for the policy to be observed, then sets 10 meters and observes for 15 s',()=>{
  const sim=drive('fair_share');sim.tick(1000)
  expect(sim.tick(1000,{policy:'first_come'})).toEqual([]);expect(sim.run.step).toBe(1)
  expect(sim.tick(1000,{policy:'fair_share'})).toEqual([meters(CALM)]);expect(sim.run.step).toBe(2)
  expect(sim.run.touched).toEqual({meters:true,policy:true})
  expect(sim.tick(1000,{policy:'fair_share'})).toEqual([]) // meters not yet at 10: no progress, no window
  expect(dwellProgress(sim.run,sim.now)).toBeNull()
  sim.tick(1000,{policy:'fair_share',meters:CALM})
  expect(dwellProgress(sim.run,sim.now)).toEqual({elapsedMs:0,totalMs:OVERLOAD.calmMs})
  sim.tick(14000,{policy:'fair_share',meters:CALM})
  expect(sim.run.step).toBe(2);expect(dwellProgress(sim.run,sim.now)).toEqual({elapsedMs:14000,totalMs:15000})
  expect(sim.tick(1000,{policy:'fair_share',meters:CALM})).toEqual([meters(PEAK)])
  expect(sim.run.step).toBe(3)
 })
 it('restarts the observation window when the evidence is interrupted by a stale or different observation',()=>{
  const sim=drive('first_come');sim.tick(1000);sim.tick(1000);sim.tick(1000,{meters:CALM})
  sim.tick(5000,{meters:CALM});expect(dwellProgress(sim.run,sim.now)?.elapsedMs).toBe(5000)
  sim.tick(1000,{stale:true,meters:CALM});expect(dwellProgress(sim.run,sim.now)).toBeNull()
  sim.tick(1000,{meters:CALM});expect(dwellProgress(sim.run,sim.now)?.elapsedMs).toBe(0)
  sim.tick(5000,{meters:START});expect(dwellProgress(sim.run,sim.now)).toBeNull()
  sim.tick(1000,{meters:CALM})
  sim.tick(14999,{meters:CALM});expect(sim.run.step).toBe(2)
  sim.tick(1,{meters:CALM});expect(sim.run.step).toBe(3)
 })
 it('observes the 200-meter overload for 25 s and records the fairness picture, final only when the window completes',()=>{
  const sim=drive('first_come');expect(sim.toPeak()).toBe(3)
  sim.tick(1000,{meters:PEAK,reserved:W(102,7,4),granted:113})
  expect(sim.run.captured).toMatchObject({policy:'first_come',reserved:113,wanted:300,capacity:120,final:false})
  expect(sim.run.captured?.fairness).toBeCloseTo(12769/31407,10)
  sim.tick(24000,{meters:PEAK,reserved:W(40,40,40),granted:120})
  expect(sim.run.step).toBe(3);expect(sim.run.captured).toMatchObject({final:false,reserved:120})
  expect(dwellProgress(sim.run,sim.now)).toEqual({elapsedMs:24000,totalMs:OVERLOAD.peakMs})
  const commands=sim.tick(1000,{meters:PEAK,reserved:W(40,40,40),granted:120})
  expect(sim.run.captured).toMatchObject({final:true,fairness:1,reserved:120,wanted:300})
  expect(sim.run.step).toBe(4);expect(commands).toEqual([meters(START),policy('first_come')])
 })
 it('does not complete the restore step on an observation that is not clearly newer than the restore command',()=>{
  const sim=drive('fair_share');sim.toPeak()
  sim.tick(1000,{policy:'fair_share',meters:PEAK});sim.tick(25000,{policy:'fair_share',meters:PEAK})
  expect(sim.run.step).toBe(4)
  // the starting setup is already visible, but the observation is not clearly newer than the restore command: keep re-emitting
  expect(sim.tick(1000,{meters:START,policy:'first_come'})).toEqual([meters(START),policy('first_come')])
  expect(sim.run.status).toBe('running')
  expect(sim.tick(1000,{stale:true,meters:START,policy:'first_come'})).toEqual([meters(START),policy('first_come')]) // keeps re-emitting
  expect(sim.run.status).toBe('running')
  expect(sim.tick(600,{meters:START,policy:'first_come'})).toEqual([])
  expect(sim.run.status).toBe('done');expect(hasPending(sim.run)).toBe(false);expect(sim.run.touched).toEqual({meters:false,policy:false})
  expect(sim.tick(1000,{meters:PEAK})).toEqual([]) // done stays done, no further commands
 })
 it('re-emits restore commands every tick while the restore step is not yet observed',()=>{
  const sim=drive('fair_share');sim.toPeak()
  sim.tick(1000,{policy:'fair_share',meters:PEAK});sim.tick(25000,{policy:'fair_share',meters:PEAK})
  expect(sim.tick(1000,{policy:'fair_share',meters:PEAK})).toEqual([meters(START),policy('first_come')])
  expect(sim.tick(1000,{policy:'fair_share',meters:PEAK})).toEqual([meters(START),policy('first_come')])
  expect(sim.tick(1000,{policy:'first_come',meters:PEAK})).toEqual([meters(START),policy('first_come')]) // policy back, meters not: still not complete
  expect(sim.run.status).toBe('running')
 })
 it('completes cleanly end to end with the starting setup restored',()=>{
  const sim=drive('fair_share');sim.toPeak()
  sim.tick(1000,{policy:'fair_share',meters:PEAK});sim.tick(25000,{policy:'fair_share',meters:PEAK})
  sim.tick(3000,{policy:'first_come',meters:START})
  expect(sim.run.status).toBe('done');expect(sim.run.log.at(-1)).toContain('Scenario complete')
 })
})

describe('overload: restoration on cancel and timeout',()=>{
 const midWindow=(chosen:Policy)=>{const sim=drive(chosen);sim.toPeak();sim.tick(1000,{policy:chosen,meters:PEAK});return sim}
 it('cancel restores the starting meters and policy, re-emitting until each is observed back',()=>{
  const sim=midWindow('fair_share')
  sim.run=cancelRun(sim.run,sim.now);expect(sim.run.status).toBe('cancelled')
  expect(sim.tick(100,{policy:'fair_share',meters:PEAK})).toEqual([meters(START),policy('first_come')])
  // stale observations prove nothing, even if they show the starting values
  expect(sim.tick(3000,{stale:true,meters:START,policy:'first_come'})).toEqual([meters(START),policy('first_come')])
  // an observation not clearly newer than the restore command proves nothing either
  const t=sim.run.stepStartedAt
  expect(advance(sim.run,obs({at:t+2499,meters:START,policy:'first_come'}),t+2499).commands).toEqual([meters(START),policy('first_come')])
  // meters back, policy not yet: only the policy is re-sent
  expect(sim.tick(3000,{meters:START,policy:'fair_share'})).toEqual([policy('first_come')])
  expect(sim.run.touched).toEqual({meters:false,policy:true});expect(sim.run.status).toBe('cancelled')
  expect(sim.run.log.at(-1)).toContain('meter setup restored')
  expect(sim.tick(1000,{meters:START,policy:'first_come'})).toEqual([])
  expect(hasPending(sim.run)).toBe(false);expect(sim.run.status).toBe('cancelled')
 })
 it('cancel while the meters were changed but the policy already equals the starting policy still confirms both',()=>{
  const sim=midWindow('first_come')
  sim.run=cancelRun(sim.run,sim.now)
  expect(sim.tick(3000,{meters:PEAK,policy:'first_come'})).toEqual([meters(START)]) // policy already back, meters not
  expect(sim.run.touched).toEqual({meters:true,policy:false})
  expect(sim.tick(1000,{meters:START,policy:'first_come'})).toEqual([]);expect(hasPending(sim.run)).toBe(false)
 })
 it('cancelling a second time changes nothing',()=>{const sim=midWindow('fair_share');sim.run=cancelRun(sim.run,sim.now);const again=cancelRun(sim.run,sim.now+1);expect(again).toBe(sim.run)})
 it('timeout while observing the overload restores meters and policy',()=>{
  const sim=drive('fair_share');sim.toPeak()
  const stepStart=sim.run.stepStartedAt,limit=overload.steps[3].timeoutMs
  const t=advance(sim.run,obs({at:stepStart+limit,policy:'fair_share',meters:START}),stepStart+limit) // meters never reached 200
  expect(t.run.status).toBe('timeout');expect(t.commands).toEqual([meters(START),policy('first_come')])
  expect(t.run.log.at(-1)).toContain('Timed out after 55 s')
  const later=advance(t.run,obs({at:t.run.stepStartedAt+5000,meters:CALM,policy:'fair_share'}),t.run.stepStartedAt+5000)
  expect(later.commands).toEqual([meters(START),policy('first_come')]);expect(later.run.status).toBe('timeout')
  const ok=advance(later.run,obs({at:t.run.stepStartedAt+9000,meters:START,policy:'first_come'}),t.run.stepStartedAt+9000)
  expect(ok.commands).toEqual([]);expect(hasPending(ok.run)).toBe(false)
 })
 it('timeout before the meters were touched restores only the policy',()=>{
  const sim=drive('fair_share');sim.tick(1000)
  const start=sim.run.stepStartedAt,t=advance(sim.run,obs({at:start+20000,policy:'first_come'}),start+20000)
  expect(t.run.status).toBe('timeout');expect(t.commands).toEqual([policy('first_come')]);expect(t.run.touched).toEqual({meters:false,policy:true})
 })
 it('timeout before anything was remembered or changed issues nothing and leaves nothing pending',()=>{
  const sim=drive('fair_share'),t=advance(sim.run,obs({at:21000,policy:null}),21000)
  expect(t.run.status).toBe('timeout');expect(t.commands).toEqual([]);expect(hasPending(t.run)).toBe(false)
 })
 it('never issues a meter or policy change without a remembered starting point',()=>{
  const sim=drive('fair_share');sim.tick(1000)
  const noSnapshot:RunState={...sim.run};delete noSnapshot.snapshot;delete noSnapshot.touched
  const x=advance(noSnapshot,obs({at:5000,policy:'fair_share'}),5000)
  expect(x.run.step).toBe(2);expect(x.commands).toEqual([]);expect(x.run.log.at(-1)).toContain('command not issued');expect(hasPending(x.run)).toBe(false)
 })
 it('restores services and settings together, confirming each independently',()=>{
  const run:RunState={id:'overload',step:3,startedAt:0,stepStartedAt:0,stopped:['coordinator2'],status:'cancelled',log:[],snapshot:{meters:START,policy:'first_come'},touched:{meters:true,policy:true}}
  expect(advance(run,obs({at:1000}),1000).commands).toEqual([{service:'coordinator2',action:'start'},meters(START),policy('first_come')])
  const x=advance(run,obs({at:3000,nodesUp:all,meters:PEAK,policy:'fair_share'}),3000)
  expect(x.commands).toEqual([meters(START),policy('first_come')]);expect(x.run.stopped).toEqual([])
 })
 it('a restoring run becomes done only when services, meters and policy are all observed back',()=>{
  const run:RunState={id:'overload',step:4,startedAt:0,stepStartedAt:0,stopped:[],status:'restoring',log:[],snapshot:{meters:START,policy:'first_come'},touched:{meters:true,policy:true}}
  const half=advance(run,obs({at:3000,meters:START,policy:'fair_share'}),3000)
  expect(half.run.status).toBe('restoring');expect(half.commands).toEqual([policy('first_come')])
  expect(advance(half.run,obs({at:4000,meters:START,policy:'first_come'}),4000).run.status).toBe('done')
 })
})

describe('command helpers',()=>{
 const stop:Command={service:'coordinator1',action:'stop'},start:Command={service:'coordinator1',action:'start'}
 it('tells service commands from setting commands',()=>{expect(isService(stop)).toBe(true);expect(isService(meters(PEAK))).toBe(false);expect(isService(policy('fair_share'))).toBe(false)})
 it('gives each distinct command its own key, including the values of a setting',()=>{
  const keys=[stop,start,meters(PEAK),meters(CALM),policy('fair_share'),policy('first_come')].map(commandKey)
  expect(new Set(keys).size).toBe(keys.length);expect(commandKey(meters(PEAK))).toBe(commandKey(meters({...PEAK})))
 })
 it('classifies stress commands (what a cancel must drop) apart from restores',()=>{
  const run:RunState={id:'overload',step:3,startedAt:0,stepStartedAt:0,stopped:[],status:'running',log:[],snapshot:{meters:START,policy:'first_come'}}
  expect(isStress(stop,run)).toBe(true);expect(isStress(start,run)).toBe(false)
  expect(isStress(meters(PEAK),run)).toBe(true);expect(isStress(meters(START),run)).toBe(false)
  expect(isStress(policy('fair_share'),run)).toBe(true);expect(isStress(policy('first_come'),run)).toBe(false)
  expect(isStress(meters(START),null)).toBe(true) // with nothing remembered, no setting change counts as a restore
  expect(isStress(policy('first_come'),{...run,snapshot:undefined})).toBe(true)
 })
 it('compares meter setups with a tolerance on the demand factor',()=>{
  expect(sameMeters({meter_count:10,demand_factor:1},{meter_count:10,demand_factor:1.0000001})).toBe(true)
  expect(sameMeters({meter_count:10,demand_factor:1},{meter_count:10,demand_factor:1.1})).toBe(false)
  expect(sameMeters({meter_count:10,demand_factor:1},{meter_count:11,demand_factor:1})).toBe(false)
  expect(sameMeters(null,CALM)).toBe(false);expect(sameMeters(CALM,undefined)).toBe(false)
 })
 it('lists restore commands for stopped services and touched settings only',()=>{
  const base:RunState={id:'overload',step:0,startedAt:0,stepStartedAt:0,stopped:[],status:'running',log:[]}
  expect(restoreCommands(base)).toEqual([]);expect(hasPending(base)).toBe(false)
  const full={...base,stopped:['postgres'],snapshot:{meters:START,policy:'first_come' as Policy},touched:{meters:true,policy:false}}
  expect(restoreCommands(full)).toEqual([{service:'postgres',action:'start'},meters(START)]);expect(hasPending(full)).toBe(true)
  expect(restoreCommands({...full,touched:{meters:false,policy:true}})).toEqual([{service:'postgres',action:'start'},policy('first_come')])
  expect(hasPending({...base,touched:{meters:false,policy:true}})).toBe(true)
 })
 it('maps every command to the documented HTTP request',()=>{
  expect(commandRequest(stop)).toEqual({path:'/api/actions',body:{service:'coordinator1',action:'stop'}})
  expect(commandRequest(meters(PEAK))).toEqual({path:'/api/meters/config',body:{meter_count:200,demand_factor:1}})
  expect(commandRequest(policy('fair_share'))).toEqual({path:'/api/policy',body:{policy:'fair_share'}})
  expect(commandRequest(policy('first_come'))).toEqual({path:'/api/policy',body:{policy:'first_come'}})
 })
 it('captures the fairness picture of an observation',()=>{
  expect(capture(obs({at:7,policy:'fair_share',reserved:W(40,40,40),granted:120}))).toEqual({at:7,policy:'fair_share',fairness:1,reserved:120,wanted:300,capacity:120,final:false})
  expect(capture(obs({policy:undefined,wants:undefined}),true)).toMatchObject({policy:null,fairness:null,wanted:0,final:true})
 })
 it('reports no dwell progress outside a running observation window',()=>{
  const sim=drive('fair_share');expect(dwellProgress(sim.run,sim.now)).toBeNull()
  expect(dwellProgress({...sim.run,status:'cancelled',matchedAt:1000},2000)).toBeNull()
 })
})
