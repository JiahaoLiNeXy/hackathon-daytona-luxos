import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const baseline=JSON.parse(await readFile(new URL('docs/PRESERVED-ASSETS.json',root),'utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const [path,expected] of Object.entries(baseline.files)){
  assert.equal(hash(await readFile(new URL(path,root))),expected,`${path} changed from the approved visual/model baseline`);
}
console.log(`Preserved: ${Object.keys(baseline.files).length} original model, photo and controller files.`);
