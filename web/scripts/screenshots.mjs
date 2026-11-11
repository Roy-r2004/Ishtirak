// Screenshot workflow for the redesign: starts the local mock API server (never the real stack), drives headless Chrome over the
// DevTools protocol and saves one PNG per state and viewport into shots/. Usage: node scripts/screenshots.mjs [state ...] [--only=desktop|laptop|mobile]
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), out=path.join(root,'shots'), profile=path.join(root,'artifacts','chrome-shots');
await mkdir(out,{recursive:true});await mkdir(profile,{recursive:true});
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const mockPort=Number(process.env.MOCK_PORT||8099), cdpPort=9341, base=`http://127.0.0.1:${mockPort}`;
const args=process.argv.slice(2), only=(args.find(a=>a.startsWith('--only='))||'').slice(7), wanted=args.filter(a=>!a.startsWith('--'));
const viewports={desktop:{w:1440,h:900,mobile:false,full:false},laptop:{w:1280,h:720,mobile:false,full:true},mobile:{w:390,h:844,mobile:true,full:true}};
const states=['healthy','hog','node-down','stale','majority-lost','scenario','door-ledger','door-cluster','door-cluster-down','tray-bottom'];
// States that open one of the doors (or the chart recorder tray) on top of a preset.
const presetFor={stale:'healthy',scenario:'healthy','door-ledger':'healthy','door-cluster':'healthy','door-cluster-down':'majority-lost','tray-bottom':'healthy'};
const opener={'door-ledger':'ledger-open','door-cluster':'cluster-open','door-cluster-down':'cluster-open','tray-bottom':'recorder-open-bottom'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mock=spawn(process.execPath,[path.join(root,'mock','server.mjs')],{env:{...process.env,PORT:String(mockPort),STATIC_DIR:path.join(root,'dist')},stdio:'ignore',windowsHide:true});
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws,id=0;const pending=new Map(),errors=[];
function call(method,params={}){return new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method))},20000);pending.set(key,{resolve:x=>{clearTimeout(timer);resolve(x)},reject});ws.send(JSON.stringify({id:key,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function waitFor(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return}catch{}await sleep(200)}throw Error('Browser condition timed out')}
const setState=async name=>{const r=await fetch(`${base}/__mock/state?name=${name}`);if(!r.ok)throw Error('mock state '+name)};
async function snap(file,full,vp){
 const layout=await call('Page.getLayoutMetrics');
 if(full){await call('Emulation.setDeviceMetricsOverride',{width:vp.w,height:Math.max(vp.h,Math.ceil(layout.cssContentSize.height)),deviceScaleFactor:1,mobile:vp.mobile});await sleep(400)}
 const cl=(args.find(a=>a.startsWith('--clip='))||'').slice(7).split(',').map(Number);const r=await call('Page.captureScreenshot',cl.length===2?{format:'png',clip:{x:0,y:cl[0],width:vp.w,height:cl[1]-cl[0],scale:1},captureBeyondViewport:true}:{format:'png'});await writeFile(path.join(out,file),Buffer.from(r.data,'base64'));
 if(full){await call('Emulation.setDeviceMetricsOverride',{width:vp.w,height:vp.h,deviceScaleFactor:1,mobile:vp.mobile});await sleep(300)}
}
const measure=vw=>evaluate(`(()=>{const VW=${vw};const de=document.documentElement,bad=[];for(const el of document.querySelectorAll('body *')){const r=el.getBoundingClientRect();if(r.width&&r.right>VW+1&&getComputedStyle(el).position!=='fixed')bad.push((el.className&&el.className.baseVal===undefined?el.className:el.tagName)+':'+Math.round(r.right))}const zones={};for(const k of ['.top','.ammeter','.council','.feeders','.ledger','.test','.test-head','.tp-scenarios','.overload','.sim','.timeline','.relay','.feeder','.readout','.annunciator','.proof','.bezel-wrap']){const e=document.querySelector(k);if(e){const r=e.getBoundingClientRect();zones[k]=[Math.round(r.left),Math.round(r.top+scrollY),Math.round(r.width),Math.round(r.height)]}}return{scrollW:de.scrollWidth,innerW:innerWidth,scrollH:de.scrollHeight,innerH:innerHeight,wide:bad.slice(0,6),zones}})()`);
const report=[];
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).ok)break}catch{}await sleep(200)}
 for(let i=0;i<50;i++){try{if((await fetch(`${base}/__mock/state`)).ok)break}catch{}await sleep(200)}
 const targets=await(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((a,b)=>{ws.onopen=a;ws.onerror=b});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 await call('Runtime.enable');await call('Page.enable');
 for(const [name,vp] of Object.entries(viewports)){
  if(only&&only!==name)continue;
  for(const state of states){
   if(wanted.length&&!wanted.includes(state))continue;
   await setState(presetFor[state]??state);
   await call('Emulation.setDeviceMetricsOverride',{width:vp.w,height:vp.h,deviceScaleFactor:1,mobile:vp.mobile});
   await call('Page.navigate',{url:base});
   await waitFor(()=>evaluate(`document.querySelectorAll('[data-testid=feeder]').length===3&&document.querySelector('[data-testid=main-ammeter]')?.dataset.selftest==='false'`),30000);
   await sleep(state==='healthy'?3500:2500);
   if(state==='stale'){await setState('stale');await waitFor(()=>evaluate(`document.querySelector('[data-testid=main-ammeter]').dataset.fresh==='false'`),15000);await sleep(1500)}
   if(opener[state]){await evaluate(`document.querySelector('[data-testid=${opener[state]}]').click()`);await sleep(1200)}
   if(state==='scenario'){
    await evaluate(`(()=>{const s=document.querySelector('[data-testid=scenario][data-scenario=leader-failover]');s.querySelector('[data-testid=scenario-cover]').click()})()`);await sleep(700);
    await evaluate(`document.querySelector('[data-testid=scenario][data-scenario=leader-failover] [data-testid=scenario-run]').click()`);await sleep(3800);
   }
   const m=await measure(vp.w),info=await evaluate(`(()=>{const a=document.querySelector('[data-testid=main-ammeter]');const n=a.querySelector('.needle');return{reserved:a.dataset.reserved,peak:a.dataset.peak,fresh:a.dataset.fresh,needle:n?.getAttribute('transform')}})()`);
   const file=`${state}-${vp.w}x${vp.h}.png`;await snap(file,!opener[state]&&(vp.full||args.includes('--full')),vp) /* doors and the tray are fixed or scrolled into view: shoot the real viewport, never a stretched one */;
   report.push({file,...m,...info});console.log(file,JSON.stringify({...m,...info}));
  }
 }
}finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();mock.kill();
 await writeFile(path.join(out,'report.json'),JSON.stringify({report,errors},null,2)+'\n');
 if(errors.length)console.log('Uncaught errors:',errors);
}
