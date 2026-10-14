import { build } from 'esbuild';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('./.frontend-check.cjs', import.meta.url));
const result = await build({stdin:{contents:`
import {readIni,updateIni} from './src/Settings';
import assert from 'node:assert/strict';
const original='; retain comment\\n[wsl2]\\nmemory=4GB\\ncustom=value\\n[experimental]\\nautoMemoryReclaim=gradual\\n';
const updated=updateIni(original,{'wsl2.memory':'8GB','wsl2.processors':'4','experimental.automemoryreclaim':'dropCache','wsl2.networkingmode':'NAT'});
assert.equal(readIni(updated)['wsl2.memory'],'8GB');
assert.equal(readIni(updated)['wsl2.processors'],'4');
assert.equal(readIni(updated)['wsl2.custom'],'value');
assert(updated.includes('; retain comment'));
assert(updated.includes('networkingMode=NAT'));
assert(updated.includes('autoMemoryReclaim=dropCache'));
assert(!updateIni(updated,{'wsl2.memory':''}).includes('memory='));
assert.equal((updateIni('[wsl2]\\nmemory=1GB\\nmemory=2GB',{'wsl2.memory':'3GB'}).match(/memory=/g)||[]).length,1);
console.log('PASS settings round-trip, unknown keys, canonical casing, delete and duplicate handling');
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,loader:{'.css':'empty'},platform:'node',format:'cjs',write:false});
try {writeFileSync(output,result.outputFiles[0].text);console.log(execFileSync(process.execPath,[output],{encoding:'utf8'}));} finally {unlinkSync(output);}
