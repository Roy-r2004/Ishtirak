// Dependency-free browser checks using Chrome's local DevTools protocol.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), out=path.join(root,'artifacts');
await mkdir(out,{recursive:true});
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port=9238;
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(out,'chrome-profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;const pending=new Map();const report={checks:[],runtime_errors:[],websocket_frames:0};
function check(name,ok){report.checks.push({name,passed:!!ok});if(!ok)throw Error(name)}
async function waitFor(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return}catch{}await sleep(250)}throw Error('Browser condition timed out')}
function call(method,params={}){return new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method))},15000);pending.set(key,{resolve:x=>{clearTimeout(timer);resolve(x)},reject});ws.send(JSON.stringify({id:key,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value}
async function click(text){return evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Button missing');b.click();return true})()`)}
// Full-page capture: resize the viewport to the page height so fixed elements (the sidebar) span the whole image, then restore it.
async function screenshot(name){const dims=await evaluate(`({w:innerWidth,h:innerHeight})`);const layout=await call('Page.getLayoutMetrics');const mobile=dims.w<600;await call('Emulation.setDeviceMetricsOverride',{width:dims.w,height:Math.ceil(layout.cssContentSize.height),deviceScaleFactor:1,mobile});await sleep(400);const r=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,name),Buffer.from(r.data,'base64'));await call('Emulation.setDeviceMetricsOverride',{width:dims.w,height:dims.h,deviceScaleFactor:1,mobile});await sleep(300)}
try{
 await waitFor(async()=>{const r=await fetch(`http://127.0.0.1:${port}/json/list`);return r.ok},20000);
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result)}else if(msg.method==='Runtime.exceptionThrown')report.runtime_errors.push(msg.params.exceptionDetails.text);else if(msg.method==='Network.webSocketFrameReceived')report.websocket_frames++};
 await call('Runtime.enable');await call('Network.enable');await call('Page.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:'http://127.0.0.1:8088'});
 await waitFor(()=>evaluate(`document.querySelectorAll('.building-card').length===3 && document.body.innerText.includes('Grid operational')`),30000);
 await sleep(5000);
 check('desktop has three buildings and three coordinators',await evaluate(`document.querySelectorAll('.building-card').length===3&&document.querySelectorAll('.node-card').length===3`));
 check('desktop has no horizontal overflow',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 check('live WebSocket frames received',report.websocket_frames>0);
 await screenshot('dashboard-desktop.png');
 await evaluate(`document.querySelector('[aria-label="About this prototype"]').click()`);
 check('help dialog opens and receives focus',await evaluate(`!!document.querySelector('[role="dialog"]')&&document.querySelector('[role="dialog"]').contains(document.activeElement)`));
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 await waitFor(()=>evaluate(`!document.querySelector('[role="dialog"]')`));
 check('Escape closes help dialog',true);
 await click('Simulation lab');await click('10 meters');await click('Apply simulation');
 await waitFor(async()=>{const d=await(await fetch('http://127.0.0.1:8088/api/overview')).json();return d.meters.data.meter_count===10});
 check('UI changes the real meter simulator to ten',true);
 await click('50 meters');await waitFor(()=>evaluate(`![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Apply simulation')?.disabled`));await click('Apply simulation');
 await waitFor(async()=>{const d=await(await fetch('http://127.0.0.1:8088/api/overview')).json();return d.meters.data.meter_count===50});
 check('UI restores fifty meters',true);
 await click('Activity log');check('audit table shows real events',await evaluate(`document.querySelectorAll('tbody tr').length>0`));
 await click('Resilience lab');
 check('resilience lab shows four scenarios and the capacity proof',await evaluate(`document.querySelectorAll('.rl-card').length===4&&!!document.querySelector('[aria-label="Capacity proof"]')&&!!document.querySelector('[aria-label="Raft nodes"]')`));
 check('resilience lab has no horizontal overflow',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 await sleep(1500);
 await screenshot('dashboard-lab-desktop.png');
 await click('Run Leader failover');
 await waitFor(()=>evaluate(`document.querySelector('[aria-label="Scenario status"] strong')?.textContent.includes('Completed')`),240000);
 check('leader failover scenario completes from the UI',true);
 await waitFor(async()=>{const d=await(await fetch('http://127.0.0.1:8088/api/overview')).json();return d.nodes.every(n=>n.online)},60000);
 check('every coordinator is restored after the scenario',true);
 check('capacity proof reports no observed violation',await evaluate(`document.querySelector('[aria-label="Capacity proof"]').textContent.includes('No violation observed')`));
 check('observed timeline recorded the leader change',await evaluate(`document.querySelectorAll('.rl-timeline li').length>0`));
 await sleep(1500);
 await screenshot('dashboard-lab-after-failover.png');
 await click('Overview');
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(1000);
 check('mobile has no horizontal overflow',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 await evaluate(`document.querySelector('[aria-label="Open navigation"]').click()`);check('mobile navigation opens',await evaluate(`document.querySelector('.sidebar').classList.contains('open')`));
 await click('Overview');await sleep(500);await screenshot('dashboard-mobile.png');
 check('no uncaught JavaScript errors',report.runtime_errors.length===0);
 report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1}
finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();await writeFile(path.join(out,'browser-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
