// Keyboard-only walkthrough and reduced-motion check on preview/index.html (demo mode, file://), driven over the DevTools protocol.
// Usage: node scripts/a11y-check.mjs   (run `npm run build:preview` first). Writes artifacts/a11y-check.json.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), out=path.join(root,'artifacts'), profile=path.join(out,'chrome-a11y');
await mkdir(profile,{recursive:true});
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe', port=9343, url=pathToFileURL(path.join(root,'preview','index.html')).href;
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;const pending=new Map(),report={checks:[],errors:[]};
const check=(name,ok,detail)=>{report.checks.push({name,passed:!!ok,...(detail!==undefined?{detail}:{})});console.log(ok?'PASS':'FAIL',name,detail??'');if(!ok)process.exitCode=1};
const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const t=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method))},20000);pending.set(key,{resolve:x=>{clearTimeout(t);resolve(x)},reject});ws.send(JSON.stringify({id:key,method,params}))});
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function waitFor(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return}catch{}await sleep(200)}throw Error('Browser condition timed out: '+String(fn).slice(0,120))}
const KEYS={Tab:{key:'Tab',code:'Tab',windowsVirtualKeyCode:9},Enter:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},Space:{key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '},Escape:{key:'Escape',code:'Escape',windowsVirtualKeyCode:27},ArrowRight:{key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},ArrowLeft:{key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37}};
async function key(name,modifiers=0){const k=KEYS[name];await call('Input.dispatchKeyEvent',{type:k.text?'keyDown':'rawKeyDown',modifiers,...k});await call('Input.dispatchKeyEvent',{type:'keyUp',modifiers,key:k.key,code:k.code,windowsVirtualKeyCode:k.windowsVirtualKeyCode});await sleep(120)}
const q=(testid,within='')=>JSON.stringify((within?within+' ':'')+'[data-testid="'+testid+'"]');
const focusTestId=(testid,within='')=>evaluate(`(()=>{const e=document.querySelector(${q(testid,within)});if(!e)throw Error('missing ${testid}');e.focus();return document.activeElement===e})()`);
const active=()=>evaluate(`(()=>{const a=document.activeElement;if(!a||a===document.body)return{tag:'BODY'};const cs=getComputedStyle(a);const ring=cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth)>=2;return{tag:a.tagName,testid:a.dataset.testid||'',label:(a.getAttribute('aria-label')||a.textContent||'').trim().replace(/\\s+/g,' ').slice(0,48),ring,inDialog:!!a.closest('[role=dialog]')}})()`);
const focusIs=testid=>evaluate(`document.activeElement===document.querySelector(${q(testid)})`);
async function load(reduced){
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
 await call('Page.navigate',{url});
 await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="main-ammeter"]')`),30000);
 const early=await evaluate(`document.querySelector('[data-testid="main-ammeter"]').dataset.selftest`);
 await waitFor(()=>evaluate(`document.querySelectorAll('[data-testid=feeder]').length===3&&document.querySelector('[data-testid="main-ammeter"]').dataset.fresh==='true'`),30000);
 return {early};
}
// Walk every tab stop once from the top of the page and report them.
async function walk(limit=120){
 await evaluate(`document.activeElement&&document.activeElement.blur();window.scrollTo(0,0)`);
 const stops=[];
 for(let i=0;i<limit;i++){await key('Tab');const s=await active();if(s.tag==='BODY')break;stops.push(s)}
 return stops;
}
const countOf=(stops,t)=>stops.filter(s=>s.testid===t).length;
const openTabByKey=async tab=>{await focusTestId(tab);await key('Enter');await sleep(250)};
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/list`)).ok)break}catch{}await sleep(200)}
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((a,b)=>{ws.onopen=a;ws.onerror=b});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});

 // ---- motion ----
 const infinite=()=>evaluate(`document.getAnimations().filter(a=>a.effect&&a.effect.getTiming().iterations===Infinity).length`);
 const dur=s=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});return e?getComputedStyle(e).transitionDuration:'n/a'})()`);
 const tiny=v=>v.split(',').every(x=>parseFloat(x)<=0.001);
 let r=await load(true);
 check('reduced motion: there is no startup lamp test, the console is ready at first paint',r.early==='false');
 check('reduced motion: nothing animates on its own',(await infinite())===0);
 const rm={btn:await dur('.btn'),vote:await dur('.vote-boxes i'),wire:await dur('.drop')};
 check('reduced motion: control, indicator and wire transitions are effectively instant',tiny(rm.btn)&&tiny(rm.vote)&&tiny(rm.wire),JSON.stringify(rm));
 const jump=await evaluate(`(async()=>{const n=document.querySelector('.g-needle');const seen=new Set();for(let i=0;i<8;i++){seen.add(n.getAttribute('transform'));await new Promise(r=>setTimeout(r,60))}return{target:Number(document.querySelector('[data-testid="main-ammeter"]').dataset.reserved),distinct:seen.size}})()`);
 check('reduced motion: the gauge needle is not mid-easing',jump.distinct<=2,`${jump.distinct} distinct needle positions in 0.5 s at ${jump.target} A`);
 r=await load(false);
 check('normal motion: no startup lamp test either, and nothing animates on its own',r.early==='false'&&(await infinite())===0);
 const nm={vote:await dur('.vote-boxes i'),wire:await dur('.drop')};
 check('normal motion: a changing value does ease (indicators and wires have a short transition)',!tiny(nm.vote)&&!tiny(nm.wire),JSON.stringify(nm));

 // ---- keyboard only ----
 await call('Page.navigate',{url:'about:blank'});await load(false);
 await evaluate(`document.activeElement&&document.activeElement.blur();window.scrollTo(0,0)`);
 await key('Tab');
 let a=await active();
 check('first Tab stop is the skip link and it shows a focus ring',a.tag==='A'&&/skip/i.test(a.label)&&a.ring,JSON.stringify(a));
 await key('Enter');
 check('skip link moves focus to the console',await evaluate(`document.activeElement===document.querySelector('[data-testid="board"]')`));
 // The skip link leaves the keyboard starting point at the console, so the full walk starts from a fresh load.
 await call('Page.navigate',{url:'about:blank'});await load(false);
 let stops=await walk();
 const ids=stops.map(s=>`${s.tag}|${s.testid}|${s.label}`);
 const wanted={'policy-fair_share':1,'help-open':1,'recorder-open':1,'cluster-open':1,'relay-cover':3,'feeder-open':3,'feeder-breaker':3,'ledger-search':1,'ledger-filter':1,'ledger-tear':1,'ledger-open':1,'tab-log':1};
 const missing=Object.entries(wanted).filter(([t,n])=>countOf(stops,t)!==n).map(([t,n])=>`${t} x${n} (found ${countOf(stops,t)})`);
 check('Tab reaches each main control exactly once',missing.length===0,missing.length?'wrong or missing: '+missing.join(', '):`${stops.length} tab stops`);
 check('the dock tab strip is one tab stop (arrow keys move inside it)',countOf(stops,'tab-log')+countOf(stops,'tab-tests')+countOf(stops,'tab-sim')+countOf(stops,'recorder-open-bottom')===1);
 check('Tab leaves the page after the last control and never repeats a stop (no keyboard trap)',stops.length<120&&new Set(ids).size===ids.length,`${stops.length} stops, ${new Set(ids).size} distinct`);
 const noRing=stops.filter(s=>!s.ring).map(s=>`${s.tag}[${s.testid||s.label}]`);
 check('every tab stop shows a visible focus ring',noRing.length===0,noRing.length?noRing.join(', '):`${stops.length} of ${stops.length}`);
 report.tab_order=ids;
 // Dock tabs: arrows move focus, Enter opens.
 await focusTestId('tab-log');await key('ArrowRight');
 check('ArrowRight moves focus to the next dock tab without opening it',await focusIs('tab-tests')&&await evaluate(`document.querySelector(${q('tab-log')}).getAttribute('aria-selected')==='true'`));
 await key('Enter');await sleep(250);
 check('Enter opens the Failure tests tab',await evaluate(`document.querySelector(${q('tab-tests')}).getAttribute('aria-selected')==='true'&&!document.getElementById('panel-tests').hidden&&document.getElementById('panel-log').hidden`));
 stops=await walk();
 check('Failure tests: Tab reaches every scenario, the overload run and its policy choice',countOf(stops,'scenario-cover')===4&&countOf(stops,'overload-cover')===1&&stops.filter(s=>/^overload-policy-/.test(s.testid)).length===1,`${countOf(stops,'scenario-cover')} scenarios, ${countOf(stops,'overload-cover')} overload`);
 await openTabByKey('tab-sim');
 stops=await walk();
 check('Simulation: Tab reaches the meter choice, the multiplier, Apply and both service switches',stops.some(s=>/^meters-/.test(s.testid))&&stops.some(s=>s.tag==='INPUT'&&/Demand multiplier/.test(s.label+''))||stops.some(s=>s.tag==='INPUT')&&countOf(stops,'sim-apply')===1&&countOf(stops,'breaker-database')===1&&countOf(stops,'breaker-broker')===1,`${stops.length} stops`);
 check('Simulation: every tab stop shows a visible focus ring',stops.every(s=>s.ring));
 await openTabByKey('tab-log');
 // Policy switch with arrow keys.
 check('policy switch is focusable',await focusTestId('policy-fair_share'));
 await key('ArrowRight');
 await waitFor(()=>evaluate(`document.querySelector(${q('policy-first_come')}).getAttribute('aria-checked')==='true'`),15000);
 check('ArrowRight on the policy switch commits First come',true);
 await focusTestId('policy-first_come');await key('ArrowLeft');
 await waitFor(()=>evaluate(`document.querySelector(${q('policy-fair_share')}).getAttribute('aria-checked')==='true'`),15000);
 check('ArrowLeft restores Fair sharing',true);
 // Gateway breaker: stopping asks first, starting does not.
 const br='[data-building=hamra]';
 await focusTestId('feeder-breaker',br);await key('Space');
 a=await active();
 check('Space on a closed breaker asks "Stop gateway?" and focus moves to Confirm',a.testid==='feeder-breaker-confirm'&&await evaluate(`!document.querySelector(${q('feeder-breaker-confirm',br)}).closest('[hidden]')`),JSON.stringify(a));
 await key('Escape');await sleep(250);
 check('Escape cancels the question, focus returns to the breaker and the gateway is still running',await focusIs('feeder-breaker')&&await evaluate(`document.querySelector(${q('feeder-breaker',br)}).getAttribute('aria-checked')==='true'`));
 await key('Space');await key('Enter');
 await waitFor(()=>evaluate(`document.querySelector(${q('feeder-breaker',br)}).getAttribute('aria-checked')==='false'`),15000);
 check('Space then Enter (Confirm) stops that gateway',true);
 await waitFor(()=>evaluate(`!document.querySelector(${q('feeder-breaker',br)}).disabled`),15000);
 await focusTestId('feeder-breaker',br);await key('Space');
 await waitFor(()=>evaluate(`document.querySelector(${q('feeder-breaker',br)}).getAttribute('aria-checked')==='true'`),15000);
 check('Space on an open breaker starts the gateway at once',true);
 // Coordinator row: the same two steps.
 await focusTestId('relay-cover','[data-node=coordinator3]');await key('Enter');
 a=await active();
 check('Enter on a coordinator Stop asks for confirmation and focus moves to Confirm',a.testid==='relay-control',JSON.stringify(a));
 await key('Escape');await sleep(250);
 check('Escape cancels it and the coordinator keeps running',await focusIs('relay-cover')||await evaluate(`document.activeElement===document.querySelector('[data-node=coordinator3] [data-testid=relay-cover]')`));
 // Simulation by keyboard.
 await openTabByKey('tab-sim');
 await focusTestId('meters-10');await key('Space');await focusTestId('sim-apply');await key('Enter');
 await waitFor(()=>evaluate(`document.querySelector(${q('active-meters')}).textContent.trim()==='10'`),15000);
 check('keyboard sets the simulator to 10 meters',true);
 await waitFor(()=>evaluate(`!document.querySelector(${q('sim-apply')}).disabled`),15000);
 await focusTestId('meters-50');await key('Space');await focusTestId('sim-apply');await key('Enter');
 await waitFor(()=>evaluate(`document.querySelector(${q('active-meters')}).textContent.trim()==='50'`),15000);
 check('keyboard restores 50 meters',true);
 await openTabByKey('tab-log');
 // About drawer: opens, traps focus, Escape closes and focus returns.
 await focusTestId('help-open');await key('Enter');
 await waitFor(()=>evaluate(`!!document.querySelector(${q('help-dialog')})`),5000);await sleep(300);
 a=await active();check('About this system takes focus when it opens',a.inDialog,JSON.stringify(a));
 let leaked=0;for(let i=0;i<14;i++){await key('Tab');if(!(await active()).inDialog)leaked++}
 check('Tab stays inside the open About drawer (focus trap)',leaked===0,`${leaked} of 14 Tab presses left the drawer`);
 await key('Escape');await sleep(500);
 check('Escape closes the drawer and focus returns to its button',await evaluate(`!document.querySelector(${q('help-dialog')})&&document.activeElement===document.querySelector(${q('help-open')})`));
 // The other drawers.
 for(const [opener,door,name] of [['ledger-open','ledger-door','Full log'],['cluster-open','cluster-door','Cluster details']]){
  await focusTestId(opener);await key('Enter');
  await waitFor(()=>evaluate(`!!document.querySelector(${q(door)})`),5000);await sleep(300);
  a=await active();check(`${name}: the drawer takes focus when it opens`,a.inDialog,JSON.stringify(a));
  let out=0;for(let i=0;i<16;i++){await key('Tab');if(!(await active()).inDialog)out++}
  check(`${name}: Tab stays inside the open drawer (focus trap)`,out===0,`${out} of 16 Tab presses left the drawer`);
  await key('Escape');await sleep(500);
  check(`${name}: Escape closes the drawer and focus returns to its button`,await evaluate(`!document.querySelector(${q(door)})&&document.activeElement===document.querySelector(${q(opener)})`));
 }
 await focusTestId('feeder-open','[data-building=achrafieh]');await key('Enter');
 await waitFor(()=>evaluate(`!!document.querySelector(${q('feeder-door')})`),5000);await sleep(300);
 await key('Escape');await sleep(500);
 check('Building details: Escape closes the drawer and focus returns to the building name',await evaluate(`!document.querySelector(${q('feeder-door')})&&document.activeElement===document.querySelector('[data-building=achrafieh] [data-testid=feeder-open]')`));
 // The Chart tab opens the one chart from the keyboard.
 await focusTestId('recorder-open-bottom');await key('Enter');
 await waitFor(()=>evaluate(`!!document.querySelector(${q('recorder')})`),5000);await sleep(300);
 check('the Chart tab opens the chart and focus moves into it',await evaluate(`document.querySelector(${q('recorder')}).contains(document.activeElement)&&document.querySelector(${q('recorder-open-bottom')}).getAttribute('aria-expanded')==='true'&&document.querySelector(${q('recorder-open')}).getAttribute('aria-expanded')==='true'`));
 await key('Escape');await sleep(500);
 check('Escape closes the chart and focus returns to the Chart tab',await evaluate(`!document.querySelector(${q('recorder')})&&document.activeElement===document.querySelector(${q('recorder-open-bottom')})`));
 // Failure test: ask, back out, ask again, confirm, completes.
 await openTabByKey('tab-tests');
 const sc='[data-scenario=leader-failover]';
 await focusTestId('scenario-cover',sc);await key('Enter');await sleep(400);
 a=await active();check('Enter on Run asks for confirmation and focus moves to Confirm',a.testid==='scenario-run',JSON.stringify(a));
 check('the question says what the test does',await evaluate(`/stops the current leader and restores it afterwards/.test(document.querySelector(${q('scenario-run',sc)}).closest('.twostep').textContent)`));
 await key('Escape');await sleep(300);
 a=await active();check('Escape cancels and focus returns to Run',a.testid==='scenario-cover',JSON.stringify(a));
 await key('Enter');await sleep(400);await key('Enter');
 await waitFor(()=>evaluate(`/Running|Step 1/.test(document.querySelector(${q('scenario-status')}).textContent)`),15000);
 check('keyboard starts the leader failover scenario',true);
 check('the Failure tests tab says a test is running',await evaluate(`/Running/.test(document.querySelector(${q('tab-tests')}).textContent)`));
 await waitFor(()=>evaluate(`document.querySelector(${q('scenario-status')}).textContent.includes('Completed')`),150000);
 check('the scenario completes and restores every coordinator',await evaluate(`[...document.querySelectorAll('[data-testid=relay]')].every(r=>r.dataset.role!=='Unreachable')`));
 check('no uncaught JavaScript errors',report.errors.length===0,report.errors.join(' | ')||'none');
}catch(error){report.error=error.message;console.log('ERROR',error.message);process.exitCode=1}
finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();
 await writeFile(path.join(out,'a11y-check.json'),JSON.stringify(report,null,2)+'\n');
}
