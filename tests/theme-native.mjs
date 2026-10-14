import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.WSL_PREVIEW_DEPS?path.join(process.env.WSL_PREVIEW_DEPS,'playwright'):'playwright');
const browser=await chromium.connectOverCDP(process.env.WSL_NATIVE_CDP||'http://127.0.0.1:9335');
const context=browser.contexts()[0];let page;
for(let i=0;i<40;i++){page=context.pages().find(p=>p.url().includes('tauri.localhost')&&!p.url().includes('browser=1'));if(page)break;await new Promise(r=>setTimeout(r,250))}assert(page,'Native app page missing');
await page.locator('button[title="设置"]').waitFor();
const key='wsl-manager.appearance.v1',backup=await page.evaluate(k=>localStorage.getItem(k),key),output=path.resolve('outputs/theme-native');await mkdir(output,{recursive:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=[];
if(process.env.WSL_NATIVE_PHASE==='restart'){
 assert.equal(backup,await readFile(path.join(output,'restart-preferences.json'),'utf8'));
 check.push('actual process restart preserves preferences');
}
async function settings(){await page.locator('button[title="设置"]').click();await page.locator('.appearance-settings').waitFor()}
async function choose(preset){await page.getByRole('button',{name:`${preset} 主题`,exact:true}).click();await page.waitForFunction(name=>document.documentElement.dataset.theme===name,preset.toLowerCase())}
async function scale(value){await page.getByRole('button',{name:`${value}%`,exact:true}).click();await page.waitForFunction(v=>getComputedStyle(document.getElementById('root')).zoom===String(v/100),value)}
async function rpc(command,args){return page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args})}
try {
 await page.reload();await settings();await page.getByRole('button',{name:'恢复默认',exact:true}).click();
 for(const preset of ['Alpine','Dark','Light']){await choose(preset);await scale(100);assert.equal(await rpc('plugin:window|theme',{label:'main'}),preset==='Light'?'light':'dark');await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,`appearance-${preset.toLowerCase()}.png`)});check.push(`native ${preset}`)}
 await choose('Alpine');await scale(125);await page.getByRole('button',{name:'3D',exact:true}).click();
 await page.getByLabel('选择壁纸文件').setInputFiles('public/wallpapers/alpine.webp');await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)).wallpaper==='custom',key);
 const saved=await page.evaluate(k=>localStorage.getItem(k),key);await writeFile(path.join(output,'restart-preferences.json'),saved);
 await page.reload();await settings();assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),saved);assert.equal(await page.evaluate(()=>document.documentElement.dataset.style),'3d');check.push('native reload/custom wallpaper/scale/style persistence');
 await page.getByRole('button',{name:'恢复默认',exact:true}).click();
 const distros=await rpc('rpc',{method:'distro.list',params:{}});const distro=distros.find(d=>d.name==='Ubuntu-24.04')||distros[0];assert(distro,'No WSL distributions');
 if(!distro.running)await rpc('rpc',{method:'distro.start',distro:distro.name,params:{confirmed:true}});
 await page.locator('button[title="刷新发行版"]').click();await page.locator(`button.distro-nav[title="${distro.name}"]`).click();
 const stage=page.locator('.desktop-stage');await stage.waitFor({timeout:45000});
 await page.locator('.desktop-launchers button[title="打开文件"]').click();await page.locator('.file-table').waitFor();check.push('real WSL file list');
 await page.locator('.desktop-window-controls button[title="最小化"]').first().click();await page.locator('.desktop-launchers button[title="打开终端"]').click();await page.locator('.xterm').waitFor();await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.includes('@'));await page.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText("printf '__THEME_KEEP__\\n'; echo $$");await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.includes('__THEME_KEEP__'));check.push('real native terminal');
 await page.locator('.desktop-taskbar').getByRole('button',{name:'浏览器',exact:false}).click();
 let chrome;for(let i=0;i<40;i++){chrome=context.pages().find(p=>p.url().includes('browser=1'));if(chrome)break;await new Promise(r=>setTimeout(r,250))}assert(chrome,'Browser toolbar missing');await chrome.locator('.browser-toolbar').waitFor();
 await settings();await choose('Light');await scale(150);await chrome.waitForFunction(()=>document.documentElement.dataset.theme==='light'&&getComputedStyle(document.getElementById('root')).zoom==='1.5');
 const bar=await chrome.locator('.browser-chrome').boundingBox();assert(Math.abs(bar.height-124.5)<2);await chrome.waitForFunction(()=>innerHeight>=124);assert(await chrome.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));check.push('native browser live theme/150% toolbar layout');
 await chrome.screenshot({path:path.join(output,'browser-toolbar-light150.png')});
 await page.locator(`button.distro-nav[title="${distro.name}"]`).click();assert(await page.locator('.xterm-rows').textContent().then(text=>text.includes('__THEME_KEEP__')));check.push('terminal output survives native theme/scale changes');await page.screenshot({path:path.join(output,'desktop-real-light150.png')});
 await settings();await scale(100);await choose('Alpine');await page.getByRole('switch',{name:'低性能模式'}).check();assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).backdropFilter),'none');check.push('native low GPU mode');
 assert.deepEqual(errors,[]);await writeFile(path.join(output,`checks-${process.env.WSL_NATIVE_PHASE||'first'}.json`),JSON.stringify({check,errors,realWSL:true},null,2));console.log(JSON.stringify({check,errors}));
 if(process.env.WSL_NATIVE_PHASE!=='restart'){
   // Leave only the generated test preference for one real process restart.
   await page.evaluate(({key,saved})=>{localStorage.setItem(key,saved);dispatchEvent(new StorageEvent('storage',{key,newValue:saved}))},{key,saved});
   await writeFile(path.join(output,'original-preferences.json'),JSON.stringify({value:backup}));
 }else{
   const original=JSON.parse(await readFile(path.join(output,'original-preferences.json'),'utf8')).value;
   await page.evaluate(({key,value})=>{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);dispatchEvent(new StorageEvent('storage',{key,newValue:value}))},{key,value:original});
 }
} catch(error){
 await page.evaluate(({key,value})=>{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);dispatchEvent(new StorageEvent('storage',{key,newValue:value}))},{key,value:backup});
 throw error;
}finally{await browser.close()}
