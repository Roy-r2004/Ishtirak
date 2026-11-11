// Opens preview/index.html straight from disk (file://) in headless Chrome, proves it makes no network requests, runs the demo through
// a few real interactions and writes screenshots into shots/. Usage: node scripts/preview-check.mjs
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), out=path.join(root,'shots'), profile=path.join(root,'artifacts','chrome-preview');
await mkdir(out,{recursive:true});await mkdir(profile,{recursive:true});
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe', port=9342, url=pathToFileURL(path.join(root,'preview','index.html')).href;
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;const pending=new Map(),report={url,requests:[],external:[],errors:[],checks:[]};
const check=(name,ok,detail)=>{report.checks.push({name,passed:!!ok,...(detail!==undefined?{detail}:{})});console.log(ok?'PASS':'FAIL',name,detail??'');if(!ok)process.exitCode=1};
const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const t=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method))},20000);pending.set(key,{resolve:x=>{clearTimeout(t);resolve(x)},reject});ws.send(JSON.stringify({id:key,method,params}))});
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function waitFor(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return}catch{}await sleep(250)}throw Error('Browser condition timed out: '+fn)}
async function shot(file,vp,full){
 if(full){const l=await call('Page.getLayoutMetrics');await call('Emulation.setDeviceMetricsOverride',{width:vp.w,height:Math.max(vp.h,Math.ceil(l.cssContentSize.height)),deviceScaleFactor:1,mobile:vp.mobile});await sleep(400)}
 const r=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,file),Buffer.from(r.data,'base64'));
 if(full){await call('Emulation.setDeviceMetricsOverride',{width:vp.w,height:vp.h,deviceScaleFactor:1,mobile:vp.mobile});await sleep(300)}
 console.log('saved',path.join(out,file));
}
const state=()=>evaluate(`(()=>{const a=document.querySelector('[data-testid=main-ammeter]');const f=[...document.querySelectorAll('[data-testid=feeder]')].map(x=>({b:x.dataset.building,s:x.dataset.state,res:x.querySelector('[data-testid=feeder-reserved]')?.textContent,dem:x.querySelector('[data-testid=feeder-demand]')?.textContent}));return{reserved:a?.dataset.reserved,peak:a?.dataset.peak,fresh:a?.dataset.fresh,violations:a?.dataset.violations,selftest:a?.dataset.selftest,fairness:document.querySelector('[data-testid=fairness]')?.textContent,feeders:f}})()`);
const esc=async()=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(600)};
const press=(testid)=>evaluate(`(()=>{const b=document.querySelector('[data-testid=${testid}]');if(!b)throw Error('missing ${testid}');b.click();return true})()`);
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/list`)).ok)break}catch{}await sleep(200)}
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((a,b)=>{ws.onopen=a;ws.onerror=b});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}
  else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)
  else if(m.method==='Network.requestWillBeSent'){const u=m.params.request.url;report.requests.push(u.slice(0,120));if(/^(https?|wss?|ftp):/i.test(u))report.external.push(u)}
  else if(m.method==='Network.webSocketCreated')report.external.push('WebSocket '+m.params.url)};
 await call('Runtime.enable');await call('Network.enable');await call('Page.enable');
 const desktop={w:1440,h:900,mobile:false}, mobile={w:390,h:844,mobile:true};
 await call('Emulation.setDeviceMetricsOverride',{width:desktop.w,height:desktop.h,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url});
 await waitFor(()=>evaluate(`document.querySelectorAll('[data-testid=feeder]').length===3&&document.querySelector('[data-testid=main-ammeter]')?.dataset.selftest==='false'`),30000);
 check('opens from file:// with three feeders and three relays',await evaluate(`document.querySelectorAll('[data-testid=feeder]').length===3&&document.querySelectorAll('[data-testid=relay]').length===3`));
 check('permanent "Simulated data" plate is shown',await evaluate(`document.querySelector('[data-testid=demo-plate]')?.textContent.includes('Simulated data')===true`));
 await waitFor(()=>evaluate(`document.querySelector('[data-testid=main-ammeter]').dataset.fresh==='true'&&Number(document.querySelector('[data-testid=main-ammeter]').dataset.reserved)>0`),20000);
 await sleep(4000);
 let s=await state();console.log('healthy',JSON.stringify(s));
 check('needle shows a reserved total within capacity',Number(s.reserved)>0&&Number(s.reserved)<=120,s.reserved);
 check('no horizontal overflow at 1440',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 await shot('preview-1440x900.png',desktop,false);
 await shot('preview-1440x900-full.png',desktop,true);
 // ---- capacity readout and the new doors, on the demo data ----
 const figs=await evaluate(`(()=>{const v=id=>document.querySelector('[data-testid="'+id+'"]');const a=v('main-ammeter').dataset;return{capacity:Number(a.capacity),reserved:Number(a.reserved),free:v('free-readout').dataset.value,served:v('served-readout').dataset.value,curtailed:v('curtailed-readout').dataset.value}})()`);
 check('free, served and curtailed readouts are real figures (free = capacity minus reserved)',figs.free!==''&&figs.served!==''&&figs.curtailed!==''&&Math.abs(Number(figs.free)-(figs.capacity-figs.reserved))<=0.11,JSON.stringify(figs));
 const plateRows=await evaluate(`document.querySelectorAll('[data-testid=ledger-row]').length`);
 await press('ledger-open');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=ledger-door]')`),5000);await sleep(500);
 const doorRows=await evaluate(`document.querySelectorAll('[data-testid=ledger-door-row]').length`);
 check('Full ledger door shows the same events as the ledger plate',doorRows>0&&Math.abs(doorRows-plateRows)<=1,`${doorRows} in the door, ${plateRows} on the plate`);
 await shot('preview-door-ledger-1440x900.png',desktop,false);await esc();
 await press('cluster-open');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=cluster-door]')`),5000);await sleep(500);
 const cl=await evaluate(`({nodes:document.querySelectorAll('[data-testid=cluster-door-node]').length,facts:document.querySelectorAll('[data-testid=cluster-fact]').length,leaders:document.querySelectorAll('[data-testid=cluster-door-node][data-role=Leader]').length,unknown:document.querySelectorAll('[data-testid=cluster-door] td[data-unknown=true]').length,policy:document.querySelector('[data-fact=policy]').dataset.value,feed:document.querySelector('[data-fact=feed]').dataset.value})`);
 check('Cluster details door lists three coordinators (one leader) and seven facts',cl.nodes===3&&cl.facts===7&&cl.leaders===1,JSON.stringify(cl));
 check('demo coordinators report every raft field, so nothing reads unknown',cl.unknown===0,`${cl.unknown} unknown cells`);
 await shot('preview-door-cluster-1440x900.png',desktop,false);await esc();
 await press('recorder-open-bottom');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=recorder]')`),5000);await sleep(800);
 await shot('preview-tray-1440x900.png',desktop,false);await esc();
 // demo interactions: 200 meters under first come (a hog), then fair share (convergence)
 await press('policy-first_come');await waitFor(()=>evaluate(`document.querySelector('[data-testid=policy-first_come]').getAttribute('aria-checked')==='true'`),15000);
 check('policy switch commits first come in the simulator',true);
 await press('meters-200');await press('sim-apply');
 await waitFor(()=>evaluate(`document.querySelector('[data-testid=active-meters]').textContent.trim()==='200'`),15000);
 check('simulator meter count changed to 200',true);
 await sleep(16000);s=await state();console.log('first come at 200',JSON.stringify(s));
 const reserved=s.feeders.map(f=>parseFloat(f.res));
 check('first come at 200 meters leaves an uneven split',Math.max(...reserved)-Math.min(...reserved)>=20,reserved.join('/'));
 check('reserved total never above 120',Number(s.reserved)<=120&&Number(s.violations)===0,`${s.reserved} A, violations ${s.violations}`);
 await shot('preview-hog-1440x900.png',desktop,false);
 await press('policy-fair_share');await waitFor(()=>evaluate(`document.querySelector('[data-testid=policy-fair_share]').getAttribute('aria-checked')==='true'`),15000);
 await sleep(40000);s=await state();console.log('fair share after 40 s',JSON.stringify(s));
 const r2=s.feeders.map(f=>parseFloat(f.res));
 check('fair share converges to an even split within 40 s',Math.max(...r2)-Math.min(...r2)<=6,r2.join('/'));
 check('still no violation after the policy change',Number(s.violations)===0&&Number(s.reserved)<=120,`${s.reserved} A`);
 await shot('preview-fair-1440x900.png',desktop,false);
 // leader failover through the guarded button
 await press('meters-50');await press('sim-apply');await sleep(1500);
 await evaluate(`document.querySelector('[data-testid=scenario][data-scenario=leader-failover] [data-testid=scenario-cover]').click()`);await sleep(700);
 await evaluate(`document.querySelector('[data-testid=scenario][data-scenario=leader-failover] [data-testid=scenario-run]').click()`);
 await waitFor(()=>evaluate(`document.querySelector('[data-testid=scenario-status]')?.textContent.includes('Completed')`),120000);
 check('leader failover scenario completes in the simulator',true);
 check('every coordinator is running again',await evaluate(`[...document.querySelectorAll('[data-testid=relay]')].every(r=>r.dataset.role!=='Unreachable')`));
 check('timeline recorded the change',await evaluate(`document.querySelectorAll('[data-testid=timeline-item]').length>0`));
 await shot('preview-after-failover-1440x900.png',desktop,false);
 // mobile
 await call('Emulation.setDeviceMetricsOverride',{width:mobile.w,height:mobile.h,deviceScaleFactor:1,mobile:true});await sleep(1200);
 check('no horizontal overflow at 390',await evaluate(`document.documentElement.scrollWidth<=innerWidth`),await evaluate(`document.documentElement.scrollWidth+'/'+innerWidth`));
 await shot('preview-390x844.png',mobile,false);
 for(const [opener,door,file] of [['ledger-open','ledger-door','preview-door-ledger-390x844.png'],['cluster-open','cluster-door','preview-door-cluster-390x844.png']]){
  await press(opener);await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=${door}]')`),5000);await sleep(600);
  check(`${door} fits the phone screen without horizontal page overflow`,await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[data-testid=${door}]').getBoundingClientRect().right<=innerWidth+1`));
  check(`${door} table shows every column without scrolling sideways`,await evaluate(`(()=>{const t=document.querySelector('[data-testid=${door}] .tape-door, [data-testid=${door}] .door-table');return t.scrollWidth<=t.clientWidth+1})()`),await evaluate(`(()=>{const t=document.querySelector('[data-testid=${door}] .tape-door, [data-testid=${door}] .door-table');return t.scrollWidth+' wide in '+t.clientWidth})()`));
  await shot(file,mobile,false);await esc();
 }
 await press('recorder-open-bottom');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=recorder]')`),5000);await sleep(1200);
 check('on a phone the tray opened from the bottom button is scrolled into view',await evaluate(`(()=>{const r=document.querySelector('[data-testid=recorder]').getBoundingClientRect();return r.bottom>0&&r.top<innerHeight})()`));
 await shot('preview-tray-390x844.png',mobile,false);await esc();
 await evaluate(`window.scrollTo(0,0)`);await sleep(300);
 await shot('preview-390x844-full.png',mobile,true);
 check('no request left the file (no http, https or WebSocket)',report.external.length===0,report.external.join(', ')||'none');
 check('no uncaught JavaScript errors',report.errors.length===0,report.errors.join(' | ')||'none');
}catch(error){report.error=error.message;console.log('ERROR',error.message);process.exitCode=1;
 try{console.log('page state',JSON.stringify(await state()));console.log('feed',await evaluate(`document.querySelector('[data-testid=feed]')?.textContent`),'| notice',await evaluate(`document.querySelector('[data-testid=notice]')?.textContent`),'| demo',await evaluate(`typeof window.fetch+' '+String(window.fetch).slice(0,60)`))}catch(e){console.log('could not read page state',e.message)}
 console.log('errors',report.errors,'requests',report.requests.slice(0,8))}
finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();
 await writeFile(path.join(out,'preview-check.json'),JSON.stringify(report,null,2)+'\n');
}
