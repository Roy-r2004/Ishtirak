import type { Point } from '../data'

export type Range = 30 | 90
/** Finite, time-ordered samples, at most the last `range` of them. Nothing is invented: an empty history stays empty. */
export function visibleSamples(points: Point[], range: Range): Point[] {
  return points
    .filter(p => Number.isFinite(p.at) && Number.isFinite(p.demand) && Number.isFinite(p.served) && Number.isFinite(p.granted))
    .slice().sort((a, b) => a.at - b.at)
    .slice(-90).slice(-range)
}

/** Top of the y axis: the next multiple of `step` above the data and the capacity line, so the red limit never touches the edge. */
export function niceMax(values: number[], capacity: number | null, step = 20): number {
  const top = Math.max(1, capacity !== null && Number.isFinite(capacity) ? capacity : 0, ...values.filter(Number.isFinite))
  return Math.ceil((top * 1.05) / step) * step
}
export function yTicks(max: number, step = 20): number[] {
  const out: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v)
  return out
}
export const scale = (v: number, d0: number, d1: number, r0: number, r1: number) => d1 === d0 ? (r0 + r1) / 2 : r0 + (v - d0) / (d1 - d0) * (r1 - r0)

const f = (n: number) => Math.round(n * 10) / 10
/** Pen trace through the samples: a plain polyline, or a stepped one (a pen that holds its value until the next sample). */
export function tracePath(xs: number[], ys: number[], stepped = false): string {
  if (!xs.length) return ''
  let d = `M${f(xs[0])} ${f(ys[0])}`
  for (let i = 1; i < xs.length; i++) d += stepped ? `H${f(xs[i])}V${f(ys[i])}` : `L${f(xs[i])} ${f(ys[i])}`
  return d
}
/** Index of the sample whose x is closest to `x`; -1 when there are none. */
export function nearestIndex(xs: number[], x: number): number {
  let best = -1, gap = Infinity
  xs.forEach((v, i) => { const d = Math.abs(v - x); if (d < gap) { gap = d; best = i } })
  return best
}
