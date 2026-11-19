import { useEffect, useRef, useState } from 'react'
import { policyOf, type Policy, type Share } from './lab/fairness'
import { activeSource, activeSources, deployed, pairView, type PairView } from './board/standby-logic'
/** One committed grant a gateway may still use. `Lease.amps` is the largest (oldest) tier; tiers are listed oldest first with falling amps. Older coordinators omit them. */
export type Tier = { version:number; amps:number }
export type Lease = { building_id:string; amps:number; version:number; tiers?:Tier[] }
export type Audit = { event_id:number; kind:string; building_id:string; amps:number; version:number; occurred_at:string }
export type NodeData = { node_id:string; state:string; leader_id:string; quorum:boolean; capacity_amps:number; granted_amps:number; available_amps:number; leases:Lease[]; audit:Audit[]; postgres_connected:boolean; raft:Record<string,string>; quorum_verified_at:string; fair_share?:boolean; wants?:Share[]; fair_shares?:Share[] }
/** What a gateway says about its place in its building's pair: serving = holds a live lease, standby = refused because the other gateway's session holds the building, waiting = anything else (starting, lease expired, no coordinator). Older backends send none. */
export type GatewayRole = 'serving'|'standby'|'waiting'
/** A gateway as the console can describe it: its reported role, `stopped` when it does not answer, `unknown` when nothing fresh or complete was reported. */
export type GatewayState = GatewayRole|'stopped'|'unknown'
export type Building = { building_id:string; name:string; meter_count:number; demand_amps:number; served_amps:number; granted_amps:number; lease_remaining_ms:number; lease_version:number; state:string; mqtt_connected:boolean; pending_readings:number; dropped_readings:number; readings_total:number; last_error:string; session_id?:string; role?:GatewayRole }
export type Meter = { meter_count:number; demand_factor:number; mqtt_connected:boolean; published_readings:number }
export type Source<T> = { id:string; online:boolean; data?:T; error?:string }
/** `standbys` is shaped like `buildings` (one source per building). It is absent on a backend without standby gateways, and then no standby UI is shown. */
export type Overview = { nodes:Source<NodeData>[]; buildings:Source<Building>[]; standbys?:Source<Building>[]; meters:Source<Meter>; observed_at:string; demo_enabled:boolean }
export type Point = { at:number; demand:number; served:number; granted:number }
export const names:Record<string,string>={hamra:'Hamra Residence',mar_mikhael:'Mar Mikhael House',achrafieh:'Achrafieh Gardens'}
export const districts:Record<string,string>={hamra:'Hamra',mar_mikhael:'Mar Mikhael',achrafieh:'Achrafieh'}
export const colors=['#0d9e81','#6484dc','#d69b3c']
export const num=(n?:number,digits=0)=>n===undefined?'—':n.toLocaleString('en',{maximumFractionDigits:digits})
export const time=(date:string|number)=>new Date(date).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
export function useGrid(){
 const [data,setData]=useState<Overview|null>(null),[stream,setStream]=useState<NodeData|null>(null),[streamAt,setStreamAt]=useState(0),[socketOpen,setSocketOpen]=useState(false),[history,setHistory]=useState<Point[]>([]),[lastSeen,setLastSeen]=useState(0),[now,setNow]=useState(Date.now()),[error,setError]=useState(''),[busy,setBusy]=useState(''),[notice,setNotice]=useState<{text:string;failed:boolean}|null>(null)
 const actionLock=useRef(false)
 useEffect(()=>{
  let disposed=false;let timer:ReturnType<typeof setTimeout>;const controller=new AbortController()
  async function poll(){try{const response=await fetch('/api/overview',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(7000)])});if(!response.ok)throw Error('The operations service is unavailable.');const value:Overview=await response.json();if(disposed)return;setData(value);setLastSeen(Date.now());setError('');const leader=value.nodes.find(n=>n.online&&n.data?.state==='Leader')?.data;if(leader){const active=activeSources(value.buildings,value.standbys,true);setHistory(prev=>[...prev,{at:Date.now(),granted:leader.granted_amps,demand:active.reduce((s,b)=>s+(b.online?b.data?.demand_amps??0:0),0),served:active.reduce((s,b)=>s+(b.online?b.data?.served_amps??0:0),0)}].slice(-90))}}catch(e){if(!disposed)setError(e instanceof Error?e.message:'Connection interrupted')}if(!disposed)timer=setTimeout(poll,1200)}
  void poll();const tick=setInterval(()=>setNow(Date.now()),500);return()=>{disposed=true;clearTimeout(timer);clearInterval(tick);controller.abort()}
 },[])
 const leaderSource=data?.nodes.find(n=>n.online&&n.data?.state==='Leader'),leaderID=leaderSource?.id
 useEffect(()=>{setStream(null);setStreamAt(0);setSocketOpen(false);if(!leaderID)return;let active=true;let ws:WebSocket;let timer:ReturnType<typeof setTimeout>;const connect=()=>{ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/nodes/${leaderID}/api/ws`);ws.onmessage=e=>{try{const value:NodeData=JSON.parse(e.data);if(active){setStream(value);setStreamAt(Date.now());setSocketOpen(true)}}catch{setSocketOpen(false)}};ws.onclose=()=>{if(active){setSocketOpen(false);timer=setTimeout(connect,2500)}};ws.onerror=()=>ws.close()};connect();return()=>{active=false;clearTimeout(timer);ws.close()}},[leaderID])
 const stale=!lastSeen||now-lastSeen>6000||!!error,streamLive=socketOpen&&now-streamAt<5000&&!stale
 const cluster=stream&&stream.node_id===leaderID&&streamLive?stream:leaderSource?.data??data?.nodes.filter(n=>n.online&&n.data).sort((a,b)=>Number(b.data?.raft?.last_log_index??0)-Number(a.data?.raft?.last_log_index??0))[0]?.data
 const quorum=!stale&&!!leaderSource&&!!cluster?.quorum
 const buildings=data?.buildings??Object.keys(names).map(id=>({id,online:false} as Source<Building>)),nodes=data?.nodes??['coordinator1','coordinator2','coordinator3'].map(id=>({id,online:false} as Source<NodeData>))
 // Standby gateways: `standbys` is null on a backend without them, and then `pairs` is null and `active` is `buildings` itself. Otherwise `pairs` says who serves each building and `active` holds the serving gateway's source (the primary unless the standby serves), which feeds the totals.
 const standbys=data&&deployed(data.standbys)?data.standbys:null,fresh=!stale&&!!data
 const pairs:Record<string,PairView>|null=standbys?Object.fromEntries(buildings.map(b=>[b.id,pairView(b,standbys.find(s=>s.id===b.id),fresh)])):null
 const active=standbys&&pairs?buildings.map(b=>activeSource(b,standbys.find(s=>s.id===b.id),pairs[b.id])):buildings
 const served=active.reduce((s,b)=>s+(b.online?b.data?.served_amps??0:0),0),demand=active.reduce((s,b)=>s+(b.online?b.data?.demand_amps??0:0),0)
 async function post(path:string,body:object,key:string,success?:string){if(actionLock.current)return;actionLock.current=true;setBusy(key);setNotice(null);try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const raw=await response.text();if(!response.ok){let message=raw;try{message=JSON.parse(raw).error??raw}catch{}throw Error(message)}setNotice({text:success??(key==='simulation'?'Simulation updated. Live readings will follow.':`${key.replaceAll('-',' ')} completed.`),failed:false})}catch(e){setNotice({text:`Action failed: ${e instanceof Error?e.message:'Unknown error'}`,failed:true})}finally{actionLock.current=false;setBusy('')}}
 const policy:Policy|null=policyOf(cluster?.fair_share)
 function setPolicy(next:Policy){return post('/api/policy',{policy:next},'policy',next==='fair_share'?'Fair sharing enabled.':'First come enabled.')}
 function act(service:string,action:string){void post('/api/actions',{service,action},`${action}-${service}`)}
 function exportAudit(){const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),snapshot_observed_at:data?.observed_at,events:cluster?.audit??[],note:'Latest 100 replicated events; full history is stored in PostgreSQL.'},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='ishtirak-audit.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 return{data,history,lastSeen,now,error,busy,notice,setNotice,stale,streamLive,cluster,quorum,buildings,standbys,pairs,active,nodes,served,demand,act,post,exportAudit,policy,setPolicy}
}
export type Grid=ReturnType<typeof useGrid>
