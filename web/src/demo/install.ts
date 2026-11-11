import { useSyncExternalStore } from 'react'
import { createSimulator, type Result, type Simulator } from './simulator'

/**
 * Demo mode: replaces fetch and WebSocket for the dashboard's own API paths with the in-browser simulator, so the
 * unchanged UI code runs on it. Nothing here runs in real mode unless the backend cannot be reached for 3 seconds.
 */
const nativeFetch: typeof fetch | null = typeof fetch === 'function' ? fetch.bind(globalThis) : null
const NativeWebSocket: typeof WebSocket | null = typeof WebSocket === 'function' ? WebSocket : null
const NODE_SOCKET = /\/nodes\/(coordinator[123])\/api\/ws$/
const LATENCY_MS = 40
const SOCKET_MS = 1000
const TICK_MS = 250

let sim: Simulator | null = null
let active = false
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

export const isDemoActive = () => active
export function subscribeDemo(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
/** True once the board runs on simulated data; drives the permanent "Simulated data" plate. */
export const useDemoActive = () => useSyncExternalStore(subscribeDemo, isDemoActive, () => false)
export const getSimulator = () => sim

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const abortError = (signal?: AbortSignal | null) => signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return }
    const onAbort = () => { clearTimeout(t); reject(abortError(signal)) }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body !== undefined ? init.body : typeof Request !== 'undefined' && input instanceof Request ? await input.clone().text() : undefined
  if (typeof raw !== 'string' || raw === '') return undefined
  return JSON.parse(raw)
}
const reply = (result: Result) => result.ok ? json({ status: 'ok' }) : json({ error: result.error }, 400)

async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  // Resolved against a fixed http base: against a file:// page, "/api/x" would become "/D:/api/x" and miss the demo routes.
  let path: string
  try { path = new URL(url, 'http://localhost/').pathname } catch { path = url }
  if (!path.startsWith('/api/') || !sim) return nativeFetch ? nativeFetch(input, init) : Promise.reject(new TypeError('Failed to fetch'))
  const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
  await wait(LATENCY_MS, init?.signal)
  if (path === '/api/overview') return method === 'GET' ? json(sim.overview()) : json({ error: 'method not allowed' }, 405)
  if (path === '/api/actions' || path === '/api/meters/config' || path === '/api/policy') {
    if (method !== 'POST') return json({ error: 'method not allowed' }, 405)
    let body: Record<string, unknown>
    try { body = ((await readBody(input, init)) ?? {}) as Record<string, unknown> } catch { return json({ error: 'request body is not valid JSON' }, 400) }
    if (body === null || typeof body !== 'object') return json({ error: 'request body must be a JSON object' }, 400)
    if (path === '/api/actions') return reply(sim.act(String(body.service), String(body.action)))
    if (path === '/api/policy') return reply(sim.setPolicy(body.policy))
    return reply(sim.setMeters({ meter_count: body.meter_count, demand_factor: body.demand_factor }))
  }
  return json({ error: `unknown route ${path}` }, 404)
}

const emit = (target: EventTarget & Record<string, unknown>, type: string, event: Event) => {
  target.dispatchEvent(event)
  const handler = target['on' + type]
  if (typeof handler === 'function') (handler as (e: Event) => void).call(target, event)
}

/** A coordinator's `/api/ws`: sends that node's state every second while it leads, and closes when it stops or loses leadership. */
export class DemoWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  readonly url: string
  readonly protocol = ''
  readonly extensions = ''
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  private readonly nodeId: string
  private interval: ReturnType<typeof setInterval> | undefined
  private opener: ReturnType<typeof setTimeout> | undefined
  constructor(url: string | URL) {
    super()
    this.url = String(url)
    // Matched on the raw string: from a file:// page the URL is "ws:///nodes/..." and a parsed pathname would lose "/nodes".
    this.nodeId = NODE_SOCKET.exec(this.url)?.[1] ?? ''
    this.opener = setTimeout(() => this.open(), LATENCY_MS)
  }
  private self() { return this as unknown as EventTarget & Record<string, unknown> }
  private open() {
    if (this.readyState !== DemoWebSocket.CONNECTING) return
    if (!sim || sim.leaderId() !== this.nodeId) { emit(this.self(), 'error', new Event('error')); this.finish(1011, 'not the leader'); return }
    this.readyState = DemoWebSocket.OPEN
    emit(this.self(), 'open', new Event('open'))
    this.push()
    this.interval = setInterval(() => this.push(), SOCKET_MS)
  }
  private push() {
    if (this.readyState !== DemoWebSocket.OPEN) return
    const data = sim && sim.leaderId() === this.nodeId ? sim.node(this.nodeId) : null
    if (!data) { this.finish(1001, 'leadership ended'); return }
    emit(this.self(), 'message', new MessageEvent('message', { data: JSON.stringify(data) }))
  }
  private finish(code: number, reason: string) {
    if (this.readyState === DemoWebSocket.CLOSED) return
    clearInterval(this.interval); clearTimeout(this.opener)
    this.readyState = DemoWebSocket.CLOSED
    const event = typeof CloseEvent === 'function' ? new CloseEvent('close', { code, reason, wasClean: code === 1000 }) : Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 })
    emit(this.self(), 'close', event)
  }
  send() { if (this.readyState !== DemoWebSocket.OPEN) throw new DOMException('The socket is not open.', 'InvalidStateError') }
  close(code = 1000, reason = '') { if (this.readyState === DemoWebSocket.CLOSED || this.readyState === DemoWebSocket.CLOSING) return; this.readyState = DemoWebSocket.CLOSING; this.finish(code, reason) }
}

/** Switch the page to the simulator. Idempotent. */
export function installDemo(): void {
  if (active) return
  sim = createSimulator({})
  active = true
  globalThis.fetch = demoFetch as typeof fetch
  if (NativeWebSocket) {
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args: [string | URL, (string | string[])?]) {
        const url = String(args[0])
        return NODE_SOCKET.test(url) ? new DemoWebSocket(url) as unknown as WebSocket : Reflect.construct(target, args)
      },
    })
  }
  let last = performance.now()
  timer = setInterval(() => { const now = performance.now(); sim?.tick(now - last); last = now }, TICK_MS)
  listeners.forEach(listener => listener())
}

/** Stop the simulator clock and restore fetch and WebSocket (tests only; the app never leaves demo mode). */
export function uninstallDemo(): void {
  if (!active) return
  clearInterval(timer)
  if (nativeFetch) globalThis.fetch = nativeFetch
  if (NativeWebSocket) globalThis.WebSocket = NativeWebSocket
  sim = null; active = false
  listeners.forEach(listener => listener())
}

const forced = () => (typeof __PREVIEW__ !== 'undefined' && __PREVIEW__) || /(^|[?&])demo=1(&|$)/.test(globalThis.location?.search ?? '')

/**
 * Called once before the app renders. Demo mode starts at once when forced (preview build or `?demo=1`); otherwise the real
 * `/api/overview` gets 3 seconds to answer with data and the board falls back to the simulator if it does not.
 */
export function bootDemo(): void {
  if (forced()) { installDemo(); return }
  void (async () => {
    try {
      if (!nativeFetch) throw new Error('no fetch')
      const response = await nativeFetch('/api/overview', { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body?.nodes)) throw new Error('not an overview')
    } catch { installDemo() }
  })()
}
