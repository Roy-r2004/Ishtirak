// WCAG contrast check of the console's colour tokens, light and dark. Reads the tokens straight from src/board/tokens.css so the
// numbers always describe what ships. Usage: node scripts/contrast-check.mjs   (exit code 1 when any pair is below its threshold)
import {readFileSync} from 'node:fs';
import path from 'node:path';
const css=readFileSync(path.resolve(import.meta.dirname,'..','src','board','tokens.css'),'utf8');
const block=(start)=>{const i=css.indexOf(start);if(i<0)throw Error('missing block '+start);const j=css.indexOf('}',i);return css.slice(i,j)};
const vars=(text)=>Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(m=>[m[1],m[2]]));
const light=vars(block(':root {')), dark={...light,...vars(block(':root[data-theme=\'dark\'] {'))};
// The automatic dark palette (media query) and the forced one (data-theme) are two copies of the same values; they must never drift apart.
const auto=vars(block(":root:not([data-theme='light']) {"));
const drift=Object.keys(dark).filter(k=>k in auto||dark[k]!==light[k]).filter(k=>auto[k]!==dark[k]);
if(drift.length){console.log('FAIL dark palettes differ for: '+drift.join(', '));process.exitCode=1}else console.log('PASS the automatic and forced dark palettes are identical ('+Object.keys(auto).length+' tokens)');
const rgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};
const ratio=(a,b)=>{const [x,y]=[lum(rgb(a)),lum(rgb(b))].sort((m,n)=>n-m);return (x+.05)/(y+.05)};
// [foreground, background, minimum ratio, what it is]. 4.5 = text, 3 = graphical objects and UI component boundaries.
const pairs=[
 ['ink','sheet',4.5,'body text on the sheet'],['ink','surface',4.5,'body text on a panel'],['ink','surface-2',4.5,'text on a table header'],
 ['ink-2','surface',4.5,'secondary text on a panel'],['ink-2','surface-2',4.5,'secondary text on a table header'],['ink-2','sheet',4.5,'secondary text on the sheet'],
 ['ink-3','surface',4.5,'muted text on a panel'],['ink-3','surface-2',4.5,'muted text on a table header'],['ink-3','sheet',4.5,'muted text on the sheet'],
 ['accent','surface',4.5,'accent text and links on a panel'],['accent','sheet',4.5,'accent text on the sheet'],['accent-ink','accent',4.5,'text on an accent button'],
 ['accent-text','accent-tint',4.5,'text on a selected tint'],['ink','accent-tint',4.5,'body text on a selected tint'],
 ['green','surface',4.5,'status text: ok'],['amber','surface',4.5,'status text: warning'],['red','surface',4.5,'status text: fault'],
 ['green','surface-2',4.5,'status text: ok on header'],['amber','surface-2',4.5,'status text: warning on header'],['red','surface-2',4.5,'status text: fault on header'],
 ['red-ink','red-tint',4.5,'text on an alarm banner'],['amber-ink','amber-tint',4.5,'text on a notice banner'],['green-ink','green-tint',4.5,'text on an ok banner'],
 ['line-strong','surface',3,'control borders on a panel'],['line-strong','sheet',3,'control borders on the sheet'],
 ['accent','surface',3,'energised line and focus ring'],['green','surface',3,'status symbol: ok'],['amber','surface',3,'status symbol: warning'],['red','surface',3,'status symbol: fault'],
 ['wire-off','surface',3,'de-energised line'],['ink-2','surface',3,'dimension lines and gauge ticks'],
];
let bad=0;
for(const [name,theme] of [['light',light],['dark',dark]]){
 console.log(`\n${name} theme`);
 for(const [f,b,min,what] of pairs){
  if(!theme[f]||!theme[b]){console.log(`  MISSING token for: ${what} (${f} on ${b})`);bad++;continue}
  const r=ratio(theme[f],theme[b]),ok=r>=min;if(!ok)bad++;
  console.log(`  ${ok?'PASS':'FAIL'} ${r.toFixed(2).padStart(5)} (>= ${min})  ${what}  [${f} ${theme[f]} on ${b} ${theme[b]}]`);
 }
}
console.log(bad?`\n${bad} pair(s) below threshold`:'\nall pairs meet WCAG AA');
process.exitCode=bad?1:0;
