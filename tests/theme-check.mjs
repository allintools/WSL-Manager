import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.WSL_PREVIEW_DEPS?path.join(process.env.WSL_PREVIEW_DEPS,'playwright'):'playwright');
const configModule=path.resolve('tests/.theme-config-check.mjs');
await build({entryPoints:['src/theme/config.ts'],outfile:configModule,bundle:true,format:'esm',platform:'node'});
const {normalizePreferences,defaults,presets,readPreferences,safeWallpaper,THEME_STORAGE_KEY}=await import(pathToFileURL(configModule).href);
try {
 assert.deepEqual(normalizePreferences(null),defaults);
 assert.equal(normalizePreferences({scale:999,preset:'__proto__',panelOpacity:0,glassBlur:999}).scale,100);
 assert.equal(normalizePreferences({panelOpacity:0,glassBlur:999}).panelOpacity,64);
 assert.equal(normalizePreferences({glassBlur:999}).glassBlur,32);
 assert.equal(normalizePreferences({wallpaper:'custom',customWallpaper:'javascript:alert(1)'}).wallpaper,'preset');
 assert.equal(safeWallpaper('data:image/svg+xml;base64,AA=='),false);
 assert.equal(readPreferences({getItem:()=>{throw Error('blocked')}}).preset,'alpine');
 assert.equal(readPreferences({getItem:k=>k==='theme'?'light':null}).preset,'light');
 assert.equal(readPreferences({getItem:k=>k===THEME_STORAGE_KEY?'broken':null}).preset,'alpine');
 const rgb=hex=>hex.slice(1).match(/../g).map(v=>parseInt(v,16));
 const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
 for(const [name,preset] of Object.entries(presets)){
   const t=preset.tokens,guard=Number(t.wallpaperGuard),wall=preset.dark?255:0,background=rgb(t.overlay).map(v=>v*guard+wall*(1-guard));
   for(const surface of ['canvas','sidebar']){
     const composed=t[surface].split(' ').map((v,i)=>Number(v)*.64+background[i]*.36);
     for(const text of ['text','muted','accentInk'])assert(contrast(rgb(t[text]),composed)>=4.5,`contrast ${name}/${surface}/${text}: ${contrast(rgb(t[text]),composed)}`);
   }
   assert(contrast(rgb(t.onAccent),rgb(t.accent))>=4.5,`${name} primary button contrast`);
 }
} finally {await unlink(configModule)}
const output=path.resolve('outputs/theme-final');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1320,height:880}});
await context.addInitScript(()=>{
 const callbacks=new Map();let next=1;window.__TEST_CALLS__=[];
 window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:f=>{callbacks.set(next,f);return next++},unregisterCallback:id=>callbacks.delete(id),invoke:async(cmd,args={})=>{
   window.__TEST_CALLS__.push({cmd,...args});
   if(cmd==='plugin:event|listen')return next++;
   if(cmd.startsWith('plugin:'))return null;
   if(cmd==='terminal_create'||cmd==='terminal_resize'||cmd==='terminal_close')return null;
   if(cmd==='desktop_rpc'){if(args.method==='users')return {default:'tester',arch:'amd64',users:[{name:'tester',uid:1000,home:'/home/tester',default:true,root:false}]};if(args.method==='connect')return {meta:{version:'0.2.0',os:'Ubuntu 24.04',arch:'amd64',user:'tester',home:'/home/tester',root:false},proxyPort:12345,user:'tester'};return {ok:true};}
   if(cmd==='browser_rpc')return {active:1,tabs:[{id:1,url:'https://example.com'}]};
   if(cmd==='rpc'){
    if(args.method==='distro.list')return [{name:'Ubuntu-24.04',running:true,default:true,version:2},{name:'Debian-13',running:false,default:false,version:2}];
    if(args.method==='host.info')return {version:'WSL 2.7.14\nLinux kernel 6.6',status:'WSL 2'};
    if(args.method==='config.read')return {path:'C:\\Users\\test\\.wslconfig',content:'[wsl2]\nmemory=8GB\n'};
    if(args.method==='system.info')return {os:'Ubuntu 24.04',arch:'amd64',user:'tester',home:'/home/tester',systemd:true};
    if(args.method==='fs.list')return {path:'/home/tester',entries:[{name:'theme-test.txt',path:'/home/tester/theme-test.txt',isDir:false,isLink:false,size:32,mode:'0644',modified:1791500000}]};
    if(args.method==='fs.read')return {path:args.params.path,content:'theme test\n中文内容\n',version:'test'};
    if(args.method==='metrics')return {time:1791500000,cpu:15,cores:[15,10],memory:{used:1e9,total:8e9,available:7e9,cached:1e8,swapUsed:0,swapTotal:1e9},disk:{used:2e9,total:20e9,free:18e9},uptime:500,processCount:32,processRss:1e8,rx:0,tx:0,diskRead:0,diskWrite:0,load:[.1,.1,.1]};
    if(args.method==='processes')return [];
    if(args.method==='network')return {interfaces:[],ports:[],dns:'localhost'};
    return {entries:[],available:true,output:'test'};
   }
   throw Error(`Unexpected command ${cmd}`);
 }};
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=process.env.WSL_PREVIEW_URL||'http://127.0.0.1:1421';
const checks=[];
async function appearance(){await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('.appearance-settings').waitFor()}
async function range(label,value){await page.getByRole('slider',{name:label,exact:true}).evaluate((el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.waitForTimeout(40)}
async function pref(){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)),THEME_STORAGE_KEY)}
async function geometry(){return page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,filter:getComputedStyle(document.querySelector('.appearance-heading')).filter,rootZoom:getComputedStyle(document.getElementById('root')).zoom,sidebarHeight:document.querySelector('.sidebar').getBoundingClientRect().height}))}
try {
 await page.goto(base,{waitUntil:'networkidle'});await appearance();
 for(const viewport of [{width:1912,height:956},{width:1320,height:880},{width:920,height:650}]){
  await page.setViewportSize(viewport);
  for(const theme of ['Alpine','Dark','Light']){
   await page.getByRole('button',{name:`${theme} 主题`,exact:true}).click();
   for(const scale of [90,100,110,125,150]){
    await page.getByRole('button',{name:`${scale}%`,exact:true}).click();
    await page.waitForTimeout(60);const g=await geometry();assert(g.scroll<=g.width+2,`overflow ${theme}/${scale}/${viewport.width}: ${JSON.stringify(g)}`);assert.equal(Number(g.rootZoom),scale/100);assert.equal(g.filter,'none');
    assert(g.sidebarHeight<=viewport.height+2);checks.push({theme,scale,viewport:viewport.width,...g});
   }
   await page.getByRole('button',{name:'100%',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.appearance-scale button[aria-pressed=true]')?.textContent==='100%');await page.evaluate(()=>window.scrollTo(0,0));
   if(viewport.width===1320)await page.screenshot({path:path.join(output,`appearance-${theme.toLowerCase()}.png`)});
  }
 }
 await page.setViewportSize({width:1320,height:880});await page.getByRole('button',{name:'Alpine 主题',exact:true}).click();
 await page.getByRole('button',{name:'3D',exact:true}).click();assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.appearance-surface')).boxShadow!=='none'),true);
 await page.getByRole('button',{name:'Flat',exact:true}).click();assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.appearance-surface')).boxShadow),'none');
 for(const [label,value,key] of [['壁纸不透明度',45,'wallpaperOpacity'],['面板不透明度',80,'panelOpacity'],['背景模糊',12,'wallpaperBlur'],['磨砂强度',25,'glassBlur'],['遮罩强度',50,'overlay']]){
  await range(label,value);assert.equal((await pref())[key],value);
 }
 assert.equal(await page.locator('.theme-wallpaper').evaluate(el=>getComputedStyle(el).opacity),'0.45');assert.equal(await page.locator('.theme-wallpaper').evaluate(el=>getComputedStyle(el).filter),'blur(12px)');assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).backdropFilter),'blur(25px)');assert.equal(await page.locator('.theme-overlay').evaluate(el=>getComputedStyle(el).opacity),'0.5');
 await page.getByRole('switch',{name:'低性能模式'}).check();assert.equal(await page.locator('.theme-wallpaper').evaluate(el=>getComputedStyle(el).filter),'blur(0px)');assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).backdropFilter),'none');await page.getByRole('switch',{name:'低性能模式'}).uncheck();assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).backdropFilter),'blur(25px)');
 await page.getByLabel('壁纸来源',{exact:true}).selectOption('none');assert.equal(await page.locator('.theme-wallpaper').evaluate(el=>getComputedStyle(el).backgroundImage),'none');await page.getByLabel('壁纸来源',{exact:true}).selectOption('forest');
 await page.getByLabel('选择壁纸文件').setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await page.getByRole('alert').filter({hasText:'请选择 PNG'}).waitFor();assert.equal((await pref()).wallpaper,'forest');
 await page.getByLabel('选择壁纸文件').setInputFiles('public/wallpapers/alpine.webp');await page.getByRole('button',{name:'更换壁纸',exact:true}).waitFor({state:'visible'});await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).wallpaper==='custom',THEME_STORAGE_KEY);assert((await pref()).customWallpaper.startsWith('data:image/webp'));
 await page.getByRole('button',{name:'125%',exact:true}).click();await page.getByRole('button',{name:'Light 主题',exact:true}).click();const saved=await pref();await page.reload({waitUntil:'networkidle'});await appearance();assert.deepEqual(await pref(),saved);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');assert.equal(await page.locator('#root').evaluate(el=>getComputedStyle(el).zoom),'1.25');
 const second=await context.newPage();await second.goto(base,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Dark 主题',exact:true}).click();await second.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await second.close();
 await page.getByRole('button',{name:'恢复默认',exact:true}).click();assert.deepEqual(await pref(),defaults);await page.getByRole('button',{name:'工作台',exact:true}).click();await page.screenshot({path:path.join(output,'workspace-alpine.png')});
 // Existing Linux desktop sessions must survive appearance changes; scaled dragging uses CSS coordinates.
 await page.locator('button.distro-nav[title="Ubuntu-24.04"]').click();await page.locator('.desktop-launchers').waitFor();await page.locator('.desktop-launchers button[title="打开文件"]').click();await page.locator('.desktop-window').waitFor();const id=await page.locator('.desktop-window').getAttribute('style');
 await appearance();await page.getByRole('button',{name:'150%',exact:true}).click();await page.locator('button.distro-nav[title="Ubuntu-24.04"]').click();const handle=page.locator('.desktop-resize').first();await handle.scrollIntoViewIfNeeded();const hb=await handle.boundingBox();await page.mouse.move(hb.x+8,hb.y+8);await page.mouse.down();await page.mouse.move(hb.x-400,hb.y-160);await page.mouse.up();const title=page.locator('.desktop-window-title').first();await title.scrollIntoViewIfNeeded();const before=await title.boundingBox();await page.mouse.move(before.x+30,before.y+15);await page.mouse.down();await page.mouse.move(before.x+90,before.y+45);await page.mouse.up();const after=await title.boundingBox();assert(Math.abs(after.x-before.x-60)<3);assert(Math.abs(after.y-before.y-30)<3);assert(id);
 await page.screenshot({path:path.join(output,'desktop-scale150.png')});
 await appearance();await page.getByRole('button',{name:'100%',exact:true}).click();await page.locator('button.distro-nav[title="Ubuntu-24.04"]').click();await page.locator('.desktop-window-controls button[title="最小化"]').first().click();await page.locator('.desktop-launchers button[title="打开终端"]').click();await page.locator('.xterm').waitFor();const creations=await page.evaluate(()=>window.__TEST_CALLS__.filter(c=>c.cmd==='terminal_create').length);await appearance();await page.getByRole('button',{name:'Light 主题',exact:true}).click();await page.locator('button.distro-nav[title="Ubuntu-24.04"]').click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.__TEST_CALLS__.filter(c=>c.cmd==='terminal_create').length),creations);
 await page.locator('.desktop-window-controls button[title="最小化"]').last().click();await page.locator('.desktop-taskbar').getByRole('button',{name:'文件',exact:true}).click();await page.getByRole('button',{name:'theme-test.txt',exact:true}).click();await page.locator('.monaco-editor').waitFor();await page.waitForTimeout(200);assert.equal(await page.locator('.monaco-editor').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(244, 248, 239)');
 await page.screenshot({path:path.join(output,'desktop-editor-light.png')});
 await page.locator('.monaco-editor textarea').first().focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('KEEP_THEME_CONTENT');await page.waitForFunction(()=>document.querySelector('.editor-heading')?.textContent.includes('•'));
 await appearance();await page.getByRole('button',{name:'Dark 主题',exact:true}).click();await page.locator('button.distro-nav[title="Ubuntu-24.04"]').click();await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.includes('KEEP_THEME_CONTENT'));assert.equal(await page.locator('.monaco-editor').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(21, 30, 24)');
 await appearance();const reduced=await context.newCDPSession(page);await reduced.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await page.waitForFunction(()=>document.documentElement.dataset.performance==='low');assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).backdropFilter),'none');assert(await page.getByRole('slider',{name:'磨砂强度',exact:true}).isDisabled());await reduced.send('Emulation.setEmulatedMedia',{features:[]});
 await page.emulateMedia({forcedColors:'active'});assert.equal(await page.locator('.theme-background').evaluate(el=>getComputedStyle(el).display),'none');await page.emulateMedia({forcedColors:'none'});
 // Storage failures must report the problem while allowing an immediate in-memory theme change.
 const failure=await context.newPage();await failure.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError')};window.__RESTORE_STORAGE__=()=>Storage.prototype.setItem=set});await failure.goto(base,{waitUntil:'networkidle'});await failure.getByRole('button',{name:'设置',exact:true}).click();await failure.getByRole('alert').filter({hasText:'无法保存外观设置'}).waitFor();await failure.getByRole('button',{name:'Dark 主题',exact:true}).click();await failure.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await failure.evaluate(()=>window.__RESTORE_STORAGE__());await failure.getByRole('button',{name:'Alpine 主题',exact:true}).click();await failure.waitForFunction(()=>!document.querySelector('.appearance-settings [role=alert]'));await failure.close();
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors,passed:['config validation/migration','contrast worst-case bright/dark wallpaper ≥4.5:1','three themes × five scales × three window sizes','Flat/3D','all five sliders rendered','wallpaper import/rejection/removal/reset','low performance','reload restore','cross-window storage sync','scaled desktop dragging','live terminal no restart','Monaco theme','reduced transparency preference','forced colors','storage failure/recovery'],fixtureData:true},null,2));
 console.log(`PASS ${checks.length} layout combinations, preferences, wallpaper, effects, widgets and sessions`);
}finally{await browser.close()}
