import { describe, expect, it } from 'vitest'
import { barPercent, barScale, fairnessScore, jain, percent, policyOf, shareRows, sumAmps, type Share } from './fairness'

const shares=(...amps:number[]):Share[]=>amps.map((a,i)=>({building_id:['hamra','mar_mikhael','achrafieh'][i],amps:a}))

describe('jain',()=>{
 it('is 1 for equal values',()=>{expect(jain([40,40,40])).toBe(1);expect(jain([7,7])).toBe(1)})
 it("matches the definition (sum x)^2 / (n * sum x^2) for an unequal split",()=>{
  // 113^2 / (3 * (102^2 + 7^2 + 4^2)) = 12769 / 31407. (The brief quoted ~0.46 for this input; the formula gives 0.41.)
  expect(jain([102,7,4])).toBeCloseTo(12769/31407,10)
  expect(jain([102,7,4])).toBeCloseTo(0.407,3)
 })
 it('is 1/n when one value takes everything',()=>{expect(jain([120,0,0])).toBeCloseTo(1/3,10);expect(jain([0,40])).toBe(0.5)})
 it('is scale-invariant',()=>{expect(jain([1,2,3])).toBeCloseTo(jain([10,20,30])!,10)})
 it('is not defined for fewer than two values, all zeros, or invalid values',()=>{
  expect(jain([])).toBeNull();expect(jain([5])).toBeNull();expect(jain([0,0,0])).toBeNull()
  expect(jain([1,-1])).toBeNull();expect(jain([1,Number.NaN])).toBeNull();expect(jain([1,Infinity])).toBeNull()
 })
})

describe('fairnessScore',()=>{
 it('is Jain over the reserved amps of buildings that want power',()=>{
  expect(fairnessScore(shares(100,100,100),shares(40,40,40))).toBe(1)
  expect(fairnessScore(shares(100,100,100),shares(102,7,4))).toBeCloseTo(12769/31407,10)
 })
 it('ignores buildings with no want, whatever they hold',()=>{
  expect(fairnessScore(shares(100,0,50),shares(60,60,60))).toBe(1)
  expect(fairnessScore(shares(100,0,50),shares(100,0,0))).toBe(0.5)
 })
 it('counts a building with a want and no lease as holding 0 A',()=>{
  expect(fairnessScore(shares(100,100),shares(80))).toBeCloseTo(0.5,10)
  expect(fairnessScore(shares(100,100),[])).toBeNull() // nobody holds anything: equal but meaningless, so n/a
 })
 it('is n/a with fewer than two buildings that want power, or when nothing was reported',()=>{
  expect(fairnessScore(shares(100,0,0),shares(60,30,30))).toBeNull()
  expect(fairnessScore(shares(0,0,0),shares(60,30,30))).toBeNull()
  expect(fairnessScore([],shares(60))).toBeNull()
  expect(fairnessScore(undefined,shares(60,30))).toBeNull()
  expect(fairnessScore(shares(10,10),undefined)).toBeNull()
 })
})

describe('percent',()=>{
 it('shows a rounded percentage, or n/a',()=>{expect(percent(1)).toBe('100%');expect(percent(12769/31407)).toBe('41%');expect(percent(0)).toBe('0%');expect(percent(null)).toBe('n/a')})
})

describe('shareRows',()=>{
 const ids=['hamra','mar_mikhael','achrafieh']
 it('joins wants, leases and fair shares per building',()=>{
  expect(shareRows(ids,shares(50,30),shares(40,30,10),shares(40,40,40))).toEqual([
   {id:'hamra',want:50,reserved:40,fair:40},
   {id:'mar_mikhael',want:30,reserved:30,fair:40},
   {id:'achrafieh',want:null,reserved:10,fair:40},
  ])
 })
 it('uses 0 A for a missing lease but null for a missing want or fair share',()=>{
  expect(shareRows(ids,shares(50),[],shares(50))[1]).toEqual({id:'mar_mikhael',want:null,reserved:0,fair:null})
 })
 it('reports unknown (null) for lists the coordinators did not send',()=>{
  expect(shareRows(ids,undefined,undefined,undefined)[0]).toEqual({id:'hamra',want:null,reserved:null,fair:null})
 })
})

describe('bars',()=>{
 const rows=shareRows(['hamra','mar_mikhael'],shares(300,20),shares(60,60),shares(60,20))
 it('scales to the largest of capacity and every shown value',()=>{expect(barScale(rows,120)).toBe(300);expect(barScale([],120)).toBe(120);expect(barScale([],0)).toBe(1)})
 it('ignores invalid capacity and null values',()=>{expect(barScale(shareRows(['hamra']),Number.NaN)).toBe(1)})
 it('turns a value into a clamped percentage of the scale',()=>{
  expect(barPercent(60,120)).toBe(50);expect(barPercent(240,120)).toBe(100);expect(barPercent(-5,120)).toBe(0);expect(barPercent(null,120)).toBe(0);expect(barPercent(5,0)).toBe(0)
 })
})

describe('helpers',()=>{
 it('reads the policy from the coordinator boolean, unknown otherwise',()=>{
  expect(policyOf(true)).toBe('fair_share');expect(policyOf(false)).toBe('first_come');expect(policyOf(undefined)).toBeNull();expect(policyOf(null)).toBeNull()
  expect(policyOf('true' as unknown as boolean)).toBeNull()
 })
 it('sums amps and tolerates a missing list',()=>{expect(sumAmps(shares(10,20,5))).toBe(35);expect(sumAmps(undefined)).toBe(0)})
})
