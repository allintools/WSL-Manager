import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.WSL_PREVIEW_DEPS?path.join(process.env.WSL_PREVIEW_DEPS,'playwright'):'playwright');
const output=path.resolve('outputs/theme-stage1');
const base=process.env.WSL_PREVIEW_URL||'http://127.0.0.1:1421';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
try {
  for(const [label,width,height] of [['reference',1912,956],['desktop',1320,880],['minimum',920,650]]) {
    for(const route of ['workspace','appearance']) {
      const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
      const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
      await page.goto(`${base}/?theme-preview=${route}`,{waitUntil:'networkidle'});
      await page.locator('.preview-wallpaper').waitFor();
      await page.evaluate(()=>document.fonts.ready);
      const checks=await page.evaluate(async()=>{
        const main=document.querySelector('.preview-main');
        const wallpaper=new Image();wallpaper.src='/wallpapers/alpine.webp';await wallpaper.decode();
        const text=document.querySelector('h1');
        const filters=[];for(let el=text;el;el=el.parentElement){if(getComputedStyle(el).filter!=='none')filters.push(el.className)}
        return {
          wallpaperLoaded:wallpaper.naturalWidth>0,
          horizontalOverflow:main.scrollWidth>main.clientWidth+1,
          textAncestorFilters:filters,
          sidebarOverflow:document.querySelector('.preview-sidebar').scrollHeight>document.querySelector('.preview-sidebar').clientHeight+1,
          tailwindDisplay:getComputedStyle(document.querySelector('.tw\\:flex')).display,
          backgroundLayer:getComputedStyle(document.querySelector('.theme-preview-background')).zIndex,
        };
      });
      await page.screenshot({path:path.join(output,`${route}-${label}.png`)});
      if(route==='appearance'&&label==='reference') {
        await page.locator('.preview-main').evaluate(el=>el.scrollTop=el.scrollHeight);
        await page.screenshot({path:path.join(output,'appearance-effects.png')});
      }
      await page.getByRole('link',{name:route==='workspace'?'外观设置预览':'工作台预览',exact:true}).click();
      await page.waitForURL(`**theme-preview=${route==='workspace'?'appearance':'workspace'}`);
      results.push({route,label,width,height,errors,...checks,navigationWorks:true});
      await page.close();
    }
  }
} finally {await browser.close()}
await writeFile(path.join(output,'checks.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.errors.length||!r.wallpaperLoaded||r.horizontalOverflow||r.sidebarOverflow||r.textAncestorFilters.length||r.tailwindDisplay!=='flex'))process.exitCode=1;
