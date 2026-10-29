import { useEffect, useRef, useState } from 'react'
export type Lease = { building_id:string; amps:number; version:number }
export type Audit = { event_id:number; kind:string; building_id:string; amps:number; version:number; occurred_at:string }
export type NodeData = { node_id:string; state:string; leader_id:string; quorum:boolean; capacity_amps:number; granted_amps:number; available_amps:number; leases:Lease[]; audit:Audit[]; postgres_connected:boolean; raft:Record<string,string>; quorum_verified_at:string }
export type Building = { building_id:string; name:string; meter_count:number; demand_amps:number; served_amps:number; granted_amps:number; lease_remaining_ms:number; lease_version:number; state:string; mqtt_connected:boolean; pending_readings:number; dropped_readings:number; readings_total:number; last_error:string }
export type Meter = { meter_count:number; demand_factor:number; mqtt_connected:boolean; published_readings:number }
export type Source<T> = { id:string; online:boolean; data?:T; error?:string }
export type Overview = { nodes:Source<NodeData>[]; buildings:Source<Building>[]; meters:Source<Meter>; observed_at:string; demo_enabled:boolean }
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
  async function poll(){try{const response=await fetch('/api/overview',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(7000)])});if(!response.ok)throw Error('The operations service is unavailable.');const value:Overview=await response.json();if(disposed)return;setData(value);setLastSeen(Date.now());setError('');const leader=value.nodes.find(n=>n.online&&n.data?.state==='Leader')?.data;if(leader)setHistory(prev=>[...prev,{at:Date.now(),granted:leader.granted_amps,demand:value.buildings.reduce((s,b)=>s+(b.online?b.data?.demand_amps??0:0),0),served:value.buildings.reduce((s,b)=>s+(b.online?b.data?.served_amps??0:0),0)}].slice(-90))}catch(e){if(!disposed)setError(e instanceof Error?e.message:'Connection interrupted')}if(!disposed)timer=setTimeout(poll,1200)}
  void poll();const tick=setInterval(()=>setNow(Date.now()),500);return()=>{disposed=true;clearTimeout(timer);clearInterval(tick);controller.abort()}
 },[])
 const leaderSource=data?.nodes.find(n=>n.online&&n.data?.state==='Leader'),leaderID=leaderSource?.id
 useEffect(()=>{setStream(null);setStreamAt(0);setSocketOpen(false);if(!leaderID)return;let active=true;let ws:WebSocket;let timer:ReturnType<typeof setTimeout>;const connect=()=>{ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/nodes/${leaderID}/api/ws`);ws.onmessage=e=>{try{const value:NodeData=JSON.parse(e.data);if(active){setStream(value);setStreamAt(Date.now());setSocketOpen(true)}}catch{setSocketOpen(false)}};ws.onclose=()=>{if(active){setSocketOpen(false);timer=setTimeout(connect,2500)}};ws.onerror=()=>ws.close()};connect();return()=>{active=false;clearTimeout(timer);ws.close()}},[leaderID])
 const stale=!lastSeen||now-lastSeen>6000||!!error,streamLive=socketOpen&&now-streamAt<5000&&!stale
 const cluster=stream&&stream.node_id===leaderID&&streamLive?stream:leaderSource?.data??data?.nodes.filter(n=>n.online&&n.data).sort((a,b)=>Number(b.data?.raft?.last_log_index??0)-Number(a.data?.raft?.last_log_index??0))[0]?.data
 const quorum=!stale&&!!leaderSource&&!!cluster?.quorum
 const buildings=data?.buildings??Object.keys(names).map(id=>({id,online:false} as Source<Building>)),nodes=data?.nodes??['coordinator1','coordinator2','coordinator3'].map(id=>({id,online:false} as Source<NodeData>))
 const served=buildings.reduce((s,b)=>s+(b.online?b.data?.served_amps??0:0),0),demand=buildings.reduce((s,b)=>s+(b.online?b.data?.demand_amps??0:0),0)
 async function post(path:string,body:object,key:string){if(actionLock.current)return;actionLock.current=true;setBusy(key);setNotice(null);try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const raw=await response.text();if(!response.ok){let message=raw;try{message=JSON.parse(raw).error??raw}catch{}throw Error(message)}setNotice({text:key==='simulation'?'Simulation updated. Live readings will follow.':`${key.replaceAll('-',' ')} completed.`,failed:false})}catch(e){setNotice({text:`Action failed: ${e instanceof Error?e.message:'Unknown error'}`,failed:true})}finally{actionLock.current=false;setBusy('')}}
 function act(service:string,action:string){void post('/api/actions',{service,action},`${action}-${service}`)}
 function exportAudit(){const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),snapshot_observed_at:data?.observed_at,events:cluster?.audit??[],note:'Latest 100 replicated events; full history is stored in PostgreSQL.'},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='ishtirak-audit.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 return{data,history,lastSeen,now,error,busy,notice,setNotice,stale,streamLive,cluster,quorum,buildings,nodes,served,demand,act,post,exportAudit}
}
export type Grid=ReturnType<typeof useGrid>
