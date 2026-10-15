import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { agentFixture } from './helpers/agent.js';

test('secret input preserves UTF-8 file bytes and refuses ambiguous, oversized and invalid input', async () => {
  const { readSecretInput } = await import('../src/cli/input.js');
  const dir = await fs.mkdtemp(join(tmpdir(), 'psm-input-'));
  try {
    const file = join(dir, 'key'); await fs.writeFile(file, '\ufeffkey\r\n한글\n');
    assert.equal(await readSecretInput({ file }), '\ufeffkey\r\n한글\n');
    assert.equal(await readSecretInput({ stdin: true }, 65536, Readable.from(['literal ${HOME}'])), 'literal ${HOME}');
    await assert.rejects(readSecretInput({ file, stdin: true }), /invalid_usage/);
    await assert.rejects(readSecretInput({ fromEnv: 'PSM_SYNTHETIC_ABSENT_INPUT' }), /missing_input/);
    await assert.rejects(readSecretInput({ file }, 3), /input_too_large/);
    await fs.writeFile(file, Buffer.from([0xff])); await assert.rejects(readSecretInput({ file }), /invalid_input/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('management client uses owner authentication and versioned writes without exposing values', async () => {
  const { AdminClient } = await import('../src/cli/admin.js');
  const f = await agentFixture(); const original = process.env.PATH; process.env.PATH = f.env.PATH;
  try {
    const admin = new AdminClient(f.url);
    const project = await admin.createProject({ name: 'Agent', slug: 'agent' });
    const environment = await admin.createEnvironment({ projectId: project.id, name: 'dev' });
    const secret = await admin.createSecret({ environmentId: environment.id, name: 'TOKEN', kind: 'env', value: 'synthetic-do-not-print' });
    assert.doesNotMatch(JSON.stringify(secret), /synthetic-do-not-print|ciphertext|nonce/);
    await assert.rejects(admin.updateSecret(secret.id, { expectedVersionId: secret.currentVersionId, value: 'replacement' }, false), /confirmation_required/);
    const updated = await admin.updateSecret(secret.id, { expectedVersionId: secret.currentVersionId, value: 'replacement' }, true);
    await assert.rejects(admin.updateSecret(secret.id, { expectedVersionId: secret.currentVersionId, value: 'stale' }, true), /conflict/);
    assert.equal((await f.store.reveal(secret.id)).value, 'replacement');
    assert.notEqual(updated.currentVersionId, secret.currentVersionId);
    await assert.rejects(admin.deleteSecret(secret.id, updated.currentVersionId, false), /confirmation_required/);
    await admin.deleteSecret(secret.id, updated.currentVersionId, true);
    assert.deepEqual(await admin.secrets(environment.id), []);
    assert.deepEqual(await admin.projects(), [project]);
  } finally { process.env.PATH = original; await f.close(); }
});

test('new app bootstraps without mappings, binds exact env/file values and runs from its saved connection', async () => {
  const f = await agentFixture();
  try {
    assert.equal((await f.cli(['configure', '--admin-url', f.url])).code, 0);
    assert.equal((await f.cli(['login'])).code, 0);
    let out = await f.cli(['init']); assert.equal(out.code, 0, out.stderr);
    const initialized = JSON.parse(out.stdout); assert.equal(initialized.project.slug, 'new-app'); assert.equal(initialized.environment.name, 'dev');
    out = await f.cli(['init']); assert.equal(out.code, 0, out.stderr);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
    out = await f.cli(['secret', 'create', '--name', 'API_TOKEN', '--kind', 'env', '--from-env', 'SOURCE_TOKEN'], { extra: { SOURCE_TOKEN: 'synthetic-agent-token' } });
    assert.equal(out.code, 0, out.stderr); assert.doesNotMatch(out.stdout + out.stderr, /synthetic-agent-token/);
    const file = join(f.dir, 'input.pem'); await fs.writeFile(file, '\ufeffkey\r\n한글\n');
    assert.equal((await f.cli(['secret', 'create', '--name', 'KEY', '--kind', 'file', '--file', file])).code, 0);
    assert.equal((await f.cli(['bind', '--name', 'API_TOKEN', '--to', 'TOKEN'])).code, 0);
    assert.equal((await f.cli(['bind', '--name', 'KEY', '--to', 'PRIVATE_KEY_FILE'])).code, 0);
    const config = JSON.parse(await fs.readFile(join(f.app, 'psm.json'), 'utf8'));
    assert.equal(config.projectId, initialized.project.id); assert.equal(config.environmentId, initialized.environment.id);
    assert.doesNotMatch(JSON.stringify(config), /synthetic-agent-token|한글/);
    const observed = join(f.dir, 'observed.json');
    out = await f.cli(['run', '--', process.execPath, '-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({token:process.env.TOKEN,key:fs.readFileSync(process.env.PRIVATE_KEY_FILE,'utf8'),mode:fs.statSync(process.env.PRIVATE_KEY_FILE).mode&511}));process.exit(7)`]);
    assert.equal(out.code, 7, out.stderr); assert.equal(out.stdout, ''); assert.equal(out.stderr, '');
    assert.deepEqual(JSON.parse(await fs.readFile(observed, 'utf8')), { token: 'synthetic-agent-token', key: '\ufeffkey\r\n한글\n', mode: 384 });
  } finally { await f.close(); }
});

test('init requires confirmation to reuse a slug and fails closed when a bound remote identity changes', async () => {
  const f = await agentFixture();
  try {
    const project = await f.store.createProject({ name: 'Existing', slug: 'new-app' });
    const args = ['init', '--admin-url', f.url];
    let out = await f.cli(args); assert.equal(out.code, 1); assert.match(out.stderr, /confirmation_required/);
    await assert.rejects(fs.stat(join(f.app, 'psm.json')));
    out = await f.cli([...args, '--confirm']); assert.equal(out.code, 0, out.stderr);
    const linked = JSON.parse(await fs.readFile(join(f.app, 'psm.json'), 'utf8')); assert.equal(linked.projectId, project.id);
    await f.store.updateProject(project.id, { name: 'Renamed', slug: 'renamed' });
    out = await f.cli(['secret', 'list']); assert.equal(out.code, 1); assert.match(out.stderr, /connection_changed/);
    await f.store.createProject({ name: 'Impostor', slug: 'new-app' });
    out = await f.cli(['init']); assert.equal(out.code, 1); assert.match(out.stderr, /connection_changed/);
  } finally { await f.close(); }
});

test('explicit saved selectors remain idempotent and cannot bypass a replaced remote ID',async()=>{
  const f=await agentFixture();
  try {
    let out=await f.cli(['init','--admin-url',f.url,'--project','app','--env','dev']);assert.equal(out.code,0,out.stderr);
    out=await f.cli(['init','--project','app','--env','dev']);assert.equal(out.code,0,out.stderr);
    const saved=JSON.parse(await fs.readFile(join(f.app,'psm.json'),'utf8'));
    await f.store.deleteEnvironment(saved.environmentId);
    await f.store.createEnvironment({projectId:saved.projectId,name:'dev'});
    for(const args of [['init','--project','app','--env','dev'],['secret','list','--project','app','--env','dev']]){
      out=await f.cli(args);assert.equal(out.code,1);assert.match(out.stderr,/connection_changed/);
    }
  }finally{await f.close();}
});

test('environment-only init preserves the saved custom project and validates its identity',async()=>{
  const f=await agentFixture();
  try{
    let out=await f.cli(['init','--admin-url',f.url,'--project','custom-app','--env','local']);assert.equal(out.code,0,out.stderr);
    const first=JSON.parse(out.stdout);
    out=await f.cli(['init','--env','staging','--confirm']);assert.equal(out.code,0,out.stderr);
    let saved=JSON.parse(await fs.readFile(join(f.app,'psm.json'),'utf8'));
    assert.equal(saved.project,'custom-app');assert.equal(saved.projectId,first.project.id);assert.equal(saved.environment,'staging');
    assert.equal((await f.store.listProjects()).length,1);
    out=await f.cli(['init','--project','another-app','--confirm']);assert.equal(out.code,0,out.stderr);
    saved=JSON.parse(await fs.readFile(join(f.app,'psm.json'),'utf8'));assert.equal(saved.environment,'staging');
    await f.store.updateProject(saved.projectId,{name:'Renamed',slug:'renamed'});
    await f.store.createProject({name:'Impostor',slug:'another-app'});
    out=await f.cli(['init','--env','other','--confirm']);assert.equal(out.code,1);assert.match(out.stderr,/connection_changed/);
    assert.equal(JSON.parse(await fs.readFile(join(f.app,'psm.json'),'utf8')).projectId,saved.projectId);
  }finally{await f.close();}
});

test('CLI requires confirmation and an explicit observed version before changing or deleting a secret', async () => {
  const f = await agentFixture();
  try {
    assert.equal((await f.cli(['init', '--admin-url', f.url])).code, 0);
    const created = await f.cli(['secret', 'create', '--name', 'TOKEN', '--stdin'], { input: 'synthetic-initial' }); assert.equal(created.code, 0, created.stderr);
    const secret = JSON.parse(created.stdout);
    const args = ['secret', 'update', '--id', secret.id, '--stdin'];
    for (const flags of [[], ['--confirm'], ['--expected-version', secret.currentVersionId]]) {
      const out = await f.cli([...args, ...flags], { input: 'synthetic-replacement' }); assert.equal(out.code, 1); assert.equal((await f.store.reveal(secret.id)).value, 'synthetic-initial');
    }
    const changed = await f.cli([...args, '--confirm', '--expected-version', secret.currentVersionId], { input: 'synthetic-replacement' }); assert.equal(changed.code, 0, changed.stderr);
    const version = JSON.parse(changed.stdout).currentVersionId;
    let out = await f.cli([...args, '--confirm', '--expected-version', secret.currentVersionId], { input: 'synthetic-stale' }); assert.equal(out.code, 1); assert.match(out.stderr, /conflict/);
    out = await f.cli(['secret', 'delete', '--id', secret.id, '--expected-version', version]); assert.equal(out.code, 1); assert.match(out.stderr, /confirmation_required/);
    out = await f.cli(['secret', 'delete', '--id', secret.id, '--expected-version', version, '--confirm']); assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(created.stdout + changed.stdout + out.stdout, /synthetic-/);
  } finally { await f.close(); }
});

test('CLI rejects duplicate, unknown and irrelevant options before mutations and accepts metadata-only login config', async () => {
  const f = await agentFixture();
  try {
    const config = join(f.app, 'psm.json'); await fs.writeFile(config, JSON.stringify({ adminUrl: f.url }));
    assert.equal((await f.cli(['login'])).code, 0);
    for (const args of [
      ['project', 'create', '--name', 'A', '--slug', 'a', '--value', 'synthetic-leak'],
      ['init', '--project', 'one', '--project', 'two'],
      ['secret', 'list', '--stdin'],
      ['project', 'list', '--confirm'],
      ['run', '--project', 'x', '--env', 'dev', '--', process.execPath, '-e', 'process.exit(0)'],
    ]) { const out = await f.cli(args); assert.equal(out.code, 1); assert.doesNotMatch(out.stdout + out.stderr, /synthetic-leak/); }
    assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0);
  } finally { await f.close(); }
});

test('import preview hides values and pins input, kind changes and observed versions', async () => {
  const f = await agentFixture();
  try {
    const initialized = await f.cli(['init','--admin-url',f.url]); assert.equal(initialized.code,0,initialized.stderr);
    const environmentId = JSON.parse(initialized.stdout).environment.id;
    const old = await f.store.createSecret({environmentId,name:'PRIVATE_KEY',kind:'file',value:'synthetic-old-file'});
    const file=join(f.dir,'input.env'), plan=join(f.dir,'plan.json');
    await fs.writeFile(file,'PRIVATE_KEY=synthetic-new-value\nNEW_TOKEN="${HOME}"\n');
    let out=await f.cli(['import','preview','--file',file]); assert.equal(out.code,0,out.stderr);
    assert.doesNotMatch(out.stdout,/synthetic-new-value|\$\{HOME\}|value"|ciphertext/);
    const preview=JSON.parse(out.stdout); assert.equal(preview.environmentId,environmentId);
    assert.deepEqual(preview.entries.map((e:any)=>[e.name,e.exists,e.kindBefore,e.kindAfter]),[['PRIVATE_KEY',true,'file','env'],['NEW_TOKEN',false,null,'env']]);
    await fs.writeFile(plan,out.stdout);
    out=await f.cli(['import','apply','--file',file,'--plan',plan]); assert.equal(out.code,1); assert.match(out.stderr,/confirmation_required/);
    assert.equal((await f.store.reveal(old.id)).value,'synthetic-old-file');
    await fs.appendFile(file,'EXTRA=changed\n');
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--confirm']); assert.equal(out.code,1); assert.match(out.stderr,/plan_mismatch/);
    await fs.writeFile(file,'PRIVATE_KEY=synthetic-new-value\nNEW_TOKEN="${HOME}"\n');
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--confirm']); assert.equal(out.code,0,out.stderr);
    assert.doesNotMatch(out.stdout,/synthetic-new-value|\$\{HOME\}/);
    assert.equal((await f.store.reveal(old.id)).value,'synthetic-new-value'); assert.equal((await f.store.reveal(old.id)).kind,'env');
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--confirm']); assert.equal(out.code,1); assert.match(out.stderr,/conflict/);
  } finally { await f.close(); }
});

test('import plans use a private local key so preview output cannot verify secret guesses', async () => {
  const f = await agentFixture();
  try {
    assert.equal((await f.cli(['init','--admin-url',f.url])).code, 0);
    const file = join(f.dir,'pin.env'), plan = join(f.dir,'plan.json');
    const source = 'ADMIN_PIN=0427\n'; await fs.writeFile(file,source);
    let out = await f.cli(['import','preview','--file',file]); assert.equal(out.code,0,out.stderr);
    const preview = JSON.parse(out.stdout);
    assert.equal(preview.version,2);
    assert.equal(preview.entries[0].value,undefined);
    assert(!out.stdout.includes(createHash('sha256').update(source).digest('hex')));
    const keyPath = join(f.env.XDG_CONFIG_HOME,'psm','import.key');
    const key = await fs.readFile(keyPath);
    assert.equal(key.length,32); assert.equal((await fs.stat(keyPath)).mode & 0o777,0o600);
    assert.equal((await fs.stat(join(f.env.XDG_CONFIG_HOME,'psm'))).mode & 0o777,0o700);
    assert.equal(preview.sourceTag,createHmac('sha256',key).update(source).digest('hex'));
    assert(!out.stdout.includes(key.toString('hex'))); assert(!out.stdout.includes(key.toString('base64')));
    await fs.writeFile(plan,out.stdout);
    out = await f.cli(['import','preview','--file',file],{extra:{XDG_CONFIG_HOME:join(f.dir,'other-settings')}});
    assert.equal(out.code,0,out.stderr); assert.notEqual(JSON.parse(out.stdout).sourceTag,preview.sourceTag);
    out = await f.cli(['import','apply','--file',file,'--plan',plan]); assert.equal(out.code,0,out.stderr);
    assert.equal((await f.store.resolve('new-app','dev',['ADMIN_PIN'])).secrets[0]!.value,'0427');
  } finally { await f.close(); }
});

test('import refuses exposed or linked local keys and legacy unkeyed plans', async () => {
  const f = await agentFixture();
  try {
    assert.equal((await f.cli(['init','--admin-url',f.url])).code,0);
    const file=join(f.dir,'input.env'),plan=join(f.dir,'plan.json'),keyPath=join(f.env.XDG_CONFIG_HOME,'psm','import.key');
    await fs.writeFile(file,'TOKEN=synthetic-input\n');
    await fs.mkdir(join(f.env.XDG_CONFIG_HOME,'psm'),{recursive:true,mode:0o700});
    await fs.writeFile(keyPath,Buffer.alloc(32,7),{mode:0o600});
    let out=await f.cli(['import','preview','--file',file]); assert.equal(out.code,0,out.stderr);
    const preview=JSON.parse(out.stdout); await fs.writeFile(plan,out.stdout);
    await fs.chmod(keyPath,0o644);
    out=await f.cli(['import','apply','--file',file,'--plan',plan]); assert.equal(out.code,1); assert.match(out.stderr,/invalid_import_key/);
    await fs.chmod(keyPath,0o600);
    await fs.rename(keyPath,`${keyPath}.original`); await fs.symlink(`${keyPath}.original`,keyPath);
    out=await f.cli(['import','preview','--file',file]); assert.equal(out.code,1); assert.match(out.stderr,/invalid_import_key/);
    await fs.unlink(keyPath); await fs.rename(`${keyPath}.original`,keyPath);
    delete preview.sourceTag; Object.assign(preview,{version:1,sourceHash:createHash('sha256').update('TOKEN=synthetic-input\n').digest('hex')});
    await fs.writeFile(plan,JSON.stringify(preview));
    out=await f.cli(['import','apply','--file',file,'--plan',plan]); assert.equal(out.code,1); assert.match(out.stderr,/invalid_plan/);
    assert.deepEqual(await f.store.listSecrets(preview.environmentId),[]);
  } finally { await f.close(); }
});

test('import selects only approved entries and refuses a stale overwrite without updating the plan version', async () => {
  const f=await agentFixture();
  try {
    const initialized=await f.cli(['init','--admin-url',f.url]); const environmentId=JSON.parse(initialized.stdout).environment.id;
    const existing=await f.store.createSecret({environmentId,name:'EXISTING',kind:'env',value:'original'});
    const file=join(f.dir,'source.env'),plan=join(f.dir,'plan.json'); await fs.writeFile(file,'EXISTING=replacement\nNEW=fresh\n');
    let out=await f.cli(['import','preview','--file',file]); assert.equal(out.code,0,out.stderr); await fs.writeFile(plan,out.stdout);
    await f.store.updateSecret(existing.id,{expectedVersionId:existing.currentVersionId,value:'concurrent'});
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--names','EXISTING','--confirm']); assert.equal(out.code,1); assert.match(out.stderr,/conflict/);
    assert.equal((await f.store.reveal(existing.id)).value,'concurrent');
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--names','NEW']); assert.equal(out.code,0,out.stderr);
    assert.deepEqual((await f.store.listSecrets(environmentId)).map(item=>item.name),['EXISTING','NEW']);
    assert.equal((await f.store.reveal(existing.id)).value,'concurrent');
  } finally { await f.close(); }
});

test('large imports use bounded staged chunks and an intervening conflict commits none of the new keys', async () => {
  const f=await agentFixture();
  try {
    const initialized=await f.cli(['init','--admin-url',f.url]); const environmentId=JSON.parse(initialized.stdout).environment.id;
    const existing=await f.store.createSecret({environmentId,name:'EXISTING',kind:'env',value:'original'});
    const file=join(f.dir,'large.env'),plan=join(f.dir,'plan.json'); await fs.writeFile(file,'EXISTING=replacement\n'+Array.from({length:21},(_,i)=>`TOKEN_${i}=synthetic-${i}\n`).join(''));
    let out=await f.cli(['import','preview','--file',file]); assert.equal(out.code,0,out.stderr); await fs.writeFile(plan,out.stdout);
    let changed=false;
    f.onRequest(async path=>{if(path.endsWith('/commit')&&!changed){changed=true;await f.store.updateSecret(existing.id,{expectedVersionId:existing.currentVersionId,value:'concurrent'});}});
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--confirm']); assert.equal(out.code,1); assert.match(out.stderr,/conflict/);
    assert.deepEqual((await f.store.listSecrets(environmentId)).map(item=>item.name),['EXISTING']);
    out=await f.cli(['import','preview','--file',file]); assert.equal(out.code,0,out.stderr); await fs.writeFile(plan,out.stdout);
    out=await f.cli(['import','apply','--file',file,'--plan',plan,'--confirm']); assert.equal(out.code,0,out.stderr);
    assert.equal((await f.store.listSecrets(environmentId)).length,22); assert.doesNotMatch(out.stdout,/synthetic-/);
    const chunks=f.requests.filter(req=>req.path.endsWith('/chunks'));
    assert(chunks.length>=6); assert(chunks.every(req=>req.body.rows.length<=10));
    assert(chunks.every(req=>req.body.rows.reduce((n:number,row:{value:string})=>n+Buffer.byteLength(row.value),0)<=65536));
  } finally { await f.close(); }
});

test('management output whitelists metadata and sanitizes backend errors and expired authentication',async()=>{
  const f=await agentFixture();const project=await f.store.createProject({name:'Safe',slug:'safe'});
  let status=200,body:unknown={projects:[{...project,value:'synthetic-leak',ciphertext:'synthetic-ciphertext'}]};
  const server=createServer((_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    let out=await f.cli(['project','list','--admin-url',url]);assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{projects:[project]});
    status=500;body={error:{code:'synthetic-leak',body:'synthetic-leak'}};
    out=await f.cli(['project','list','--admin-url',url]);assert.equal(out.code,1);assert.match(out.stderr,/request_failed/);assert.doesNotMatch(out.stdout+out.stderr,/synthetic/);
    status=401;out=await f.cli(['project','list','--admin-url',url]);assert.equal(out.code,1);assert.match(out.stderr,/login_required/);assert.doesNotMatch(out.stdout+out.stderr,/synthetic/);
    out=await f.cli(['project','list','--admin-url',url],{extra:{CF_FAIL:'1'}});assert.equal(out.code,1);assert.match(out.stderr,/login_required/);
  }finally{await new Promise<void>(done=>server.close(()=>done()));await f.close();}
});

test('project and environment CLI updates use exact IDs and deletion never cascades',async()=>{
  const f=await agentFixture();
  try{
    const call=(args:string[])=>f.cli([...args,'--admin-url',f.url]);
    let out=await call(['project','create','--name','Project','--slug','project']);assert.equal(out.code,0,out.stderr);const project=JSON.parse(out.stdout);
    out=await call(['environment','create','--project','project','--name','dev']);assert.equal(out.code,0,out.stderr);const environment=JSON.parse(out.stdout);
    out=await call(['project','delete','--id',project.id,'--confirm']);assert.equal(out.code,1);assert.match(out.stderr,/conflict/);
    assert.equal((await f.store.listEnvironments(project.id)).length,1);
    out=await call(['environment','update','--id',environment.id,'--name','local','--confirm']);assert.equal(out.code,0,out.stderr);assert.equal(JSON.parse(out.stdout).name,'local');
    out=await call(['project','update','--id',project.id,'--name','Renamed','--slug','renamed','--confirm']);assert.equal(out.code,0,out.stderr);assert.equal(JSON.parse(out.stdout).id,project.id);
    out=await call(['environment','delete','--id',environment.id,'--confirm']);assert.equal(out.code,0,out.stderr);
    out=await call(['project','delete','--id',project.id,'--confirm']);assert.equal(out.code,0,out.stderr);assert.deepEqual(await f.store.listProjects(),[]);
  }finally{await f.close();}
});

test('confirmed binding repairs all existing mappings after the remote secret kind changes',async()=>{
  const f=await agentFixture();
  try{
    await f.cli(['init','--admin-url',f.url]);
    let out=await f.cli(['secret','create','--name','KEY','--stdin'],{input:'synthetic-key'});const key=JSON.parse(out.stdout);
    for(const to of ['FIRST','SECOND']){out=await f.cli(['bind','--name','KEY','--to',to]);assert.equal(out.code,0,out.stderr);}
    out=await f.cli(['secret','update','--id',key.id,'--kind','file','--expected-version',key.currentVersionId,'--confirm']);assert.equal(out.code,0,out.stderr);
    out=await f.cli(['bind','--name','KEY','--to','FIRST']);assert.equal(out.code,1);assert.match(out.stderr,/confirmation_required/);
    out=await f.cli(['bind','--name','KEY','--to','FIRST','--confirm']);assert.equal(out.code,0,out.stderr);
    const config=JSON.parse(await fs.readFile(join(f.app,'psm.json'),'utf8'));assert.equal(config.secrets.FIRST.kind,'file');assert.equal(config.secrets.SECOND.kind,'file');
    out=await f.cli(['run','--',process.execPath,'-e',"const fs=require('fs');if(fs.readFileSync(process.env.FIRST,'utf8')!=='synthetic-key'||fs.readFileSync(process.env.SECOND,'utf8')!=='synthetic-key')process.exit(1)"]);assert.equal(out.code,0,out.stderr);assert.equal(out.stdout,'');
  }finally{await f.close();}
});
