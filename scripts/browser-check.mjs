// Dependency-free browser checks using Chrome's local DevTools protocol, for the Switchboard board (see TESTIDS.md).
// Runs against the real stack at BASE_URL (default http://127.0.0.1:8088); set BASE_URL to point it at the local mock instead.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), out=path.join(root,'artifacts');
await mkdir(out,{recursive:true});
const base=(process.env.BASE_URL||'http://127.0.0.1:8088').replace(/\/$/,'');
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port=9238;
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(out,'chrome-profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;const pending=new Map();const report={base,checks:[],runtime_errors:[],websocket_frames:0};
function check(name,ok){report.checks.push({name,passed:!!ok});if(!ok)throw Error(name)}
async function waitFor(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return}catch{}await sleep(250)}throw Error('Browser condition timed out')}
function call(method,params={}){return new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method))},15000);pending.set(key,{resolve:x=>{clearTimeout(timer);resolve(x)},reject});ws.send(JSON.stringify({id:key,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const q=id=>`[data-testid=${JSON.stringify(id)}]`;
// Click the first element with this test id, or the one inside `within` (a selector).
async function click(testid,within=''){return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify((within?within+' ':'')+q(testid))});if(!e)throw Error('Missing ${testid}');e.click();return true})()`)}
const overview=async()=>(await fetch(`${base}/api/overview`)).json();
// Set a controlled input or select the way a person would, so React sees the change.
const setValue=(testid,value)=>evaluate(`(()=>{const e=document.querySelector('[data-testid="${testid}"]');const sel=e instanceof HTMLSelectElement;Object.getOwnPropertyDescriptor(sel?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(sel?'change':'input',{bubbles:true}));return true})()`);
const focusClick=async testid=>{await evaluate(`document.querySelector('[data-testid="${testid}"]').focus()`);await click(testid)};
const escape=async()=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await sleep(500)};
const focusIs=testid=>evaluate(`document.activeElement===document.querySelector('[data-testid="${testid}"]')`);
const inDialog=testid=>evaluate(`(()=>{const d=document.querySelector('[data-testid="${testid}"]');return !!d&&d.contains(document.activeElement)})()`);
// Guarded buttons have a flip-up cover: lift it, wait for the press button to enable, then press.
async function pressGuarded(scenarioId,cover,press){const within=`[data-testid="scenario"][data-scenario=${JSON.stringify(scenarioId)}]`;await click(cover,within);await waitFor(()=>evaluate(`!document.querySelector(${JSON.stringify(within+' '+q(press))}).disabled`));await click(press,within)}
// Full-page capture: resize the viewport to the page height so the whole board lands in one image, then restore it.
async function screenshot(name){const dims=await evaluate(`({w:innerWidth,h:innerHeight})`);const layout=await call('Page.getLayoutMetrics');const mobile=dims.w<600;await call('Emulation.setDeviceMetricsOverride',{width:dims.w,height:Math.ceil(layout.cssContentSize.height),deviceScaleFactor:1,mobile});await sleep(400);const r=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,name),Buffer.from(r.data,'base64'));await call('Emulation.setDeviceMetricsOverride',{width:dims.w,height:dims.h,deviceScaleFactor:1,mobile});await sleep(300)}
try{
 await waitFor(async()=>{const r=await fetch(`http://127.0.0.1:${port}/json/list`);return r.ok},20000);
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result)}else if(msg.method==='Runtime.exceptionThrown')report.runtime_errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);else if(msg.method==='Network.webSocketFrameReceived')report.websocket_frames++};
 await call('Runtime.enable');await call('Network.enable');await call('Page.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:base});
 // The board is ready when the three feeders are drawn, the load self-test has finished and the ammeter holds fresh data.
 await waitFor(()=>evaluate(`document.querySelectorAll('[data-testid="feeder"]').length===3&&document.querySelector('[data-testid="main-ammeter"]')?.dataset.selftest==='false'&&document.querySelector('[data-testid="main-ammeter"]')?.dataset.fresh==='true'`),30000);
 await sleep(5000);
 check('desktop has three feeders and three relays',await evaluate(`document.querySelectorAll('[data-testid="feeder"]').length===3&&document.querySelectorAll('[data-testid="relay"]').length===3`));
 check('main ammeter, peak readout and violation counter are present',await evaluate(`!!document.querySelector('[data-testid="main-ammeter"]')&&!!document.querySelector('[data-testid="peak-readout"]')&&!!document.querySelector('[data-testid="violations"]')`));
 check('real mode never shows the Simulated data plate',await evaluate(`!document.querySelector('[data-testid="demo-plate"]')&&document.querySelector('[data-testid="board"]').dataset.demo==='false'`));
 check('desktop has no horizontal overflow',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 check('live WebSocket frames received',report.websocket_frames>0);
 await screenshot('board-desktop.png');
 await click('help-open');
 check('help dialog opens and receives focus',await evaluate(`!!document.querySelector('[data-testid="help-dialog"]')&&document.querySelector('[data-testid="help-dialog"]').contains(document.activeElement)`));
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 await waitFor(()=>evaluate(`!document.querySelector('[data-testid="help-dialog"]')`));
 check('Escape closes help dialog',true);
 await sleep(400); // focus is restored in a timeout after the dialog unmounts
 report.focus_after_escape=await evaluate(`(()=>{const a=document.activeElement;return a?a.tagName+(a.dataset?.testid?'['+a.dataset.testid+']':''):'none'})()`);
 check('focus returns to the button that opened the dialog',report.focus_after_escape==='BUTTON[help-open]');
 await click('meters-10');await click('sim-apply');
 await waitFor(async()=>(await overview()).meters.data.meter_count===10);
 check('UI changes the real meter simulator to ten',true);
 await waitFor(()=>evaluate(`!document.querySelector('[data-testid="sim-apply"]').disabled`));
 await click('meters-50');await click('sim-apply');
 await waitFor(async()=>(await overview()).meters.data.meter_count===50);
 check('UI restores fifty meters',true);
 check('ledger shows real events',await evaluate(`document.querySelectorAll('[data-testid="ledger-row"]').length>0`));
 // ---- capacity readout beside the dial: free, served and curtailed, from real observations ----
 const fig=await evaluate(`(()=>{const v=id=>document.querySelector('[data-testid="'+id+'"]');const a=v('main-ammeter').dataset;return{capacity:Number(a.capacity),reserved:Number(a.reserved),free:v('free-readout').dataset.value,served:v('served-readout').dataset.value,curtailed:v('curtailed-readout').dataset.value,text:['free-readout','served-readout','curtailed-readout'].map(id=>v(id).textContent)}})()`);
 check('free figure is capacity minus reserved',fig.free!==''&&Math.abs(Number(fig.free)-Math.max(0,fig.capacity-fig.reserved))<=0.11);
 check('served and curtailed figures are real numbers and curtailed is never negative',fig.served!==''&&fig.curtailed!==''&&Number(fig.served)>=0&&Number(fig.curtailed)>=0&&fig.text.every(t=>/\d(\.\d)? A$/.test(t)));
 // ---- Full ledger door ----
 await focusClick('ledger-open');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="ledger-door"]')`),5000);await sleep(300);
 check('Full ledger door opens and takes focus',await inDialog('ledger-door'));
 const leaderAudit=(await overview()).nodes.find(n=>n.online&&n.data?.state==='Leader')?.data?.audit??[];
 const doorRows=await evaluate(`document.querySelectorAll('[data-testid="ledger-door-row"]').length`);
 check('Full ledger lists every event the leader holds, up to 100',doorRows>0&&Math.abs(doorRows-Math.min(100,leaderAudit.length))<=2);
 check('Full ledger rows are newest first with all six columns',await evaluate(`(()=>{const ids=[...document.querySelectorAll('[data-testid="ledger-door-row"]')].map(r=>Number(r.querySelector('th').textContent));const head=[...document.querySelectorAll('[data-testid="ledger-door"] thead th')].map(h=>h.textContent);return ids.every((v,i)=>i===0||ids[i-1]>v)&&head.join()==='Event,Building,Entry,Amps,Version,Time'})()`));
 await setValue('ledger-door-filter','granted');await sleep(300);
 check('Full ledger kind filter narrows the rows and the caption counts them',await evaluate(`(()=>{const r=[...document.querySelectorAll('[data-testid="ledger-door-row"]')];const c=document.querySelector('[data-testid="ledger-door-caption"]').textContent;return r.length>0&&r.every(x=>x.dataset.kind==='granted')&&c.includes(r.length+' event')&&c.includes('matching')&&c.includes('PostgreSQL')})()`));
 await setValue('ledger-door-filter','all');await setValue('ledger-door-search','zzz-no-such-entry');await sleep(300);
 check('Full ledger search with no match shows no rows',await evaluate(`document.querySelectorAll('[data-testid="ledger-door-row"]').length===0`));
 check('Full ledger offers the Tear off export',await evaluate(`!document.querySelector('[data-testid="ledger-door-tear"]').disabled`));
 await escape();
 check('Escape closes the Full ledger door',await evaluate(`!document.querySelector('[data-testid="ledger-door"]')`));
 check('focus returns to the Full ledger button',await focusIs('ledger-open'));
 // ---- Cluster details door ----
 await focusClick('cluster-open');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="cluster-door"]')`),5000);await sleep(300);
 check('Cluster details door opens and takes focus',await inDialog('cluster-door'));
 const ov=await overview();const upNodes=ov.nodes.filter(n=>n.online).length;
 check('Cluster details lists every coordinator',await evaluate(`document.querySelectorAll('[data-testid="cluster-door-node"]').length===${ov.nodes.length}`));
 check('Cluster details shows exactly one leader and the right reachable count',await evaluate(`document.querySelectorAll('[data-testid="cluster-door-node"][data-role="Leader"]').length===1&&document.querySelector('[data-testid="cluster-fact"][data-fact="reachable"]').dataset.value==='${upNodes} of ${ov.nodes.length}'`));
 check('Cluster details states the database, majority, live feed and policy',await evaluate(`['postgres','majority','verified-at','feed','policy','fairness'].every(k=>{const e=document.querySelector('[data-testid="cluster-fact"][data-fact="'+k+'"]');return e&&e.dataset.value!==''})&&document.querySelector('[data-testid="cluster-fact"][data-fact="postgres"]').dataset.value==='Connected'&&document.querySelector('[data-testid="cluster-fact"][data-fact="majority"]').dataset.value==='Verified'`));
 await escape();
 check('Escape closes the Cluster details door',await evaluate(`!document.querySelector('[data-testid="cluster-door"]')`));
 check('focus returns to the Cluster details button',await focusIs('cluster-open'));
 // ---- second Chart recorder button, same tray ----
 await focusClick('recorder-open-bottom');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="recorder"]')`),5000);await sleep(300);
 check('bottom Chart recorder button opens the one tray and both buttons show it expanded',await evaluate(`document.querySelectorAll('[data-testid="recorder"]').length===1&&document.querySelector('[data-testid="recorder-open"]').getAttribute('aria-expanded')==='true'&&document.querySelector('[data-testid="recorder-open-bottom"]').getAttribute('aria-expanded')==='true'`));
 await click('recorder-close');await sleep(500);
 check('closing the tray returns focus to the bottom button that opened it',await focusIs('recorder-open-bottom'));
 await focusClick('recorder-open');await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="recorder"]')`),5000);await escape();
 check('the top button opens the same tray and Escape returns focus to it',await evaluate(`!document.querySelector('[data-testid="recorder"]')`)&&await focusIs('recorder-open'));
 check('four scenarios and the capacity proof exist',await evaluate(`document.querySelectorAll('[data-testid="scenario"]').length===4&&[...document.querySelectorAll('[data-testid="scenario"]')].every(s=>s.dataset.scenario&&s.querySelector('[data-testid="scenario-run"]'))&&!!document.querySelector('[data-testid="capacity-proof"]')&&!!document.querySelector('[data-testid="scenario-status"]')`));
 check('overload run and policy switch exist',await evaluate(`!!document.querySelector('[data-testid="overload-run"]')&&!!document.querySelector('[data-testid="policy-switch"]')`));
 await sleep(1500);
 await pressGuarded('leader-failover','scenario-cover','scenario-run');
 await waitFor(()=>evaluate(`document.querySelector('[data-testid="scenario-status"]')?.textContent.includes('Completed')`),240000);
 check('leader failover scenario completes from the UI',true);
 await waitFor(async()=>(await overview()).nodes.every(n=>n.online),60000);
 check('every coordinator is restored after the scenario',true);
 check('capacity proof reports no observed violation',await evaluate(`document.querySelector('[data-testid="capacity-proof"]').textContent.includes('No violation observed')&&document.querySelector('[data-testid="capacity-proof"]').dataset.state==='safe'`));
 check('violation counter is zero',await evaluate(`document.querySelector('[data-testid="violations"]').dataset.count==='0'`));
 check('observed timeline recorded the leader change',await evaluate(`document.querySelectorAll('[data-testid="timeline-item"]').length>0`));
 await sleep(1500);
 await screenshot('board-after-failover.png');
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(1000);
 check('mobile has no horizontal overflow',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 check('mobile still shows three feeders and three relays',await evaluate(`document.querySelectorAll('[data-testid="feeder"]').length===3&&document.querySelectorAll('[data-testid="relay"]').length===3`));
 await screenshot('board-mobile.png');
 check('no uncaught JavaScript errors',report.runtime_errors.length===0);
 report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1}
finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();await writeFile(path.join(out,'browser-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
