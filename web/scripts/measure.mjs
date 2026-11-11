// Layout measurement for the console: opens the built app from the local mock and prints the page height and the height of each zone
// at the given viewports, with the board's min-height switched off so the number is the board's natural height.
// Usage: node scripts/measure.mjs [state] [WxH ...]   (run `npm run build` first; default 1440x900 healthy)
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), profile=path.join(root,'artifacts','chrome-measure');
await mkdir(profile,{recursive:true});
const args=process.argv.slice(2), sizes=args.filter(a=>/^\d+x\d+$/.test(a)).map(a=>a.split('x').map(Number)), state=args.find(a=>!/^\d+x\d+$/.test(a))||'healthy';
if(!sizes.length)sizes.push([1440,900]);
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe', mockPort=8098, cdp=9344, base=`http://127.0.0.1:${mockPort}`;
const mock=spawn(process.execPath,[path.join(root,'mock','server.mjs')],{env:{...process.env,PORT:String(mockPort),STATIC_DIR:path.join(root,'dist')},stdio:'ignore',windowsHide:true});
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--hide-scrollbars',`--remote-debugging-port=${cdp}`,`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;const pending=new Map();
const call=(method,params={})=>new Promise((resolve,reject)=>{const k=++id;const t=setTimeout(()=>reject(Error('CDP timeout '+method)),20000);pending.set(k,{resolve:x=>{clearTimeout(t);resolve(x)},reject});ws.send(JSON.stringify({id:k,method,params}))});
const evaluate=async e=>{const r=await call('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
try{
 for(let i=0;i<100;i++){try{if((await fetch(`${base}/__mock/state`)).ok&&(await fetch(`http://127.0.0.1:${cdp}/json/list`)).ok)break}catch{}await sleep(200)}
 await fetch(`${base}/__mock/state?name=${state}`);
 const t=await(await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
 ws=new WebSocket(t.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((a,b)=>{ws.onopen=a;ws.onerror=b});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}};
 await call('Runtime.enable');await call('Page.enable');
 for(const [w,h] of sizes){
  await call('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<600});
  await call('Page.navigate',{url:base});
  for(let i=0;i<150;i++){if(await evaluate(`document.querySelectorAll('[data-testid=feeder]').length===3&&document.querySelector('[data-testid=main-ammeter]')?.dataset.selftest==='false'`).catch(()=>false))break;await sleep(200)}
  await sleep(1500);
  const m=await evaluate(`(()=>{const b=document.querySelector('.console'),keep=b.style.minHeight;b.style.minHeight='0';const pad=parseFloat(getComputedStyle(document.body).paddingTop||0)*2;const natural=Math.round(b.getBoundingClientRect().height+pad);const z={};for(const k of ['.topbar','.main','.diagram','.sld','.cluster','.side','.capacity','.coordinators','.dock']){const e=document.querySelector(k);if(e)z[k]=Math.round(e.getBoundingClientRect().height)}b.style.minHeight=keep;return{naturalPage:natural,scrollH:document.documentElement.scrollHeight,scrollW:document.documentElement.scrollWidth,zones:z}})()`);
  console.log(`${w}x${h} ${state}: natural page ${m.naturalPage}px, scrollHeight ${m.scrollH}px (${m.scrollH>h?'scrolls by '+(m.scrollH-h)+'px':'fits'}), scrollWidth ${m.scrollW}`,JSON.stringify(m.zones));
 }
}finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();mock.kill();
}
