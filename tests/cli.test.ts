import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve('src/cli/index.ts');
const secret = 'synthetic-secret-never-print';
const fileValue = '\ufeffkey\r\n한글\n';
interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'psm-cli-test-'));
  const bin = join(dir, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'cloudflared'), `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(process.env.CF_LOG,JSON.stringify(process.argv.slice(2))+'\\n');console.log('${secret}');if(process.env.CF_FAIL) {console.error('${secret}');process.exit(1)}\n`, { mode: 0o700 });
  let response: unknown = { secrets: [{ name: 'TOKEN', kind: 'env', value: secret }, { name: 'KEY', kind: 'file', value: fileValue }] };
  let status = 200; const requests: { url: string; body: unknown; token?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ url: req.url!, body: body ? JSON.parse(body) : null, token: req.headers['cf-access-token'] as string });
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(typeof response === 'function' ? response(req) : response));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = join(dir, 'psm.json');
  await fs.writeFile(config, JSON.stringify({ adminUrl: url, secrets: { API_TOKEN: { name: 'TOKEN', kind: 'env' }, SIGNING_KEY_FILE: { name: 'KEY', kind: 'file' } } }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, CF_LOG: join(dir, 'cf.log'), INHERITED: 'preserved' };
  function launch(args: string[], extra: NodeJS.ProcessEnv = {}, imports: string[] = []) {
    const child = spawn(process.execPath, [...imports, '--import', 'tsx', entry, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const result = new Promise<Result>((done) => child.on('close', (code, signal) => done({ code, signal, stdout, stderr })));
    return { child, result };
  }
  function run(code: string, extra: NodeJS.ProcessEnv = {}, imports: string[] = []) { return launch(['run', '--project', 'app', '--env', 'dev', '--config', config, '--', process.execPath, '-e', code], extra, imports); }
  const root = join(dir, `psm-${process.getuid!()}`);
  return { dir, root, config, env, run, launch, requests, setResponse(value: unknown, code = 200) { response = value; status = code; }, async close() { await new Promise<void>(done => server.close(() => done())); await fs.rm(dir, { recursive: true, force: true }); } };
}
async function waitFile(path: string) {
  for (let i = 0; i < 300; i++) { try { return await fs.readFile(path, 'utf8'); } catch { await new Promise(r => setTimeout(r, 10)); } }
  throw new Error('fixture file timeout');
}

test('CLI passes exact bytes, inherited env and arguments, restricts modes and cleans nonzero child exit', async () => {
  const f = await fixture(); try {
    const observed = join(f.dir, 'observed.json');
    const { result } = f.run(`const fs=require('fs'),p=require('path');const file=process.env.SIGNING_KEY_FILE;fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({token:process.env.API_TOKEN,inherited:process.env.INHERITED,bytes:fs.readFileSync(file).toString('hex'),fileMode:fs.statSync(file).mode&511,dirMode:fs.statSync(p.dirname(file)).mode&511,rootMode:fs.statSync(p.dirname(p.dirname(file))).mode&511}));process.exit(7)`);
    const out = await result; assert.equal(out.code, 7); assert.equal(out.stdout, ''); assert.equal(out.stderr, '');
    assert.deepEqual(JSON.parse(await fs.readFile(observed, 'utf8')), { token: secret, inherited: 'preserved', bytes: 'efbbbf6b65790d0aed959ceab8800a', fileMode: 384, dirMode: 448, rootMode: 448 });
    assert.deepEqual(f.requests, [{ url: '/api/resolve', body: { project: 'app', environment: 'dev', names: ['TOKEN', 'KEY'] }, token: secret }]);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.close(); }
});

test('CLI fails closed on missing, extra, duplicate, wrong kind, NUL or malformed Unicode values', async () => {
  const f = await fixture(); try {
    const good = [{ name: 'TOKEN', kind: 'env', value: secret }, { name: 'KEY', kind: 'file', value: fileValue }];
    for (const values of [good.slice(1), [...good, {name:'OTHER',kind:'env',value:secret}], [...good,good[0]], [{...good[0],kind:'file'},good[1]], [{...good[0],value:'a\0b'},good[1]], [good[0],{...good[1],value:'\ud800'}]]) {
      f.setResponse({secrets:values}); const out = await f.run(`require('fs').writeFileSync(${JSON.stringify(join(f.dir,'spawned'))},'yes')`).result;
      assert.equal(out.code, 1); assert.equal(out.stdout, ''); assert.doesNotMatch(out.stderr, /synthetic|a.b/);
      await assert.rejects(fs.stat(join(f.dir,'spawned'))); await assert.rejects(fs.stat(f.root));
    }
  } finally { await f.close(); }
});

test('CLI sanitizes backend and cloudflared failures and does not spawn', async () => {
  const f = await fixture(); try {
    f.setResponse({error:{code:secret}}, 500); let out = await f.run('process.exit(0)').result;
    assert.equal(out.code,1); assert.doesNotMatch(out.stderr,/synthetic/);
    out = await f.run('process.exit(0)', {CF_FAIL:'1'}).result; assert.equal(out.code,1); assert.doesNotMatch(out.stderr,/synthetic/); assert.equal(out.stdout,'');
  } finally { await f.close(); }
});

test('login captures credential output, help works and invalid usage fails', async () => {
  const f = await fixture(); try {
    const out = await f.launch(['login','--config',f.config]).result; assert.equal(out.code,0); assert.doesNotMatch(out.stdout+out.stderr,/synthetic/);
    const log = (await fs.readFile(f.env.CF_LOG, 'utf8')).trim().split('\n').map(s=>JSON.parse(s)); assert.deepEqual(log[0].slice(0,2),['access','login']);
    assert.equal((await f.launch(['--help']).result).code,0); assert.equal((await f.launch(['run','--project','app']).result).code,1);
  } finally { await f.close(); }
});

test('CLI rejects duplicate/prototype/unsafe mappings and non-origin insecure URLs before authentication', async () => {
  const f = await fixture(); try {
    for (const source of [
      '{"adminUrl":"https://example.com","secrets":{"TOKEN":{"name":"KEY","kind":"env"},"TOKEN":{"name":"KEY","kind":"env"}}}',
      '{"adminUrl":"https://example.com","secrets":{"__proto__":{"name":"KEY","kind":"env"}}}',
      '{"adminUrl":"https://example.com","secrets":{"A-B":{"name":"KEY","kind":"env"}}}',
      '{"adminUrl":"http://example.com","secrets":{}}',
      '{"adminUrl":"https://example.com/path","secrets":{}}',
      '{"adminUrl":"https://user@example.com","secrets":{}}',
      '{"adminUrl":"https://example.com","secrets":{"TOKEN":{"name":"KEY","kind":"env","value":"synthetic"}}}'
    ]) {
      await fs.writeFile(f.config,source); const out = await f.run('process.exit(0)').result; assert.equal(out.code,1); assert.equal(f.requests.length,0); await assert.rejects(fs.stat(f.env.CF_LOG));
    }
  } finally { await f.close(); }
});

test('SIGTERM forwards to live child and keeps its file until child exits', async () => {
  const f = await fixture(); try {
    const ready=join(f.dir,'ready'), seen=join(f.dir,'seen');
    const run=f.run(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},process.env.SIGNING_KEY_FILE);process.on('SIGTERM',()=>{setTimeout(()=>{fs.writeFileSync(${JSON.stringify(seen)},fs.readFileSync(process.env.SIGNING_KEY_FILE));process.exit(0)},150)});setInterval(()=>{},100)`);
    const path=await waitFile(ready); run.child.kill('SIGTERM'); await new Promise(r=>setTimeout(r,60)); assert.equal(await fs.readFile(path,'utf8'),fileValue);
    const out=await run.result; assert.equal(out.signal,'SIGTERM'); assert.equal(await fs.readFile(seen,'utf8'),fileValue); assert.deepEqual(await fs.readdir(f.root),[]);
  } finally { await f.close(); }
});

test('child signal propagates and stale cleanup keeps live, symlink and unrelated entries', async () => {
  const f=await fixture(); try {
    await fs.mkdir(f.root,{mode:0o700}); const stale=join(f.root,'run-2147483647-aaaaaaaaaaaaaaaa'),live=join(f.root,`run-${process.pid}-bbbbbbbbbbbbbbbb`),other=join(f.root,'unrelated'),link=join(f.root,'run-2147483646-cccccccccccccccc');
    for(const path of [stale,live,other]) {await fs.mkdir(path,{mode:0o700});await fs.writeFile(join(path,'SECRET'),'synthetic',{mode:0o600});}
    await fs.writeFile(join(stale,'.preparing'),'',{mode:0o600}); await fs.symlink(other,link); const out=await f.run("process.kill(process.pid,'SIGTERM')").result; assert.equal(out.signal,'SIGTERM');
    await assert.rejects(fs.stat(stale)); assert.deepEqual((await fs.readdir(f.root)).sort(),[live.split('/').at(-1),other.split('/').at(-1),link.split('/').at(-1)].sort());
  } finally {await f.close();}
});

test('CI rejects untrusted OIDC destinations before forwarding runner credential', async () => {
  const f=await fixture(); try {
    await fs.writeFile(f.config,JSON.stringify({adminUrl:'https://admin.example.com',ciUrl:'https://ci.example.com',secrets:{API_TOKEN:{name:'TOKEN',kind:'env'}}}));
    for(const url of ['http://token.actions.githubusercontent.com','https://actions.githubusercontent.com.attacker.test','https://user@token.actions.githubusercontent.com','https://token.actions.githubusercontent.com:444','https://example.com']) {
      const out=await f.launch(['run','--ci','--project','app','--env','dev','--config',f.config,'--',process.execPath,'-e','process.exit(0)'],{ACTIONS_ID_TOKEN_REQUEST_URL:url,ACTIONS_ID_TOKEN_REQUEST_TOKEN:secret}).result;
      assert.equal(out.code,1);assert.doesNotMatch(out.stderr,/synthetic/);assert.equal(f.requests.length,0);
    }
  } finally {await f.close();}
});

test('partial preparation failure removes files and never starts a child', async () => {
  const f=await fixture(); try {
    await fs.writeFile(f.config,JSON.stringify({adminUrl:`http://127.0.0.1:${(new URL(JSON.parse(await fs.readFile(f.config,'utf8')).adminUrl)).port}`,secrets:{FIRST_FILE:{name:'KEY',kind:'file'},SECOND_FILE:{name:'KEY',kind:'file'}}}));
    f.setResponse({secrets:[{name:'KEY',kind:'file',value:fileValue}]});
    const preload=join(f.dir,'fail.cjs'); await fs.writeFile(preload,`const fs=require('fs/promises');const open=fs.open;fs.open=async function(path,...args){if(String(path).endsWith('/SECOND_FILE'))throw Object.assign(new Error('synthetic-secret-never-print'),{code:'EIO'});return open.call(this,path,...args)};`);
    const out=await f.run(`require('fs').writeFileSync(${JSON.stringify(join(f.dir,'spawned'))},'yes')`,{},['--require',preload]).result;
    assert.equal(out.code,1);assert.doesNotMatch(out.stderr,/synthetic/);await assert.rejects(fs.stat(join(f.dir,'spawned')));assert.deepEqual(await fs.readdir(f.root),[]);assert.deepEqual((f.requests[0]!.body as {names:string[]}).names,['KEY']);
  } finally {await f.close();}
});

test('interruption during preparation cleans partial files without starting child', async () => {
  const f=await fixture(); try {
    const config=JSON.parse(await fs.readFile(f.config,'utf8'));config.secrets={FIRST_FILE:{name:'KEY',kind:'file'},SECOND_FILE:{name:'KEY',kind:'file'}};await fs.writeFile(f.config,JSON.stringify(config));f.setResponse({secrets:[{name:'KEY',kind:'file',value:fileValue}]});
    const ready=join(f.dir,'preparing'),preload=join(f.dir,'interrupt.cjs');
    await fs.writeFile(preload,`const fs=require('fs/promises');const open=fs.open;fs.open=async function(path,...args){if(String(path).endsWith('/SECOND_FILE')){await fs.writeFile(${JSON.stringify(ready)},'ready');await new Promise(r=>setTimeout(r,200));}return open.call(this,path,...args)};`);
    const run=f.run(`require('fs').writeFileSync(${JSON.stringify(join(f.dir,'spawned'))},'yes')`,{},['--require',preload]);await waitFile(ready);run.child.kill('SIGTERM');const out=await run.result;
    assert.equal(out.signal,'SIGTERM');await assert.rejects(fs.stat(join(f.dir,'spawned')));assert.deepEqual(await fs.readdir(f.root),[]);
  } finally {await f.close();}
});

test('unsafe temporary root and ambiguous stale entries are never followed or deleted', async () => {
  const f=await fixture(); try {
    const outside=join(f.dir,'outside');await fs.mkdir(outside);await fs.writeFile(join(outside,'keep'),secret);await fs.symlink(outside,f.root);
    assert.equal((await f.run('process.exit(0)').result).code,1);assert.equal(await fs.readFile(join(outside,'keep'),'utf8'),secret);await fs.unlink(f.root);
    await fs.mkdir(f.root,{mode:0o700});const ambiguous=join(f.root,'run-2147483647-dddddddddddddddd');await fs.mkdir(ambiguous,{mode:0o700});await fs.symlink(join(outside,'keep'),join(ambiguous,'KEY'));
    assert.equal((await f.run('process.exit(0)').result).code,0);assert.equal(await fs.readFile(join(outside,'keep'),'utf8'),secret);assert.equal((await fs.lstat(join(ambiguous,'KEY'))).isSymbolicLink(),true);
    await fs.chmod(f.root,0o755);assert.equal((await f.run('process.exit(0)').result).code,1);
  } finally {await f.close();}
});

test('run preserves literal child arguments after --', async () => {
  const f=await fixture(); try {
    const observed=join(f.dir,'args');const out=await f.launch(['run','--project','app','--env','dev','--config',f.config,'--',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify(process.argv.slice(1)))`,'--','$(echo unsafe)','--ci','value with spaces']).result;
    assert.equal(out.code,0);assert.deepEqual(JSON.parse(await fs.readFile(observed,'utf8')),['$(echo unsafe)','--ci','value with spaces']);
  } finally {await f.close();}
});


test('stale cleanup preserves orphan live children and ambiguous unmarked directories', async () => {
  const f=await fixture();const peer=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);try {
    await fs.mkdir(f.root,{mode:0o700});const orphan=join(f.root,'run-2147483647-eeeeeeeeeeeeeeee'),ambiguous=join(f.root,'run-2147483646-ffffffffffffffff');
    await fs.mkdir(orphan,{mode:0o700});await fs.mkdir(ambiguous,{mode:0o700});await fs.writeFile(join(orphan,`.child-${peer.pid}`),'',{mode:0o600});await fs.writeFile(join(orphan,'KEY'),fileValue,{mode:0o600});await fs.writeFile(join(ambiguous,'KEY'),fileValue,{mode:0o600});
    assert.equal((await f.run('process.exit(0)').result).code,0);assert.equal(await fs.readFile(join(orphan,'KEY'),'utf8'),fileValue);assert.equal(await fs.readFile(join(ambiguous,'KEY'),'utf8'),fileValue);
  } finally {peer.kill();await new Promise(done=>peer.once('exit',done));await f.close();}
});


test('CI uses trusted runner URL, exact origin audience and bearer token without invoking cloudflared', async () => {
  const f=await fixture();try {
    const local=JSON.parse(await fs.readFile(f.config,'utf8')).adminUrl;
    await fs.writeFile(f.config,JSON.stringify({adminUrl:'https://admin.example.com',ciUrl:'https://ci.example.com',secrets:{API_TOKEN:{name:'TOKEN',kind:'env'}}}));
    f.setResponse((req: {url:string})=>req.url.startsWith('/oidc')?{value:'synthetic-oidc-jwt'}:{secrets:[{name:'TOKEN',kind:'env',value:secret}]});
    const preload=join(f.dir,'oidc.cjs'),log=join(f.dir,'fetch.log');
    await fs.writeFile(preload,`const fs=require('fs'),fetch=global.fetch;global.fetch=(url,options)=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({url:String(url),authorization:options.headers.Authorization})+'\\n');const u=new URL(url);return fetch(${JSON.stringify(local)}+(u.hostname.endsWith('.actions.githubusercontent.com')?'/oidc'+u.search:u.pathname),options)};`);
    const observed=join(f.dir,'ci-result');
    const out=await f.launch(['run','--ci','--project','app','--env','dev','--config',f.config,'--',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(observed)},process.env.API_TOKEN)`],{ACTIONS_ID_TOKEN_REQUEST_URL:'https://run.actions.githubusercontent.com/identity?existing=yes',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'runner-credential'},['--require',preload]).result;
    assert.equal(out.code,0);assert.equal(out.stdout,'');assert.equal(out.stderr,'');assert.equal(await fs.readFile(observed,'utf8'),secret);
    const calls=(await fs.readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(calls,[{url:'https://run.actions.githubusercontent.com/identity?existing=yes&audience=https%3A%2F%2Fci.example.com',authorization:'Bearer runner-credential'},{url:'https://ci.example.com/v1/resolve',authorization:'Bearer synthetic-oidc-jwt'}]);await assert.rejects(fs.stat(f.env.CF_LOG));
  }finally {await f.close();}
});

test('resolve accepts full bounded batches larger than request body limit', async()=>{
  const f=await fixture();try {
    const config=JSON.parse(await fs.readFile(f.config,'utf8'));config.secrets={};const values=[];
    for(let i=0;i<20;i++){config.secrets[`FILE_${i}`]={name:`KEY_${i}`,kind:'file'};values.push({name:`KEY_${i}`,kind:'file',value:'x'.repeat(65536)});}await fs.writeFile(f.config,JSON.stringify(config));f.setResponse({secrets:values});
    const observed=join(f.dir,'length');const out=await f.run(`require('fs').writeFileSync(${JSON.stringify(observed)},String(require('fs').statSync(process.env.FILE_19).size))`).result;assert.equal(out.code,0);assert.equal(await fs.readFile(observed,'utf8'),'65536');assert.deepEqual(await fs.readdir(f.root),[]);
  }finally{await f.close();}
});

test('HTTP reader rejects streamed overflow, invalid JSON and redirects', async()=>{
  const {requestJson}=await import('../src/cli/client.js');
  let mode='overflow';const server=createServer((req,res)=>{if(mode==='redirect'){res.writeHead(302,{location:'/credential-leak'});res.end();}else{res.writeHead(200,{'content-type':'application/json'});res.write(mode==='overflow'?'x'.repeat(80):'{bad');res.end();}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {for(mode of ['overflow','invalid','redirect'])await assert.rejects(requestJson(url,{},64),/request_failed/);}finally{await new Promise<void>(done=>server.close(()=>done()));}
});


for(const action of ['env','login','failed']) test(`valid CLI startup (${action}) cleans stale files without creating an absent root`,async()=>{
    const f=await fixture();try {
      const config=JSON.parse(await fs.readFile(f.config,'utf8'));config.secrets={API_TOKEN:{name:'TOKEN',kind:'env'}};await fs.writeFile(f.config,JSON.stringify(config));
      f.setResponse({secrets:[{name:'TOKEN',kind:'env',value:secret}]},action==='failed'?500:200);
      const execute=()=>action==='login'?f.launch(['login','--config',f.config]).result:f.run('process.exit(0)').result;
      await execute();await assert.rejects(fs.stat(f.root));
      await fs.mkdir(f.root,{mode:0o700});const stale=join(f.root,'run-2147483647-123456789abcdef0');await fs.mkdir(stale,{mode:0o700});
      await fs.writeFile(join(stale,'.preparing'),'',{mode:0o600});await fs.writeFile(join(stale,'KEY'),fileValue,{mode:0o600});
      assert.equal((await execute()).code,action==='failed'?1:0);await assert.rejects(fs.stat(stale));
    }finally{await f.close();}
});

test('SIGTERM reaches an npm foreground wrapper and retains files until its workload finishes',async()=>{
  const f=await fixture();let appPid:number|undefined;let running:ReturnType<typeof f.launch>|undefined;
  try {
    const ready=join(f.dir,'wrapper-ready'),seen=join(f.dir,'wrapper-seen');
    await fs.writeFile(join(f.dir,'package.json'),JSON.stringify({scripts:{dev:'node app.cjs; exit $?'}}));
    await fs.writeFile(join(f.dir,'app.cjs'),`const fs=require('fs');process.on('SIGTERM',()=>{setTimeout(()=>{fs.writeFileSync(${JSON.stringify(seen)},fs.readFileSync(process.env.SIGNING_KEY_FILE));process.exit(0)},300)});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,path:process.env.SIGNING_KEY_FILE}));setInterval(()=>{},100);`);
    running=f.launch(['run','--project','app','--env','dev','--config',f.config,'--','npm','--prefix',f.dir,'run','dev']);
    const info=JSON.parse(await waitFile(ready));appPid=info.pid;running.child.kill('SIGTERM');
    await new Promise(r=>setTimeout(r,100));assert.equal(await fs.readFile(info.path,'utf8'),fileValue);
    const outcome=await Promise.race([running.result,new Promise<null>(r=>setTimeout(()=>r(null),2500))]);
    assert.ok(outcome,'foreground workload did not stop after SIGTERM');assert.equal(outcome.signal,'SIGTERM');
    assert.equal(await fs.readFile(seen,'utf8'),fileValue);assert.deepEqual(await fs.readdir(f.root),[]);
  }finally{
    if(appPid){try{process.kill(appPid,'SIGKILL');}catch{}}if(running){running.child.kill('SIGKILL');await running.result;}await f.close();
  }
});

test('startup retains a live process group after its leader dies',async()=>{
  const f=await fixture();let descendant:number|undefined;
  const leader=spawn(process.execPath,['-e',`const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log(child.pid);`],{detached:true,stdio:['ignore','pipe','ignore']});
  try {
    let output='';for await(const bytes of leader.stdout!)output+=bytes;descendant=Number(output.trim());
    await new Promise<void>(done=>leader.exitCode!==null?done():leader.once('exit',()=>done()));
    await fs.mkdir(f.root,{mode:0o700});const orphan=join(f.root,'run-2147483647-0123456789abcdef');await fs.mkdir(orphan,{mode:0o700});
    await fs.writeFile(join(orphan,'.preparing'),'',{mode:0o600});await fs.writeFile(join(orphan,`.group-${leader.pid}`),'',{mode:0o600});await fs.writeFile(join(orphan,'KEY'),fileValue,{mode:0o600});
    assert.equal((await f.run('process.exit(0)').result).code,0);assert.equal(await fs.readFile(join(orphan,'KEY'),'utf8'),fileValue);
  }finally {if(descendant){try{process.kill(descendant,'SIGKILL');}catch{}}await f.close();}
});


test('an exited empty group preserves child status and cleans files without a process-listing executable',async()=>{
  const f=await fixture();try {
    const preload=join(f.dir,'no-ps.cjs');
    await fs.writeFile(preload,`const cp=require('child_process'),exec=cp.execFile;cp.execFile=function(file,...args){if(file==='/bin/ps'){const done=args.at(-1);queueMicrotask(()=>done(Object.assign(new Error('unavailable'),{code:'ENOENT'})));return;}return exec.call(this,file,...args)};`);
    const out=await f.run('process.exit(7)',{},['--require',preload]).result;
    assert.equal(out.code,7);assert.equal(out.stderr,'');assert.deepEqual(await fs.readdir(f.root),[]);
  }finally{await f.close();}
});

test('Linux inspects live foreground descendants without ps and parses a command name containing parentheses',{skip:process.platform!=='linux'},async()=>{
  const f=await fixture();let descendant:number|undefined;let running:ReturnType<typeof f.run>|undefined;
  try {
    const ready=join(f.dir,'proc-ready'),seen=join(f.dir,'proc-seen'),preload=join(f.dir,'no-ps.cjs');
    await fs.writeFile(preload,`const fs=require('fs/promises'),read=fs.readdir;fs.readdir=async function(path,...args){const names=await read.call(this,path,...args);return path==='/proc'?[...names,'2147483647']:names};const cp=require('child_process'),exec=cp.execFile;cp.execFile=function(file,...args){if(file==='/bin/ps'){const done=args.at(-1);queueMicrotask(()=>done(Object.assign(new Error('unavailable'),{code:'ENOENT'})));return;}return exec.call(this,file,...args)};`);
    const app=`const fs=require('fs');process.title='app ) R 0 999';process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(seen)},fs.readFileSync(process.env.SIGNING_KEY_FILE));process.exit(0)},250));fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,path:process.env.SIGNING_KEY_FILE}));setInterval(()=>{},100);`;
    running=f.run(`const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(app)}],{stdio:'inherit'});child.unref();`,{},['--require',preload]);
    const info=JSON.parse(await waitFile(ready));descendant=info.pid;
    await new Promise(r=>setTimeout(r,100));assert.equal(await fs.readFile(info.path,'utf8'),fileValue);
    running.child.kill('SIGTERM');const out=await running.result;
    assert.equal(out.signal,'SIGTERM');assert.equal(await fs.readFile(seen,'utf8'),fileValue);assert.deepEqual(await fs.readdir(f.root),[]);
  }finally {if(descendant){try{process.kill(descendant,'SIGKILL');}catch{}}if(running){running.child.kill('SIGKILL');await running.result;}await f.close();}
});
