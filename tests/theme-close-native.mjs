import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(path.join(process.env.WSL_PREVIEW_DEPS,'playwright'));
const browser=await chromium.connectOverCDP(process.env.WSL_NATIVE_CDP||'http://127.0.0.1:9335');
const page=browser.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost')&&!p.url().includes('browser=1'));
if(!page||await page.title()!=='WSL Manager')throw Error('Expected WSL Manager test process');
await Promise.race([page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|destroy',{label:'main'})).catch(()=>{}),new Promise(r=>setTimeout(r,1000))]);
await browser.close().catch(()=>{});
