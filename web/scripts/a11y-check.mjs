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
const focusTestId=(testid,within='')=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify((within?within+' ':'')+'[data-testid="'+testid+'"]')});if(!e)throw Error('missing ${testid}');e.focus();return document.activeElement===e})()`);
const active=()=>evaluate(`(()=>{const a=document.activeElement;if(!a||a===document.body)return{tag:'BODY'};const rangeThumb=a.matches('input[type=range]');const cs=getComputedStyle(a,rangeThumb?'::-webkit-slider-thumb':null);const ring=(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth)>0)||cs.boxShadow!=='none';return{tag:a.tagName,range:rangeThumb,testid:a.dataset.testid||'',label:(a.getAttribute('aria-label')||a.textContent||a.className&&a.className.baseVal===undefined&&a.className||'').trim().replace(/\\s+/g,' ').slice(0,48),ring,inDialog:!!a.closest('[role=dialog]')}})()`);
async function load(reduced){
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
 await call('Page.navigate',{url});
 const start=Date.now();
 await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="main-ammeter"]')`),30000);
 const early=await evaluate(`document.querySelector('[data-testid="main-ammeter"]').dataset.selftest`);
 await waitFor(()=>evaluate(`document.querySelectorAll('[data-testid=feeder]').length===3&&document.querySelector('[data-testid="main-ammeter"]').dataset.selftest==='false'&&document.querySelector('[data-testid="main-ammeter"]').dataset.fresh==='true'`),30000);
 return {early,ms:Date.now()-start};
}
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/list`)).ok)break}catch{}await sleep(200)}
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((a,b)=>{ws.onopen=a;ws.onerror=b});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});

 // ---- reduced motion ----
 let r=await load(true);
 check('reduced motion: the load self-test is skipped',r.early==='false',`selftest=${r.early} right after first paint`);
 const rm=await evaluate(`(()=>{const d=s=>{const e=document.querySelector(s);return e?getComputedStyle(e).transitionDuration:'n/a'};return{lever:d('.lever-handle'),knob:d('.knob'),meter:d('.meter-bar i')}})()`);
 const tiny=v=>v.split(',').every(x=>parseFloat(x)<=0.001);
 check('reduced motion: lever and knob transitions are effectively instant',tiny(rm.lever)&&tiny(rm.knob),JSON.stringify(rm));
 const jump=await evaluate(`(async()=>{const n=document.querySelector('.needle');const target=Number(document.querySelector('[data-testid="main-ammeter"]').dataset.reserved);const seen=new Set();for(let i=0;i<8;i++){seen.add(n.getAttribute('transform'));await new Promise(r=>setTimeout(r,60))}return{target,distinct:seen.size}})()`);
 check('reduced motion: the needle is not mid-spring',jump.distinct<=2,`${jump.distinct} distinct needle positions in 0.5 s at ${jump.target} A`);
 // ---- normal motion contrast: the self-test does run ----
 r=await load(false);
 check('normal motion: the load self-test runs (lamps lit, needle sweeps)',r.early==='true',`selftest=${r.early} right after first paint, finished after ${(r.ms/1000).toFixed(1)} s`);

 // ---- keyboard only ----
 await call('Page.navigate',{url:'about:blank'});await load(false);
 await evaluate(`document.activeElement&&document.activeElement.blur();window.scrollTo(0,0)`);
 await key('Tab');
 let a=await active();
 check('first Tab stop is the skip link and it shows a focus ring',a.tag==='A'&&/skip/i.test(a.label)&&a.ring,JSON.stringify(a));
 await key('Enter');
 check('skip link moves focus to the board',await evaluate(`document.activeElement===document.querySelector('[data-testid="board"]')`));
 // Walk every tab stop once.
 await evaluate(`document.activeElement.blur()`);
 const stops=[];let trapped=false;
 for(let i=0;i<260;i++){await key('Tab');const s=await active();if(s.tag==='BODY'){break}stops.push(s)}
 const ids=stops.map(s=>`${s.tag}|${s.testid}|${s.label}`);
 const count=t=>stops.filter(s=>s.testid===t).length;
 const wanted={'help-open':1,'recorder-open':1,'relay-cover':3,'feeder-open':3,'feeder-breaker':3,'ledger-search':1,'ledger-filter':1,'ledger-tear':1,'scenario-cover':4,'overload-cover':1,'sim-apply':1,'breaker-database':1,'breaker-broker':1,'fader':1,'ledger-open':1,'cluster-open':1,'recorder-open-bottom':1};
 const missing=Object.entries(wanted).filter(([t,n])=>t==='fader'?!stops.some(s=>s.tag==='INPUT'):count(t)!==n).map(([t,n])=>`${t} x${n}`);
 check('Tab reaches each main control exactly once',missing.length===0,missing.length?'wrong or missing: '+missing.join(', '):`${stops.length} tab stops`);
 check('Tab leaves the page after the last control and never repeats a stop (no keyboard trap)',stops.length<250&&new Set(ids).size===ids.length,`${stops.length} stops, ${new Set(ids).size} distinct`);
 // A range input's ring lives on its thumb pseudo-element, which getComputedStyle cannot report; it is judged from a screenshot instead.
 const noRing=stops.filter(s=>!s.ring&&!s.range).map(s=>`${s.tag}[${s.testid||s.label}]`);
 check('every tab stop shows a visible focus ring (the range fader is judged from shots/a11y-focus-fader.png)',noRing.length===0,noRing.length?noRing.join(', '):`${stops.length-stops.filter(s=>s.range).length} of ${stops.length}`);
 report.tab_order=ids;
 const clip=async(name,selector)=>{const b=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.max(0,r.x-14),y:Math.max(0,r.y-14),width:r.width+28,height:r.height+28}})()`);const r=await call('Page.captureScreenshot',{format:'png',clip:{...b,scale:2}});await writeFile(path.join(root,'shots',name),Buffer.from(r.data,'base64'));console.log('saved',path.join(root,'shots',name))};
 await evaluate(`document.activeElement.blur()`);await focusTestId('feeder-breaker','[data-building=hamra]');await key('Tab');await key('Tab');
 await evaluate(`document.querySelector('.fader').focus()`);await key('ArrowRight');await key('ArrowLeft');await sleep(300);
 await clip('a11y-focus-fader.png','[data-testid=sim]');
 await focusTestId('scenario-cover','[data-scenario=majority-loss]');await sleep(200);
 await clip('a11y-focus-cover.png','[data-testid=test-panel]');
 await focusTestId('feeder-breaker','[data-building=mar_mikhael]');await sleep(200);
 await clip('a11y-focus-breaker.png','[data-testid=feeders]');
 // Policy switch with arrow keys.
 check('policy switch is focusable',await focusTestId('policy-fair_share'));
 await key('ArrowRight');
 await waitFor(()=>evaluate(`document.querySelector('[data-testid="policy-first_come"]').getAttribute('aria-checked')==='true'`),15000);
 check('ArrowRight on the policy switch commits First come',true);
 await focusTestId('policy-first_come');await key('ArrowLeft');
 await waitFor(()=>evaluate(`document.querySelector('[data-testid="policy-fair_share"]').getAttribute('aria-checked')==='true'`),15000);
 check('ArrowLeft restores Fair sharing',true);
 // Gateway breaker with Space.
 await focusTestId('feeder-breaker','[data-building=hamra]');await key('Space');
 await waitFor(()=>evaluate(`document.querySelector('[data-building=hamra] [data-testid=feeder-breaker]').getAttribute('aria-checked')==='false'`),15000);
 check('Space on a feeder breaker stops that gateway',true);
 await waitFor(()=>evaluate(`!document.querySelector('[data-building=hamra] [data-testid=feeder-breaker]').disabled`),15000);
 await focusTestId('feeder-breaker','[data-building=hamra]');await key('Space');
 await waitFor(()=>evaluate(`document.querySelector('[data-building=hamra] [data-testid=feeder-breaker]').getAttribute('aria-checked')==='true'`),15000);
 check('Space again starts it',true);
 // Meters rotary + Apply.
 await focusTestId('meters-10');await key('Space');await focusTestId('sim-apply');await key('Enter');
 await waitFor(()=>evaluate(`document.querySelector('[data-testid=active-meters]').textContent.trim()==='10'`),15000);
 check('keyboard sets the simulator to 10 meters',true);
 await waitFor(()=>evaluate(`!document.querySelector('[data-testid=sim-apply]').disabled`),15000);
 await focusTestId('meters-50');await key('Space');await focusTestId('sim-apply');await key('Enter');
 await waitFor(()=>evaluate(`document.querySelector('[data-testid=active-meters]').textContent.trim()==='50'`),15000);
 check('keyboard restores 50 meters',true);
 // Help dialog: opens, traps focus, Escape closes and focus returns.
 await focusTestId('help-open');await key('Enter');
 await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=help-dialog]')`),5000);
 await sleep(300);
 a=await active();check('help dialog takes focus when it opens',a.inDialog,JSON.stringify(a));
 let leaked=0;for(let i=0;i<14;i++){await key('Tab');if(!(await active()).inDialog)leaked++}
 check('Tab stays inside the open dialog (focus trap)',leaked===0,`${leaked} of 14 Tab presses left the dialog`);
 await key('Escape');await sleep(500);
 check('Escape closes the dialog and focus returns to its button',await evaluate(`!document.querySelector('[data-testid=help-dialog]')&&document.activeElement===document.querySelector('[data-testid=help-open]')`));
 // The two new doors: opened with Enter, focus trapped, Escape closes, focus returns to the button.
 for(const [opener,door,name] of [['ledger-open','ledger-door','Full ledger'],['cluster-open','cluster-door','Cluster details']]){
  await focusTestId(opener);await key('Enter');
  await waitFor(()=>evaluate(`!!document.querySelector('[data-testid="${door}"]')`),5000);await sleep(300);
  a=await active();check(`${name}: the door takes focus when it opens`,a.inDialog,JSON.stringify(a));
  let out=0;for(let i=0;i<16;i++){await key('Tab');if(!(await active()).inDialog)out++}
  check(`${name}: Tab stays inside the open door (focus trap)`,out===0,`${out} of 16 Tab presses left the door`);
  await key('Escape');await sleep(500);
  check(`${name}: Escape closes the door and focus returns to its button`,await evaluate(`!document.querySelector('[data-testid="${door}"]')&&document.activeElement===document.querySelector('[data-testid="${opener}"]')`));
 }
 // The bottom Chart recorder button toggles the same tray from the keyboard.
 await focusTestId('recorder-open-bottom');await key('Enter');
 await waitFor(()=>evaluate(`!!document.querySelector('[data-testid=recorder]')`),5000);await sleep(300);
 check('bottom Chart recorder button opens the tray and focus moves into it',await evaluate(`document.querySelector('[data-testid=recorder]').contains(document.activeElement)&&document.querySelector('[data-testid=recorder-open-bottom]').getAttribute('aria-expanded')==='true'&&document.querySelector('[data-testid=recorder-open]').getAttribute('aria-expanded')==='true'`));
 await key('Escape');await sleep(500);
 check('Escape closes the tray and focus returns to the bottom button',await evaluate(`!document.querySelector('[data-testid=recorder]')&&document.activeElement===document.querySelector('[data-testid=recorder-open-bottom]')`));
 // Guarded scenario button: cover, press, status.
 const sc='[data-scenario=leader-failover]';
 await focusTestId('scenario-cover',sc);await key('Enter');await sleep(500);
 a=await active();check('Enter lifts the cover and focus moves to the press button',a.testid==='scenario-run',JSON.stringify(a));
 await key('Escape');await sleep(300);
 a=await active();check('Escape closes the cover and focus returns to it',a.testid==='scenario-cover',JSON.stringify(a));
 await key('Enter');await sleep(500);await key('Enter');
 await waitFor(()=>evaluate(`/Running|Step 1/.test(document.querySelector('[data-testid=scenario-status]').textContent)`),15000);
 check('keyboard starts the leader failover scenario',true);
 await waitFor(()=>evaluate(`document.querySelector('[data-testid=scenario-status]').textContent.includes('Completed')`),150000);
 check('the scenario completes and restores every coordinator',await evaluate(`[...document.querySelectorAll('[data-testid=relay]')].every(r=>r.dataset.role!=='Unreachable')`));
 check('no uncaught JavaScript errors',report.errors.length===0,report.errors.join(' | ')||'none');
}catch(error){report.error=error.message;console.log('ERROR',error.message);process.exitCode=1}
finally{
 if(ws){try{await call('Browser.close')}catch{}ws.close()}
 child.kill();
 await writeFile(path.join(out,'a11y-check.json'),JSON.stringify(report,null,2)+'\n');
}
