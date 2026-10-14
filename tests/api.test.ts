import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { database } from './helpers/d1.js';
import { Store, DAY } from '../src/shared/store.js';
import { createAdminHandler } from '../src/admin/index.js';
import { createCiHandler } from '../src/ci/index.js';
const config = {ACCESS_ISSUER:'https://example.cloudflareaccess.com',ACCESS_AUD:'admin-aud',ADMIN_EMAIL:'owner@example.com',CI_AUDIENCE:'ci-aud',ACTIVE_KEY_ID:'current',KEYRING_JSON:JSON.stringify({current:Buffer.alloc(32,2).toString('base64')})};
let key: CryptoKey, other: CryptoKey, jwks: JWTVerifyGetKey, admin: ReturnType<typeof createAdminHandler>, ci: ReturnType<typeof createCiHandler>;
let data: Awaited<ReturnType<typeof database>>, store: Store, env: typeof config & {DB:D1Database;ASSETS:Pick<Fetcher,'fetch'>};
before(async () => {
  const pair = await generateKeyPair('RS256'); key = pair.privateKey; other = (await generateKeyPair('RS256')).privateKey;
  jwks = createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'test',alg:'RS256'}]});
  data = await database(); store = new Store(data.db,JSON.parse(config.KEYRING_JSON),config.ACTIVE_KEY_ID);
  env = {...config,DB:data.db,ASSETS:{fetch:async () => new Response('<html>private app</html>',{headers:{'content-type':'text/html'}})}};
  admin = createAdminHandler(jwks); ci = createCiHandler(jwks);
});
after(async () => {await data?.dispose();});
async function signed(kind:'admin'|'ci',overrides:JWTPayload={},signingKey=key) {
  const now = Math.floor(Date.now()/1000);
  return new SignJWT({iss:kind==='admin'?config.ACCESS_ISSUER:'https://token.actions.githubusercontent.com',aud:kind==='admin'?config.ACCESS_AUD:config.CI_AUDIENCE,sub:'fixture',iat:now,exp:now+300,...(kind==='admin'?{email:config.ADMIN_EMAIL}:{repository_id:'123',repository_owner_id:'456',repository:'owner/repo',ref:'refs/heads/main',ref_type:'branch',workflow_ref:'owner/repo/.github/workflows/deploy.yml@refs/heads/main',event_name:'push',environment:'production'}),...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(signingKey);
}
async function call(path:string,method='GET',body?:unknown,headers:Record<string,string>={},kind:'admin'|'ci'='admin',token?:string) {
  const jwt = token ?? await signed(kind);
  return (kind==='admin'?admin:ci).fetch(new Request(`https://app.example${path}`,{method,headers:{[kind==='admin'?'Cf-Access-Jwt-Assertion':'Authorization']:kind==='admin'?jwt:`Bearer ${jwt}`,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
}
async function json(response:Response,status=200):Promise<any> { assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);return response.json(); }
async function fixture() {
  const project = await store.createProject({name:'Fixture',slug:`fixture-${crypto.randomUUID()}`});
  const environment = await store.createEnvironment({projectId:project.id,name:'prod'});
  const secret = await store.createSecret({environmentId:environment.id,name:'TOKEN',kind:'env',value:'private-plaintext'});
  return {project,environment,secret};
}
test('admin authenticates API and static assets before serving content',async () => {
  for (const path of ['/','/app.js','/api/projects','/api/unknown']) {
    const response = await admin.fetch(new Request(`https://app.example${path}`),env);
    assert.deepEqual(await json(response,401),{error:{code:'unauthorized'}});
  }
  const asset=await call('/');assert.equal(asset.headers.get('cache-control'),'no-store');assert.equal(asset.headers.get('x-content-type-options'),'nosniff');assert.match(await asset.text(),/private app/);
  for (const token of [await signed('admin',{email:'intruder@example.com'}),await signed('admin',{aud:'wrong'}),await signed('admin',{},other),await signed('ci')]) {
    assert.deepEqual(await json(await call('/api/projects','GET',undefined,{},'admin',token),401),{error:{code:'unauthorized'}});
  }
  const jwt = await signed('admin');
  for (const header of [{'cf-access-token':jwt},{Cookie:`CF_Authorization=${jwt}`}] as Record<string,string>[]) {
    assert.equal((await json(await admin.fetch(new Request('https://app.example/api/projects',{headers:header}),env))).projects.length,0);
  }
});
test('admin rejects forged origins, cross-site fetches, non-JSON and oversized bodies without writes',async () => {
  for (const headers of [{Origin:'https://evil.example'},{Origin:'https://app.example.evil'},{'Sec-Fetch-Site':'cross-site'}] as Record<string,string>[]) {
    assert.deepEqual(await json(await call('/api/projects','POST',{name:'forged',slug:'forged'},headers),403),{error:{code:'forbidden_origin'}});
  }
  assert.deepEqual(await json(await call('/api/projects','POST',{}, {'content-type':'text/plain'}),415),{error:{code:'unsupported_media_type'}});
  assert.deepEqual(await json(await call('/api/projects','POST',{padding:'x'.repeat(1_048_577)}),413),{error:{code:'payload_too_large'}});
  assert.deepEqual(await json(await call('/api/projects','POST',null),400),{error:{code:'invalid_input'}});
  assert.equal((await store.listProjects()).length,0);
  const project = await json(await call('/api/projects','POST',{name:'Same origin',slug:'same-origin'},{Origin:'https://app.example'}),201);
  await json(await call(`/api/projects/${project.id}`,'DELETE',{}));
});
test('metadata CRUD, secret CAS, reveal, versions and trash preserve response contracts',async () => {
  let project = await json(await call('/api/projects','POST',{name:'App',slug:'app'}),201);
  assert.ok((await json(await call('/api/projects'))).projects.some((p:any)=>p.id===project.id));
  project = await json(await call(`/api/projects/${project.id}`,'PATCH',{name:'Application',slug:'application'}));
  let environment = await json(await call('/api/environments','POST',{projectId:project.id,name:'dev'}),201);
  assert.equal((await json(await call(`/api/environments?projectId=${project.id}`))).environments[0].id,environment.id);
  environment = await json(await call(`/api/environments/${environment.id}`,'PATCH',{name:'prod'}));
  const original = await json(await call('/api/secrets','POST',{environmentId:environment.id,name:'PEM',kind:'file',value:'a\r\n한글\r\n'}),201);
  const listed = await json(await call(`/api/secrets?environmentId=${environment.id}`));
  assert.equal(listed.secrets[0].id,original.id); assert.ok(!JSON.stringify(listed).includes('한글'));assert.ok(!JSON.stringify(listed).includes('ciphertext'));
  assert.deepEqual(await json(await call(`/api/secrets/${original.id}/reveal`,'POST',{})),{name:'PEM',kind:'file',value:'a\r\n한글\r\n'});
  let secret = await json(await call(`/api/secrets/${original.id}`,'PATCH',{expectedVersionId:original.currentVersionId,value:'updated'}));
  assert.deepEqual(await json(await call(`/api/secrets/${secret.id}`,'PATCH',{expectedVersionId:original.currentVersionId,value:'lost'}),409),{error:{code:'conflict'}});
  const versions = await json(await call(`/api/secrets/${secret.id}/versions`)); assert.equal(versions.versions.length,2); assert.ok(!JSON.stringify(versions).includes('updated'));
  secret = await json(await call(`/api/secrets/${secret.id}/versions/${original.currentVersionId}/restore`,'POST',{expectedVersionId:secret.currentVersionId}));
  await json(await call(`/api/secrets/${secret.id}`,'DELETE',{expectedVersionId:secret.currentVersionId}));
  assert.equal((await json(await call(`/api/trash?environmentId=${environment.id}`))).secrets[0].id,secret.id);
  assert.deepEqual(await json(await call(`/api/secrets/${secret.id}/reveal`,'POST',{}),404),{error:{code:'not_found'}});
  await json(await call(`/api/trash/${secret.id}/restore`,'POST',{expectedVersionId:secret.currentVersionId}));
  assert.equal((await json(await call('/api/resolve','POST',{project:project.slug,environment:environment.name,names:['PEM']}))).secrets[0].value,'a\r\n한글\r\n');
  assert.deepEqual(await json(await call('/api/resolve','POST',{project:project.slug,environment:environment.name,names:['PEM','MISSING']}),404),{error:{code:'not_found'}});
  assert.deepEqual(await json(await call(`/api/environments/${environment.id}`,'DELETE',{}),409),{error:{code:'conflict'}});
  const empty = await json(await call('/api/environments','POST',{projectId:project.id,name:'empty'}),201);
  await json(await call(`/api/environments/${empty.id}`,'DELETE',{}));
});
test('imports validate selected CAS entries and backup remains encrypted with guarded restore',async () => {
  const {environment} = await fixture();
  const preview = await json(await call('/api/imports/preview','POST',{environmentId:environment.id,source:'TOKEN=new\nNEW=two'}));
  assert.equal(preview.entries[0].exists,true);assert.ok(preview.entries[0].expectedVersionId);
  const imported = await json(await call('/api/imports/apply','POST',{environmentId:environment.id,entries:preview.entries.map(({name,value,expectedVersionId}:any)=>({name,value,...(expectedVersionId?{expectedVersionId}:{})}))}));
  assert.equal(imported.secrets.length,2);
  const backup = await json(await call('/api/backup')); assert.equal(backup.schemaVersion,1);assert.ok(!JSON.stringify(backup).includes('private-plaintext'));
  assert.deepEqual(await json(await call('/api/backup/restore','POST',backup),409),{error:{code:'conflict'}});
  const target = await database();
  try { const response = await admin.fetch(new Request('https://app.example/api/backup/restore',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':await signed('admin'),'content-type':'application/json'},body:JSON.stringify(backup)}),{...env,DB:target.db});assert.deepEqual(await json(response),{ok:true});assert.ok((await new Store(target.db,JSON.parse(config.KEYRING_JSON),'current').listProjects()).length>0); }
  finally {await target.dispose();}
});
test('staged operation API requires owner auth and same origin, hides preparation and commits once',async()=>{
  const {environment}=await fixture();
  const response=await call('/api/operations','POST',{kind:'import',environmentId:environment.id,counts:{imports:1}});
  const operation=await json(response,201);
  await json(await call(`/api/operations/${operation.id}`,'GET',undefined,{},'admin','invalid'),401);
  await json(await call(`/api/operations/${operation.id}/chunks`,'POST',{index:0,table:'imports',rows:[{name:'STAGED',value:'private-stage'}]},{origin:'https://bad.example'}),403);
  await json(await call(`/api/operations/${operation.id}/chunks`,'POST',{index:0,table:'imports',rows:[{name:'STAGED',value:'private-stage'}]}));
  assert(!(await store.listSecrets(environment.id)).some(secret=>secret.name==='STAGED'));
  await json(await call(`/api/operations/${operation.id}/commit`,'POST',{}));
  await json(await call(`/api/operations/${operation.id}/commit`,'POST',{}));
  assert.equal((await store.resolveEnvironment(environment.id,['STAGED'])).secrets[0]?.value,'private-stage');
  assert(!(await store.listAudit(500)).some(event=>JSON.stringify(event).includes('private-stage')));
});
test('CI requires signed GitHub identity and freshly authorizes requested environment before resolving',async () => {
  const {project,environment,secret} = await fixture();
  const policyInput = {environmentId:environment.id,repositoryId:'123',repositoryOwnerId:'456',branch:'refs/heads/main',workflow:'.github/workflows/deploy.yml',events:['push'],githubEnvironment:'production',active:true};
  let policy = await json(await call('/api/ci-policies','POST',policyInput),201);
  assert.equal((await json(await call(`/api/ci-policies?environmentId=${environment.id}`))).policies[0].id,policy.id);
  const body={project:project.slug,environment:'prod',names:['TOKEN']};
  assert.deepEqual(await json(await call('/v1/resolve','POST',body,{},'ci')),{secrets:[{name:'TOKEN',kind:'env',value:'private-plaintext'}]});
  for(const claims of [{aud:'wrong'},{repository_id:'999'},{repository_owner_id:'999'},{event_name:'pull_request'},{ref:'refs/tags/main',ref_type:'tag'},{ref:'refs/heads/other'},{workflow_ref:'owner/repo/.github/workflows/other.yml@refs/heads/main'},{environment:'other'}]) {
    assert.deepEqual(await json(await call('/v1/resolve','POST',body,{},'ci',await signed('ci',claims)),claims.aud?401:403),{error:{code:claims.aud?'unauthorized':'forbidden'}});
  }
  assert.deepEqual(await json(await call('/v1/resolve','POST',body,{},'ci',await signed('ci',{},other)),401),{error:{code:'unauthorized'}});
  assert.deepEqual(await json(await call('/v1/resolve','POST',{...body,names:['TOKEN','MISSING']},{},'ci'),404),{error:{code:'not_found'}});
  const denied = await fixture();
  assert.deepEqual(await json(await call('/v1/resolve','POST',{project:denied.project.slug,environment:'prod',names:['TOKEN']},{},'ci'),403),{error:{code:'forbidden'}});
  policy=await json(await call(`/api/ci-policies/${policy.id}`,'PATCH',{active:false}));assert.equal(policy.active,false);
  assert.deepEqual(await json(await call('/v1/resolve','POST',body,{},'ci'),403),{error:{code:'forbidden'}});
  await json(await call(`/api/ci-policies/${policy.id}`,'DELETE',{}));
  for(const path of ['/api/projects',`/api/secrets/${secret.id}/reveal`,'/']) assert.deepEqual(await json(await call(path,'POST',{}, {},'ci'),404),{error:{code:'not_found'}});
});
test('audit records safe fixed operations on successes, denials and errors; never payloads or token',async () => {
  await call('/api/untrusted-private-value','POST',{value:'untrusted-private-value'});
  const {secret} = await fixture();
  await call(`/api/secrets/${secret.id}/reveal`,'POST',{});
  const events=(await json(await call('/api/audit-events?limit=500'))).events;
  assert.ok(events.some((e:any)=>e.result==='success'&&e.targetId===secret.id));assert.ok(events.some((e:any)=>e.result==='denied'));assert.ok(events.some((e:any)=>e.result==='error'));
  for(const value of ['private-plaintext','untrusted-private-value','Cf-Access','eyJ']) assert.ok(!JSON.stringify(events).includes(value));
});
test('verified CI denials retain numeric repository identity in audit without trusting other token fields',async () => {
  const {project}=await fixture();
  await call('/v1/resolve','POST',{project:project.slug,environment:'prod',names:['TOKEN']},{},'ci');
  const events=await store.listAudit(500);
  assert.ok(events.some(event=>event.action==='ci.resolve'&&event.result==='denied'&&event.actor==='github:123'));
});
test('storage exceptions and failing denial audits expose only safe error codes',async () => {
  const broken = {...env,DB:{prepare(){throw new Error('database password or secret exception');}} as unknown as D1Database};
  assert.deepEqual(await json(await admin.fetch(new Request('https://app.example/api/projects'),broken),401),{error:{code:'unauthorized'}});
  assert.deepEqual(await json(await admin.fetch(new Request('https://app.example/api/projects',{headers:{'cf-access-jwt-assertion':await signed('admin')}}),broken),500),{error:{code:'storage_error'}});
});
test('scheduled cleanup bounds deleted records and emits one safe system audit',async () => {
  const local=await database();
  try {
    const old = Date.now()-31*DAY;
    await local.db.batch(Array.from({length:105},()=>local.db.prepare('INSERT INTO audit_events(id,actor,action,target_id,result,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),'system','old',null,'success',old)));
    await admin.scheduled({} as ScheduledController,{...env,DB:local.db});
    const rows=(await local.db.prepare('SELECT actor,action,result,created_at FROM audit_events').all()).results;
    assert.equal(rows.filter(row=>row.created_at===old).length,5);
    assert.ok(rows.some(row=>row.actor==='system'&&row.action==='cleanup'&&row.result==='success'));
  } finally {await local.dispose();}
});
test('corrupt ciphertext fails the whole API response without returning another plaintext',async () => {
  const {project,environment,secret}=await fixture();
  await store.createSecret({environmentId:environment.id,name:'OTHER',kind:'env',value:'other-private-value'});
  await data.db.prepare('UPDATE secret_versions SET ciphertext=? WHERE id=?').bind(Buffer.alloc(32).toString('base64'),secret.currentVersionId).run();
  const response=await call('/api/resolve','POST',{project:project.slug,environment:'prod',names:['OTHER','TOKEN']});
  assert.deepEqual(await json(response,500),{error:{code:'decryption_failed'}});
});
test('CI resolution remains on authorized environment ID when names change during policy lookup',async () => {
  const {project,environment}=await fixture();
  const otherEnv=await store.createEnvironment({projectId:project.id,name:'other'});
  await store.createSecret({environmentId:otherEnv.id,name:'TOKEN',kind:'env',value:'unauthorized-value'});
  await store.savePolicy({environmentId:environment.id,repositoryId:'123',repositoryOwnerId:'456',branch:'refs/heads/main',workflow:'.github/workflows/deploy.yml',events:['push'],githubEnvironment:'production',active:true});
  const lookup=Store.prototype.getEnvironment;
  Store.prototype.getEnvironment=async function(projectSlug:string,environmentName:string) {
    const result=await lookup.call(this,projectSlug,environmentName);
    await store.updateEnvironment(environment.id,{name:'renamed'});
    await store.updateEnvironment(otherEnv.id,{name:'prod'});
    return result;
  };
  try { assert.deepEqual(await json(await call('/v1/resolve','POST',{project:project.slug,environment:'prod',names:['TOKEN']},{},'ci')),{secrets:[{name:'TOKEN',kind:'env',value:'private-plaintext'}]}); }
  finally {Store.prototype.getEnvironment=lookup;}
});


for(const revoke of ['disable','delete']) test(`policy PATCH preserves concurrent ${revoke}`,async () => {
  const {environment}=await fixture();
    const policy=await store.savePolicy({environmentId:environment.id,repositoryId:'123',repositoryOwnerId:'456',branch:'refs/heads/main',workflow:'.github/workflows/deploy.yml',events:['push'],githubEnvironment:null,active:true});
    const batch=Store.prototype.batch; let intercepted=false;
    // D1 prepared statements are opaque; gate the first policy mutation, before its real SQL executes.
    Store.prototype.batch=async function(statements) {
      if(!intercepted) {
        intercepted=true;
        if(revoke==='disable')await data.db.prepare('UPDATE ci_policies SET active=0 WHERE id=?').bind(policy.id).run();
        else await data.db.prepare('DELETE FROM ci_policies WHERE id=?').bind(policy.id).run();
      }
      return batch.call(this,statements);
    };
    try {
      const result=await json(await call(`/api/ci-policies/${policy.id}`,'PATCH',{workflow:'.github/workflows/new.yml'}),revoke==='delete'?404:200);
      const policies=(await store.listPolicies()).filter(item=>item.id===policy.id);
      if(revoke==='delete')assert.deepEqual(policies,[]);
      else { assert.equal(result.active,false);assert.equal(policies[0]!.active,false);assert.equal(policies[0]!.workflow,'.github/workflows/new.yml'); }
    } finally {Store.prototype.batch=batch;}
});

test('resolve and import audits retain validated environment context on successes and errors',async () => {
  const {project,environment}=await fixture();
  for(const [path,input,status,action] of [
    ['/api/resolve',{project:project.slug,environment:'prod',names:['TOKEN']},200,'secrets.resolve'],
    ['/api/resolve',{project:project.slug,environment:'prod',names:['MISSING']},404,'secrets.resolve'],
    ['/api/imports/preview',{environmentId:environment.id,source:'NEW=value'},200,'imports.preview'],
    ['/api/imports/preview',{environmentId:environment.id,source:'broken'},400,'imports.preview'],
    ['/api/imports/apply',{environmentId:environment.id,entries:[{name:'NEW',value:'value'}]},200,'imports.apply'],
    ['/api/imports/apply',{environmentId:environment.id,entries:[{name:'TOKEN',value:'value'}]},409,'imports.apply'],
  ] as const) {
    const previous=new Set((await store.listAudit(500)).map(event=>event.id));
    await json(await call(path,'POST',input),status);
    const events=(await store.listAudit(500)).filter(event=>!previous.has(event.id));
    assert.equal(events.length,1);assert.equal(events[0]!.action,action);assert.equal(events[0]!.targetId,environment.id);assert.equal(events[0]!.result,status===200?'success':'error');
  }
  await json(await call('/api/imports/preview','POST',{environmentId:environment.id,source:'NEW=value'},{Origin:'https://evil.example'}),403);
  assert.ok((await store.listAudit(500)).some(event=>event.action==='imports.preview'&&event.result==='denied'&&event.targetId===null));
});
