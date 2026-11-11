// Local mock of the Ishtirak dashboard API plus a static file server for the built app (dependency-free).
// Start:  PORT=8099 STATIC_DIR=../dist node mock/server.mjs     (log requests with MOCK_LOG=1)
// Presets: GET /__mock/state?name=<preset>, GET /__mock/state, GET /__mock/reset. All data is synthetic test data.
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CAPACITY, COORD, IDS, NAMES, PRESET_NAMES, buildState } from './states.mjs'

const PORT = Number(process.env.PORT || 8099)
const ROOT = path.resolve(process.env.STATIC_DIR || path.join(import.meta.dirname, '../dist'))
const LOG = process.env.MOCK_LOG === '1'
const SERVICES = [...COORD, 'gateway-hamra', 'gateway-mar-mikhael', 'gateway-achrafieh', 'postgres', 'mosquitto']
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

let S = buildState('healthy', Date.now())
const iso = t => new Date(t).toISOString()
const round1 = n => Math.round(n * 10) / 10
const onlineIds = () => COORD.filter(id => S.nodes[id].online)
const hasQuorum = () => !!S.leaderId && onlineIds().length >= 2

// ---- seeded noise (deterministic per key and bucket) ----
function r01(key, n) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  h ^= Math.imul(n + 1, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
function jitter(id, t) { // smooth noise in [-1, 1] changing every 4 s
  const b = Math.floor(t / 4000), f = (t % 4000) / 4000, s = f * f * (3 - 2 * f)
  const a = r01('j' + id, b), c = r01('j' + id, b + 1)
  return (a + (c - a) * s) * 2 - 1
}
function driftOf(id, t) { // reserved amps change only occasionally (healthy preset), and never in the first 25 s
  if (!S.drift) return 0
  const b = Math.floor((t - S.presetAt) / 25000)
  return b <= 0 ? 0 : Math.round(r01('d' + id, b) * 4 - 2)
}

// ---- ledger and gateway views ----
function leasesNow(t) {
  const out = []
  for (const id of IDS) {
    const tiers = S.leases[id]
    if (!tiers || !tiers.length) continue
    let d = driftOf(id, t)
    if (tiers[1] && tiers[0].amps + d <= tiers[1].amps) d = 0
    const list = tiers.map((x, i) => ({ version: x.version, amps: i === 0 ? x.amps + d : x.amps }))
    out.push({ building_id: id, amps: list[0].amps, version: list[list.length - 1].version, tiers: list })
  }
  return out
}
function nodeData(id, t) {
  const leader = S.leaderId === id, leases = leasesNow(t), granted = leases.reduce((s, l) => s + l.amps, 0), state = leader ? 'Leader' : 'Follower'
  return {
    node_id: id, state, leader_id: S.leaderId || '', quorum: hasQuorum(), capacity_amps: CAPACITY, granted_amps: granted, available_amps: Math.max(0, CAPACITY - granted),
    leases, audit: S.audit.slice(-100), postgres_connected: S.postgres,
    raft: { state, term: String(S.term), applied_index: String(S.applied), last_log_index: String(S.lastLog), commit_index: String(S.applied), last_snapshot_index: '0', leader: S.leaderId || '' },
    quorum_verified_at: iso(S.quorumVerifiedAt), fair_share: S.policyFair, wants: S.wants, fair_shares: S.fairShares,
  }
}
function splitMeters(n) { const base = Math.floor(n / 3), rem = n % 3; return IDS.map((_, i) => base + (i < rem ? 1 : 0)) }
function remainingFor(id, i, t) {
  if (S.quorumLostAt !== null) return Math.max(0, (S.remainingAtLoss[id] ?? 12000) - (t - S.quorumLostAt)) // no renewals without a majority
  return 12000 - ((t + i * 1000) % 3000) // renewed every 3 s
}
function buildingSource(id, i, t) {
  const gw = S.gateways[id]
  if (!gw.online) return { id, online: false, error: 'connection refused' }
  const lease = leasesNow(t).find(l => l.building_id === id), scale = (S.meters.count / 50) * S.meters.factor
  const demand = Math.max(0, round1(S.base[id] * scale + jitter(id, t) * S.jitter * Math.min(scale, 1.5)))
  const remaining = remainingFor(id, i, t)
  let granted = lease ? lease.amps : 0, served = 0, state = 'waiting'
  if (lease && remaining <= 0) { granted = 0; state = 'expired' }
  else if (lease) { served = Math.min(demand, granted); state = demand > granted + 0.05 ? 'limited' : 'active' }
  const growth = S.pendingGrows ? Math.floor((t - S.dbDownAt) / 1000) * 2 : 0
  return {
    id, online: true, data: {
      building_id: id, name: NAMES[id], meter_count: splitMeters(S.meters.count)[i], demand_amps: demand, served_amps: round1(served), granted_amps: granted,
      lease_remaining_ms: remaining, lease_version: lease ? lease.version : 0, state, mqtt_connected: S.meters.mqtt,
      pending_readings: S.postgres ? 0 : S.pendingBase + growth, dropped_readings: gw.dropped, readings_total: gw.readings,
      last_error: !S.meters.mqtt ? 'MQTT broker connection lost; retrying.' : !S.postgres ? 'Readings are queued while PostgreSQL is unavailable.' : '',
    },
  }
}
function overview(t) {
  return {
    nodes: COORD.map(id => S.nodes[id].online ? { id, online: true, data: nodeData(id, t) } : { id, online: false, error: 'connection refused' }),
    buildings: IDS.map((id, i) => buildingSource(id, i, t)),
    meters: { id: 'meters', online: true, data: { meter_count: S.meters.count, demand_factor: S.meters.factor, mqtt_connected: S.meters.mqtt, published_readings: S.meters.published } },
    observed_at: iso(t), demo_enabled: true,
  }
}

// ---- dynamics ----
const schedule = (ms, fn) => S.tasks.push({ at: Date.now() + ms, fn })
function runTasks() {
  const t = Date.now(), due = S.tasks.filter(x => x.at <= t)
  S.tasks = S.tasks.filter(x => x.at > t)
  for (const x of due) { const again = x.fn(); if (typeof again === 'number') S.tasks.push({ at: t + again, fn: x.fn }) }
  trackQuorum(t)
}
function trackQuorum(t = Date.now()) {
  const q = hasQuorum()
  if (!q && S.quorumLostAt === null) { S.quorumLostAt = t; S.remainingAtLoss = {}; IDS.forEach((id, i) => { S.remainingAtLoss[id] = 12000 - ((t + i * 1000) % 3000) }) }
  else if (q && S.quorumLostAt !== null) { S.quorumLostAt = null; S.remainingAtLoss = {} }
}
const commit = () => { S.applied++; S.lastLog++ }
function pushAudit(kind, id, amps, version) { S.audit.push({ event_id: S.nextEventId++, kind, building_id: id, amps, version, occurred_at: iso(Date.now()) }); S.audit = S.audit.slice(-100) }
function scheduleElection(ms) {
  if (S.electionScheduled) return
  S.electionScheduled = true
  schedule(ms, () => {
    S.electionScheduled = false
    const on = onlineIds()
    if (S.leaderId || on.length < 2) return
    S.leaderId = on[0]; S.term++; commit(); trackQuorum()
  })
}
function reconcile() {
  const on = onlineIds()
  if (S.leaderId && (!S.nodes[S.leaderId].online || on.length < 2)) S.leaderId = null // a minority cannot keep a leader
  if (!S.leaderId && on.length >= 2) scheduleElection(2500)
  trackQuorum()
}
function reclaim(id) {
  const l = S.leases[id]; if (!l) return
  S.leaseBase[id] = { amps: l[0].amps, version: l[l.length - 1].version }
  pushAudit('reclaimed', id, l[0].amps, l[l.length - 1].version); delete S.leases[id]; commit()
}
function grant(id) {
  const b = S.leaseBase[id]; if (!b || S.leases[id]) return
  S.leases[id] = [{ version: b.version + 1, amps: b.amps }]; pushAudit('granted', id, b.amps, b.version + 1); commit()
}
function applyAction(service, action) {
  const stop = action === 'stop'
  if (COORD.includes(service)) {
    const n = S.nodes[service], ep = ++n.epoch
    if (stop) { n.online = false; reconcile() }
    else if (!n.online) schedule(1500, () => { if (n.epoch !== ep) return; n.online = true; reconcile() })
  } else if (service.startsWith('gateway-')) {
    const id = service.slice(8).replaceAll('-', '_'), gw = S.gateways[id], ep = ++gw.epoch
    if (stop) {
      gw.online = false
      if (S.leases[id]) schedule(12000, () => { if (gw.epoch !== ep || gw.online) return; if (!hasQuorum()) return 1000; reclaim(id) })
    } else {
      gw.online = true
      if (!S.leases[id]) schedule(1500, () => { if (gw.epoch !== ep || !gw.online) return; if (!hasQuorum()) return 1000; grant(id) })
    }
  } else if (service === 'postgres') {
    if (stop && S.postgres) { S.postgres = false; S.dbDownAt = Date.now(); S.pendingBase = 0; S.pendingGrows = true }
    if (!stop) { S.postgres = true; S.pendingGrows = false }
  } else if (service === 'mosquitto') S.meters.mqtt = !stop
}
function tick() {
  const t = Date.now()
  S.tickN++; trackQuorum(t)
  if (hasQuorum()) { S.quorumVerifiedAt = t; if (S.tickN % 4 === 0) commit() } // a visible commit about every 4 s
  const split = splitMeters(S.meters.count)
  if (S.meters.mqtt) S.meters.published += S.meters.count
  IDS.forEach((id, i) => { const gw = S.gateways[id]; if (gw.online && S.meters.mqtt) gw.readings += split[i] })
}
function applyPreset(name) {
  S = buildState(name, Date.now())
  if (S.electionPending) scheduleElection(S.electionPending)
  trackQuorum()
}
setInterval(tick, 1000)
setInterval(runTasks, 100)

// ---- HTTP ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8' }
function send(res, status, type, body, extra = {}) { res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra }); res.end(body) }
const json = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), { 'Cache-Control': 'no-store' })
const text = (res, status, body) => send(res, status, 'text/plain; charset=utf-8', body)
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > 65536) { reject(Error('Body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Error('Body must be JSON')) } })
    req.on('error', reject)
  })
}
async function serveStatic(req, res, url) {
  let rel; try { rel = decodeURIComponent(url.pathname) } catch { return text(res, 400, 'Bad request') }
  let file = path.join(ROOT, path.normalize(rel))
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return text(res, 403, 'Forbidden')
  try { if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html') } catch { /* handled below */ }
  let body
  try { body = await fsp.readFile(file) } catch {
    if (path.extname(rel)) return text(res, 404, 'Not found')
    try { file = path.join(ROOT, 'index.html'); body = await fsp.readFile(file) } catch { return text(res, 404, 'Not found: no built app at ' + ROOT) }
  }
  const ext = path.extname(file).toLowerCase()
  send(res, 200, TYPES[ext] || 'application/octet-stream', body, { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' })
}
const server = http.createServer(async (req, res) => {
  if (LOG) res.on('finish', () => process.stderr.write(`${req.method} ${req.url} ${res.statusCode}\n`))
  try {
    const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname, post = req.method === 'POST'
    if (p === '/__mock/state') {
      const name = url.searchParams.get('name')
      if (name) { if (!PRESET_NAMES.includes(name)) return json(res, 400, { error: `Unknown preset ${name}`, presets: PRESET_NAMES }); applyPreset(name) }
      return json(res, 200, { state: S.preset, presets: PRESET_NAMES })
    }
    if (p === '/__mock/reset') { applyPreset('healthy'); return json(res, 200, { state: S.preset }) }
    if (p === '/api/overview') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' })
      return S.stale ? json(res, 503, { error: 'The operations service is unavailable.' }) : json(res, 200, overview(Date.now()))
    }
    if (p === '/api/actions' || p === '/api/meters/config' || p === '/api/policy') {
      if (!post) return json(res, 405, { error: 'Method not allowed' })
      let b; try { b = await readJson(req) } catch (e) { return json(res, 400, { error: e.message }) }
      if (b === null || typeof b !== 'object') return json(res, 400, { error: 'Body must be a JSON object' })
      if (p === '/api/actions') {
        if (!SERVICES.includes(b.service)) return json(res, 400, { error: `Unknown service ${JSON.stringify(b.service)}` })
        if (b.action !== 'stop' && b.action !== 'start') return json(res, 400, { error: 'action must be stop or start' })
        applyAction(b.service, b.action)
      } else if (p === '/api/meters/config') {
        if (!Number.isInteger(b.meter_count) || b.meter_count < 1 || b.meter_count > 1000) return json(res, 400, { error: 'meter_count must be a whole number from 1 to 1000' })
        if (typeof b.demand_factor !== 'number' || !(b.demand_factor >= 0 && b.demand_factor <= 3)) return json(res, 400, { error: 'demand_factor must be a number from 0 to 3' })
        S.meters.count = b.meter_count; S.meters.factor = b.demand_factor
      } else {
        if (b.policy !== 'fair_share' && b.policy !== 'first_come') return json(res, 400, { error: 'policy must be fair_share or first_come' })
        S.policyFair = b.policy === 'fair_share'
      }
      return json(res, 200, { status: 'ok' })
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' })
    if (p.startsWith('/nodes/')) return text(res, 426, 'WebSocket upgrade required')
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed')
    await serveStatic(req, res, url)
  } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e?.message || e) }); else res.end() }
})

// ---- WebSocket (RFC 6455, server side, text frames only) ----
function wsFrame(op, buf) {
  const n = buf.length; let head
  if (n < 126) head = Buffer.from([0x80 | op, n])
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2) }
  return Buffer.concat([head, buf])
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://127.0.0.1'), m = /^\/nodes\/(coordinator[123])\/api\/ws$/.exec(url.pathname), key = req.headers['sec-websocket-key']
  if (!m || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return socket.destroy() }
  const id = m[1]
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`)
  let closed = false, buf = Buffer.alloc(0), timer
  const close = () => { if (closed) return; closed = true; clearInterval(timer); try { socket.write(wsFrame(8, Buffer.from([0x03, 0xe8]))); socket.end() } catch { /* socket already gone */ } }
  const send1 = () => {
    if (closed) return
    if (!S.nodes[id].online || S.leaderId !== id) return close() // only the leader streams
    if (S.stale) return // stale preset: stay open, stay silent
    socket.write(wsFrame(1, Buffer.from(JSON.stringify(nodeData(id, Date.now())))))
  }
  send1(); timer = setInterval(send1, 1000)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0; let len = buf[1] & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (masked) off += 4
      if (buf.length < off + len) return
      let payload = buf.subarray(off, off + len)
      if (masked) { const mk = buf.subarray(off - 4, off); payload = Buffer.from(payload.map((b, i) => b ^ mk[i % 4])) }
      buf = buf.subarray(off + len)
      if (op === 8) return close()
      if (op === 9) socket.write(wsFrame(10, payload))
    }
  })
  socket.on('close', () => { closed = true; clearInterval(timer) })
  socket.on('error', () => { closed = true; clearInterval(timer) })
})

server.listen(PORT, '127.0.0.1', () => console.log(`Ishtirak mock API on http://127.0.0.1:${PORT} (static: ${ROOT})`))
