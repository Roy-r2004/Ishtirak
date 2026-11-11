// Builds preview/index.html: one self-contained file (JS and CSS inlined, fonts embedded as data URIs, demo mode forced on,
// no external requests). Uses the Vite JS API that is already a dev dependency; nothing new is installed.
import {build} from 'vite';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), tmp=path.join(root,'.preview-tmp'), outDir=path.join(root,'preview'), LIMIT=3*1024*1024;
await rm(tmp,{recursive:true,force:true});
await build({
 root,configFile:false,logLevel:'warn',base:'./',publicDir:false,
 define:{__PREVIEW__:'true'},
 build:{outDir:tmp,emptyOutDir:true,target:'es2022',assetsInlineLimit:100_000_000,cssCodeSplit:false,modulePreload:false,reportCompressedSize:false,rollupOptions:{output:{inlineDynamicImports:true},onwarn(w,next){if(w.code==='MODULE_LEVEL_DIRECTIVE')return;next(w)}}},
});
const files=await (await import('node:fs/promises')).readdir(path.join(tmp,'assets'));
const js=files.find(f=>f.endsWith('.js')), css=files.find(f=>f.endsWith('.css'));
if(!js||!css)throw Error('Vite output is missing the bundle or the stylesheet');
let html=await readFile(path.join(tmp,'index.html'),'utf8');
let code=await readFile(path.join(tmp,'assets',js),'utf8');
let style=await readFile(path.join(tmp,'assets',css),'utf8');
// Keep one font format (woff2) per face; every browser that can run this page reads it.
style=style.replace(/,\s*url\(data:font\/woff;base64,[^)]*\)\s*format\((["'])woff\1\)/g,'');
const external=style.match(/url\((?!["']?(?:data:|#))[^)]{0,80}/);
if(external)throw Error('The stylesheet still references an external file: '+external[0]);
const favicon='data:image/svg+xml;base64,'+(await readFile(path.join(root,'public','favicon.svg'))).toString('base64');
const safeCode=code.replace(/<\/script/gi,'<\\/script').replace(/<!--/g,'<\\!--');
const scriptTag=/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/, linkTag=/<link rel="stylesheet"[^>]*href="[^"]*"[^>]*>/, iconTag=/<link rel="icon"[^>]*>/;
for(const [name,re] of [['script',scriptTag],['stylesheet',linkTag],['icon',iconTag]])if(!re.test(html))throw Error(`index.html has no ${name} tag to replace`);
html=html.replace(scriptTag,'').replace(linkTag,()=>`<style>${style}</style>`).replace(iconTag,()=>`<link rel="icon" type="image/svg+xml" href="${favicon}"/>`);
html=html.replace('</body>',()=>`<script type="module">${safeCode}</script></body>`);
const ext=[...new Set([...html.matchAll(/(?:src|href)=["'](?!data:|#)([^"']+)["']/g)].map(m=>m[1]))];
if(ext.length)throw Error('External references left in index.html: '+ext.join(', '));
await mkdir(outDir,{recursive:true});
await writeFile(path.join(outDir,'index.html'),html);
await rm(tmp,{recursive:true,force:true});
const size=Buffer.byteLength(html);
console.log(`preview/index.html written: ${(size/1024).toFixed(0)} KiB (${size} bytes), limit ${(LIMIT/1024/1024).toFixed(0)} MiB`);
if(size>=LIMIT)throw Error('preview/index.html is over 3 MB');
