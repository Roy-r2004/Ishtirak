import { describe, expect, it } from 'vitest'
import { advance, begin, cancelRun, deriveTimeline, proof, scenarios, type Observation, type RunState } from './scenarios'

const all=['coordinator1','coordinator2','coordinator3'],gws=['hamra','mar_mikhael','achrafieh']
const obs=(o:Partial<Observation>={}):Observation=>({at:1000,leader:'coordinator2',nodesUp:[...all],buildingsUp:[...gws],granted:90,capacity:120,quorum:true,stale:false,postgresUp:true,...o})
const scenario=(id:string)=>scenarios.find(s=>s.id===id)!
const running=(id:string,o:Observation,now=1000)=>begin(scenario(id),o,now)

describe('scenarios catalogue',()=>{
 it('exposes the four planned scenarios',()=>{expect(scenarios.map(s=>s.id)).toEqual(['leader-failover','majority-loss','gateway-crash','database-outage'])})
})

describe('advance',()=>{
 it('waits for a verified leader and issues no command before it',()=>{
  const {run,commands}=running('leader-failover',obs({stale:true,leader:null}))
  expect(commands).toEqual([])
  const next=advance(run,obs({stale:true,leader:null,at:2000}),2000)
  expect(next.run.step).toBe(0);expect(next.commands).toEqual([])
 })
 it('stops the leader observed when the step starts, not a stale id',()=>{
  const first=running('leader-failover',obs({leader:'coordinator1'}))
  // leader changed to coordinator3 before the stop step began
  const second=advance(first.run,obs({leader:'coordinator3',at:2000}),2000)
  expect(second.run.step).toBe(1)
  expect(second.commands).toEqual([{service:'coordinator3',action:'stop'}])
  expect(second.run.stopped).toEqual(['coordinator3'])
 })
 it('does not advance on a stale observation even when the predicate would hold',()=>{
  const first=running('leader-failover',obs())
  const second=advance(first.run,obs({stale:true,at:2000}),2000)
  expect(second.run.step).toBe(0)
 })
 it('advances through failover and finishes done with nothing left stopped',()=>{
  let r=running('leader-failover',obs()).run,now=1000
  const step=(o:Observation)=>{now+=1000;const x=advance(r,o,now);r=x.run;return x.commands}
  expect(step(obs())).toEqual([{service:'coordinator2',action:'stop'}])
  expect(step(obs({leader:'coordinator2'}))).toEqual([]) // still observed healthy: no progress
  expect(r.step).toBe(1)
  expect(step(obs({leader:'coordinator1',nodesUp:['coordinator1','coordinator3']}))).toEqual([{service:'coordinator2',action:'start'}])
  expect(r.stopped).toEqual([])
  step(obs());expect(r.status).toBe('done')
  expect(step(obs())).toEqual([])
 })
 it('times out, restores every stopped service, and keeps retrying until observed up',()=>{
  const first=running('leader-failover',obs())
  const stopped=advance(first.run,obs(),2000)
  const lateObs=obs({nodesUp:['coordinator1','coordinator3'],leader:'coordinator1'})
  const timeoutMs=scenario('leader-failover').steps[1].timeoutMs
  const t=advance({...stopped.run,step:1,stepStartedAt:2000},obs({nodesUp:[...all]}),2000+timeoutMs+1)
  expect(t.run.status).toBe('timeout')
  expect(t.commands).toEqual([{service:'coordinator2',action:'start'}])
  const still=advance(t.run,lateObs,t.run.stepStartedAt+5000)
  expect(still.run.status).toBe('timeout')
  expect(still.commands).toEqual([{service:'coordinator2',action:'start'}])
  expect(still.run.stopped).toEqual(['coordinator2'])
  const ok=advance(still.run,obs({at:t.run.stepStartedAt+9000}),t.run.stepStartedAt+9000)
  expect(ok.commands).toEqual([])
  expect(ok.run.stopped).toEqual([])
 })
 it('does not treat a stale observation as proof that a restored service is up',()=>{
  const r:RunState={id:'majority-loss',step:2,startedAt:0,stepStartedAt:0,stopped:['coordinator1','coordinator2'],status:'cancelled',log:[]}
  const x=advance(r,obs({stale:true}),5000)
  expect(x.run.stopped).toEqual(['coordinator1','coordinator2'])
  expect(x.commands).toEqual([{service:'coordinator1',action:'start'},{service:'coordinator2',action:'start'}])
 })
 it('cancel restores all stopped services',()=>{
  const a=running('majority-loss',obs())
  const b=advance(a.run,obs(),2000) // stop leader
  expect(b.run.stopped).toEqual(['coordinator2'])
  const c=advance(cancelRun(b.run,3000),obs({nodesUp:['coordinator1','coordinator3'],leader:'coordinator1'}),3100)
  expect(c.run.status).toBe('cancelled')
  expect(c.commands).toEqual([{service:'coordinator2',action:'start'}])
  expect(cancelRun(c.run,4000).status).toBe('cancelled')
 })
 it('a gateway crash scenario stops and restarts the named gateway',()=>{
  let r=running('gateway-crash',obs()).run
  const a=advance(r,obs(),2000);r=a.run
  expect(a.commands).toEqual([{service:'gateway-hamra',action:'stop'}])
  const b=advance(r,obs({buildingsUp:['mar_mikhael','achrafieh']}),3000)
  expect(b.commands).toEqual([{service:'gateway-hamra',action:'start'}])
  expect(b.run.stopped).toEqual([])
 })
 it('database outage needs postgres observed up before stopping it, and observed down before restarting it',()=>{
  const unknown=running('database-outage',obs({postgresUp:undefined}))
  expect(advance(unknown.run,obs({postgresUp:undefined}),2000).run.step).toBe(0)
  const a=advance(unknown.run,obs(),2000)
  expect(a.commands).toEqual([{service:'postgres',action:'stop'}])
  expect(advance(a.run,obs(),3000).commands).toEqual([])
  expect(advance(a.run,obs({postgresUp:false}),3000).commands).toEqual([{service:'postgres',action:'start'}])
 })
 it('majority-loss never stops a second coordinator before the first stop is observed',()=>{
  const a=advance(running('majority-loss',obs()).run,obs(),2000)
  expect(a.commands).toEqual([{service:'coordinator2',action:'stop'}])
  expect(advance(a.run,obs(),2500).commands).toEqual([])
  const b=advance(a.run,obs({nodesUp:['coordinator1','coordinator3'],leader:'coordinator1'}),3000)
  expect(b.commands).toEqual([{service:'coordinator1',action:'stop'}])
  expect(b.run.stopped.sort()).toEqual(['coordinator1','coordinator2'])
 })
})

describe('proof',()=>{
 it('ignores stale observations',()=>{
  const p=proof([obs({at:1,granted:60}),obs({at:2,granted:500,stale:true}),obs({at:3,granted:100})])
  expect(p).toEqual({peak:100,capacity:120,violations:0,samples:2,observedSince:1})
 })
 it('counts a granted>capacity sample as a violation',()=>{
  const p=proof([obs({at:1,granted:60}),obs({at:2,granted:121})])
  expect(p.violations).toBe(1);expect(p.peak).toBe(121)
 })
 it('reports no proof for an empty or all-stale history',()=>{
  const none={peak:0,capacity:0,violations:0,samples:0,observedSince:null}
  expect(proof([])).toEqual(none)
  expect(proof([obs({stale:true})])).toEqual(none)
 })
})

describe('deriveTimeline',()=>{
 it('yields leader_elected after leader_lost',()=>{
  const lost=deriveTimeline(obs({leader:'coordinator2'}),obs({leader:null,nodesUp:['coordinator1','coordinator3'],at:2000}))
  const elected=deriveTimeline(obs({leader:null,nodesUp:['coordinator1','coordinator3']}),obs({leader:'coordinator1',nodesUp:['coordinator1','coordinator3'],at:3000}))
  expect(lost.map(e=>e.kind)).toEqual(['node_down','leader_lost'])
  expect(elected.map(e=>e.kind)).toEqual(['leader_elected'])
  expect(elected[0].detail).toContain('coordinator1')
  expect(lost[0].at).toBeLessThan(elected[0].at)
 })
 it('reports a direct leader change as lost then elected',()=>{
  expect(deriveTimeline(obs({leader:'coordinator1'}),obs({leader:'coordinator3',at:2000})).map(e=>e.kind)).toEqual(['leader_lost','leader_elected'])
 })
 it('reports quorum transitions and gateway/node returns',()=>{
  const down=deriveTimeline(obs(),obs({quorum:false,nodesUp:['coordinator1'],leader:null,buildingsUp:['hamra'],at:2000})).map(e=>e.kind)
  expect(down).toEqual(expect.arrayContaining(['node_down','leader_lost','quorum_lost']))
  expect(deriveTimeline(obs({quorum:false}),obs({at:2000})).map(e=>e.kind)).toEqual(['quorum_restored'])
  expect(deriveTimeline(obs({nodesUp:['coordinator1']}),obs({at:2000})).map(e=>e.kind)).toEqual(['node_up','node_up'])
 })
 it('derives nothing without a fresh baseline',()=>{
  expect(deriveTimeline(null,obs())).toEqual([])
  expect(deriveTimeline(obs(),obs({stale:true,leader:null}))).toEqual([])
  expect(deriveTimeline(obs({stale:true}),obs({leader:null}))).toEqual([])
  expect(deriveTimeline(obs(),obs({at:2000}))).toEqual([])
 })
})
