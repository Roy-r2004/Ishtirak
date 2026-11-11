import { useEffect, useRef, useState } from 'react'
import { SPRING, springStep, type Spring } from './dial'

const QUERY = '(prefers-reduced-motion: reduce)'
/** True while the person has asked their system for less motion. Follows changes live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(QUERY).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(QUERY), on = () => setReduced(mq.matches)
    on(); mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * Drives `apply(position)` every animation frame with a damped spring toward `target`, and stops the loop when the value has settled.
 * With reduced motion the position jumps straight to the target. `apply` writes to the DOM directly so React never re-renders at frame rate.
 * This is the only animation that runs on its own, and only while a reading is changing.
 */
export function useSpring(target: number, apply: (position: number) => void, reduced: boolean, params = SPRING) {
  const state = useRef<Spring>({ pos: 0, vel: 0 }), goal = useRef(target), raf = useRef(0), applyRef = useRef(apply), lastFrame = useRef(0)
  goal.current = target; applyRef.current = apply
  useEffect(() => {
    cancelAnimationFrame(raf.current)
    const frame = (now: number) => {
      const dt = lastFrame.current ? (now - lastFrame.current) / 1000 : 1 / 60
      lastFrame.current = now
      state.current = reduced ? { pos: goal.current, vel: 0 } : springStep(state.current, goal.current, dt, params)
      applyRef.current(state.current.pos)
      if (state.current.pos !== goal.current || state.current.vel !== 0) raf.current = requestAnimationFrame(frame)
      else lastFrame.current = 0
    }
    lastFrame.current = 0
    raf.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf.current)
  }, [target, reduced])
}

/** The pixel size of an element, kept current. Charts are drawn at this size so their text is never stretched. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null), [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize(prev => { const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight); return prev.width === w && prev.height === h ? prev : { width: w, height: h } })
    read()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}
