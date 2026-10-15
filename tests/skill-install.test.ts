import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script=resolve('scripts/install-skill.mjs');
function install(target:string) {
  const child=spawn(process.execPath,[script,'--target',target],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
  return new Promise<{code:number|null;stdout:string;stderr:string}>(done=>child.on('close',code=>done({code,stdout,stderr})));
}
test('skill installer copies a usable skill and an identical reinstall preserves it',async()=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'psm-skill-'));
  try {
    const out=await install(join(dir,'skills'));assert.equal(out.code,0,out.stderr);
    const destination=join(dir,'skills','personal-secret-manager','SKILL.md');
    assert.equal(await fs.readFile(destination,'utf8'),await fs.readFile('skills/personal-secret-manager/SKILL.md','utf8'));
    const modified=(await fs.stat(destination)).mtimeMs;
    const again=await install(join(dir,'skills'));assert.equal(again.code,0,again.stderr);assert.equal((await fs.stat(destination)).mtimeMs,modified);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('skill installer refuses a changed installed skill and never follows a destination symlink',async()=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'psm-skill-'));
  try {
    const root=join(dir,'skills'),destination=join(root,'personal-secret-manager');
    await fs.mkdir(destination,{recursive:true});await fs.writeFile(join(destination,'SKILL.md'),'owner content');
    let out=await install(root);assert.equal(out.code,1);assert.equal(await fs.readFile(join(destination,'SKILL.md'),'utf8'),'owner content');
    await fs.rm(destination,{recursive:true});const outside=join(dir,'outside');await fs.mkdir(outside);await fs.writeFile(join(outside,'keep'),'preserve');await fs.symlink(outside,destination);
    out=await install(root);assert.equal(out.code,1);assert.deepEqual(await fs.readdir(outside),['keep']);
    await fs.unlink(destination);await fs.rmdir(root);await fs.symlink(outside,root);
    out=await install(root);assert.equal(out.code,1);assert.deepEqual(await fs.readdir(outside),['keep']);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
