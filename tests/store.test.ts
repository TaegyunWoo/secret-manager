import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.js';
import { Store } from '../src/shared/store.js';
import { parseDotenv, previewImport, applyImport } from '../src/shared/imports.js';
import { exportBackup, restoreBackup } from '../src/shared/backup.js';
import {Operations} from '../src/shared/operations.js';
const keys = { main: Buffer.alloc(32, 41).toString('base64') };
const day = 86400000;
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const fixture = await database(); t.after(fixture.dispose);
  const store = new Store(fixture.db, keys, 'main');
  const project = await store.createProject({ name: 'Example', slug: 'example' });
  const environment = await store.createEnvironment({ projectId: project.id, name: 'dev' });
  return { ...fixture, store, project, environment };
}
test('stores only ciphertext; metadata rename preserves decryption; parents reject children', async t => {
  const { store, db, project, environment } = await setup(t);
  const secret = await store.createSecret({ environmentId: environment.id, name: 'KEY', kind: 'file', value: 'private\r\nPEM\r\n' });
  assert.equal((await store.reveal(secret.id)).value, 'private\r\nPEM\r\n');
  assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM secret_versions').all()).includes('private'));
  assert.ok(!JSON.stringify(await store.listSecrets(environment.id)).includes('ciphertext'));
  await store.updateProject(project.id, { name: 'Renamed', slug: 'renamed' });
  await store.updateEnvironment(environment.id, { name: 'prod' });
  assert.equal((await store.resolve('renamed', 'prod', ['KEY'])).secrets[0]?.value, 'private\r\nPEM\r\n');
  await assert.rejects(store.deleteProject(project.id), { code: 'conflict' });
  await assert.rejects(store.deleteEnvironment(environment.id), { code: 'conflict' });
  await assert.rejects(store.createProject({ name: 'Other', slug: 'renamed' }), { code: 'conflict' });
  await assert.rejects(store.createSecret({ environmentId: environment.id, name: 'KEY', kind: 'env', value: '' }), { code: 'conflict' });
  await assert.rejects(store.resolve('renamed', 'prod', ['KEY', 'MISSING']), { code: 'not_found' });
  await assert.rejects(store.resolve('renamed', 'prod', Array(101).fill('KEY')), { code: 'invalid_input' });
  await assert.rejects(store.createSecret({ environmentId: environment.id, name: 'BIG', kind: 'env', value: 'x'.repeat(65537) }), { code: 'invalid_input' });
});
test('concurrent and stale CAS leave one winner with ten versions; restoring adds fresh ciphertext', async t => {
  const { store, environment, db } = await setup(t);
  let secret = await store.createSecret({ environmentId: environment.id, name: 'KEY', kind: 'env', value: '' });
  const initial = secret.currentVersionId;
  const results = await Promise.allSettled(['first', 'second'].map(value => store.updateSecret(secret.id, { expectedVersionId: initial, value })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.listVersions(secret.id)).length, 2);
  await assert.rejects(store.updateSecret(secret.id, { expectedVersionId: initial, value: 'stale' }), { code: 'conflict' });
  secret = (await store.listSecrets(environment.id))[0]!;
  for (let i = 0; i < 12; i++) secret = await store.updateSecret(secret.id, { expectedVersionId: secret.currentVersionId, value: String(i) });
  const versions = await store.listVersions(secret.id); assert.equal(versions.length, 10);
  const old = versions[versions.length - 1]!;
  const oldNonce = await db.prepare('SELECT nonce FROM secret_versions WHERE id=?').bind(old.id).first<string>('nonce');
  const restored = await store.restoreVersion(secret.id, old.id, secret.currentVersionId);
  assert.notEqual(restored.currentVersionId, old.id);
  assert.equal((await store.reveal(secret.id)).value, '2');
  const rows = await db.prepare('SELECT nonce FROM secret_versions WHERE id IN (?,?)').bind(old.id, restored.currentVersionId).all<{nonce: string}>();
  assert.notEqual(rows.results[0]?.nonce, oldNonce);
});
test('trash reserves names, rejects stale CAS and expiry; cleanup and audit retention are bounded', async t => {
  const { store, environment, db } = await setup(t);
  const secret = await store.createSecret({ environmentId: environment.id, name: 'KEY', kind: 'env', value: 'value' });
  await assert.rejects(store.deleteSecret(secret.id, crypto.randomUUID()), { code: 'conflict' });
  await store.deleteSecret(secret.id, secret.currentVersionId);
  await assert.rejects(store.reveal(secret.id), { code: 'not_found' });
  assert.equal((await store.listTrash(environment.id)).length, 1);
  await assert.rejects(store.createSecret({ environmentId: environment.id, name: 'KEY', kind: 'env', value: '' }), { code: 'conflict' });
  await store.restoreSecret(secret.id, secret.currentVersionId);
  await store.deleteSecret(secret.id, secret.currentVersionId);
  await db.prepare('UPDATE secrets SET deleted_at=? WHERE id=?').bind(Date.now() - 7 * day, secret.id).run();
  await assert.rejects(store.restoreSecret(secret.id, secret.currentVersionId), { code: 'conflict' });
  for (let i = 0; i < 3; i++) await store.audit({ actor: 'user@example.test', action: 'resolve', targetId: environment.id, result: 'success' });
  await db.prepare('UPDATE audit_events SET created_at=?').bind(Date.now() - 30 * day - 1).run();
  assert.equal((await store.listAudit()).length, 0);
  const removed = await store.cleanup(1); assert.deepEqual(removed, { secrets: 1, events: 1 });
  assert.equal((await db.prepare('SELECT * FROM audit_events').all()).results.length, 2);
  assert.equal((await db.prepare('SELECT * FROM secret_versions').all()).results.length, 0);
});
test('dotenv parses literal multiline/export/comments and atomically rejects stale chosen overwrites', async t => {
  assert.deepEqual(parseDotenv('export A="hello\\n${LITERAL}" # comment\nB=\'one\ntwo\'\nC= # empty\nD=unquoted # comment'), [
    { name: 'A', value: 'hello\n${LITERAL}' }, { name: 'B', value: 'one\ntwo' }, { name: 'C', value: '' }, { name: 'D', value: 'unquoted' }
  ]);
  for (const invalid of ['A=1\nA=2', 'INVALID LINE', 'A="unclosed', 'A="x"junk']) assert.throws(() => parseDotenv(invalid), { code: 'invalid_input' });
  const { store, environment } = await setup(t);
  const original = await store.createSecret({ environmentId: environment.id, name: 'A', kind: 'env', value: 'old' });
  const preview = await previewImport(store, environment.id, 'A=new\nB=other');
  assert.equal(preview.entries[0]?.expectedVersionId, original.currentVersionId);
  await assert.rejects(applyImport(store, environment.id, [{ name: 'A', value: 'new' }, { name: 'B', value: 'other' }]), { code: 'conflict' });
  assert.equal((await store.listSecrets(environment.id)).length, 1);
  await store.updateSecret(original.id, { expectedVersionId: original.currentVersionId, value: 'concurrent' });
  await assert.rejects(applyImport(store, environment.id, [{ name: 'B', value: 'other' }, { name: 'A', value: 'new', expectedVersionId: original.currentVersionId }]), { code: 'conflict' });
  assert.equal((await store.listSecrets(environment.id)).length, 1);
  const current = (await store.listSecrets(environment.id))[0]!;
  await applyImport(store, environment.id, [{ name: 'A', value: 'new', expectedVersionId: current.currentVersionId }, { name: 'B', value: '' }]);
  assert.deepEqual((await store.resolve('example', 'dev', ['A', 'B'])).secrets.map(x => x.value), ['new', '']);
  const entries=Array.from({length:100},(_,i)=>({name:`KEY_${i}`,value:''}));
  await assert.rejects(applyImport(store,environment.id,entries),{code:'chunk_required'});
  const operations=new Operations(store,'owner@example.test'),operation=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:100}});
  for(let index=0;index<10;index++)await operations.upload(operation.id,index,'imports',entries.slice(index*10,index*10+10));
  assert.equal((await store.listSecrets(environment.id)).length,2);
  await operations.commit(operation.id);assert.equal((await store.listSecrets(environment.id)).length,102);
});
test('backup roundtrip verifies ciphertext and relationships, rejects nonempty DB, disables restored policies', async t => {
  const { store, environment } = await setup(t);
  const secret = await store.createSecret({ environmentId: environment.id, name: 'KEY', kind: 'env', value: 'sensitive' });
  const policy = await store.savePolicy({ environmentId: environment.id, repositoryId: '123', repositoryOwnerId: '456', branch: 'refs/heads/main', workflow: '.github/workflows/deploy.yml', events: ['push'], githubEnvironment: null, active: true });
  assert.equal((await store.listPolicies(environment.id, true)).length, 1);
  await store.savePolicy({ ...policy, active: false });
  assert.equal((await store.listPolicies(environment.id, true)).length, 0);
  await store.savePolicy({ ...policy, active: true });
  const backup = await exportBackup(store); assert.ok(!JSON.stringify(backup).includes('sensitive'));
  await assert.rejects(restoreBackup(store, backup), { code: 'conflict' });
  const target = await database(); t.after(target.dispose); const restored = new Store(target.db, keys, 'main');
  const corrupt = structuredClone(backup); corrupt.tables.secret_versions[0]!.ciphertext = 'AAAA';
  await assert.rejects(restoreBackup(restored, corrupt), { code: 'invalid_backup' });
  assert.equal((await restored.listProjects()).length, 0);
  const broken = structuredClone(backup); broken.tables.secrets[0]!.environment_id = crypto.randomUUID();
  await assert.rejects(restoreBackup(restored, broken), { code: 'invalid_backup' });
  await restoreBackup(restored, backup);
  assert.equal((await restored.reveal(secret.id)).value, 'sensitive');
  assert.equal((await restored.listPolicies())[0]?.active, false);
  const oversize = structuredClone(backup); oversize.tables.secret_versions[0]!.ciphertext = 'x'.repeat(1048577);
  await assert.rejects(restoreBackup(new Store(target.db, keys, 'main'), oversize), { code: 'backup_too_large' });
});
test('resolve rejects byte growth between preflight and fetch instead of decrypting an oversized batch',async t=>{
  const {store,environment}=await setup(t);
  const a=await store.createSecret({environmentId:environment.id,name:'A',kind:'file',value:'small'}),b=await store.createSecret({environmentId:environment.id,name:'B',kind:'file',value:'small'});
  const original=store.rows.bind(store);let mutated=false;
  store.rows=async function<T>(sql:string,...params:unknown[]):Promise<T[]>{
    const result=await original<T>(sql,...params);
    if(!mutated&&sql.startsWith('SELECT length(v.ciphertext)')){mutated=true;for(const secret of [a,b])await store.updateSecret(secret.id,{expectedVersionId:secret.currentVersionId,value:'x'.repeat(65536)});}
    return result;
  };
  await assert.rejects(store.resolveEnvironment(environment.id,['A','B']),{code:'chunk_required'});assert(mutated);
});
test('legacy backup counts escaped JSON bytes and requires chunks above its small-request budget',async t=>{
  const {store}=await setup(t);
  for(let i=0;i<300;i++)await store.createProject({name:'"'.repeat(128),slug:'quoted-'+i});
  await assert.rejects(exportBackup(store),{code:'chunk_required'});
});
test('concurrent bulk imports roll back every losing insert after passing the same preview', async t => {
  const {store, db, environment} = await setup(t);
  const original = await store.createSecret({environmentId: environment.id, name: 'A', kind: 'env', value: 'old'});
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let arrivals = 0;
  class RacingStore extends Store {
    override async batch(statements: D1PreparedStatement[]) { if (++arrivals === 2) release(); await barrier; return super.batch(statements); }
  }
  const results = await Promise.allSettled(['B', 'C'].map(name => applyImport(new RacingStore(db, keys, 'main'), environment.id, [{name, value: 'new'}, {name: 'A', value: name, expectedVersionId: original.currentVersionId}])));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.listSecrets(environment.id)).length, 2);
  assert.equal((await store.listVersions(original.id)).length, 2);
});
test('restore permits audit-only targets and preserves existing overlapping audit records', async t => {
  const { store, environment } = await setup(t);
  await store.audit({actor:'backup@example.test', action:'export', targetId:environment.id, result:'success'});
  const backup = await exportBackup(store);
  const target = await database(); t.after(target.dispose); const destination = new Store(target.db, keys, 'main');
  await destination.audit({actor:'target@example.test', action:'restore', targetId:null, result:'denied'});
  const auditId = backup.tables.audit_events[0]!.id;
  await target.db.prepare('UPDATE audit_events SET id=?').bind(auditId).run();
  await restoreBackup(destination, backup);
  assert.equal((await destination.listAudit()).length, 1);
  assert.equal((await destination.listAudit())[0]?.actor, 'target@example.test');
});
test('export rejects exceeding its byte or row bounds instead of truncating', async t => {
  const {store, environment, db} = await setup(t);
  for(let i = 0; i < 13; i++) await store.createSecret({environmentId:environment.id,name:`K_${i}`,kind:'env',value:'x'.repeat(65536)});
  await assert.rejects(exportBackup(store), {code:'backup_too_large'});
  await db.prepare('DELETE FROM secrets').run();
  const events = Array.from({length:1001}, () => ({id:crypto.randomUUID()}));
  await db.prepare("INSERT INTO audit_events(id,actor,action,target_id,result,created_at) SELECT value->>'id','actor','action',NULL,'success',1 FROM json_each(?)").bind(JSON.stringify(events)).run();
  await assert.rejects(exportBackup(store), {code:'backup_too_large'});
});
test('schema rejects attaching a secret to another secret version', async t => {
  const {store, db, environment} = await setup(t);
  const a = await store.createSecret({environmentId:environment.id,name:'A',kind:'env',value:'a'});
  const b = await store.createSecret({environmentId:environment.id,name:'B',kind:'env',value:'b'});
  await assert.rejects(db.prepare('UPDATE secrets SET current_version_id=? WHERE id=?').bind(b.currentVersionId,a.id).run());
  assert.equal((await store.reveal(a.id)).value, 'a');
});
test('metadata constructors never accept client-chosen IDs or echo unrecognized fields', async t => {
  const {store} = await setup(t);
  const injected = crypto.randomUUID();
  const project = await store.createProject({id:injected,name:'Safe',slug:'safe',unexpected:'hidden'} as Parameters<Store['createProject']>[0]);
  assert.notEqual(project.id, injected); assert.equal(Object.hasOwn(project,'unexpected'), false);
  const environment = await store.createEnvironment({id:injected,projectId:project.id,name:'prod',unexpected:'hidden'} as Parameters<Store['createEnvironment']>[0]);
  assert.notEqual(environment.id, injected); assert.equal(Object.hasOwn(environment,'unexpected'), false);
});
test('ID-based resolution remains pinned after environment names change', async t => {
  const {store,project,environment} = await setup(t);
  await store.createSecret({environmentId:environment.id,name:'KEY',kind:'env',value:'authorized'});
  const approved = await store.getEnvironment('example','dev');
  await store.updateEnvironment(environment.id,{name:'renamed'});
  const replacement = await store.createEnvironment({projectId:project.id,name:'dev'});
  await store.createSecret({environmentId:replacement.id,name:'KEY',kind:'env',value:'other'});
  assert.equal((await store.resolveEnvironment(approved.id,['KEY'])).secrets[0]?.value,'authorized');
});


test('policy field updates validate supplied values and explicitly activate without rewriting other fields',async t=>{
  const {store,environment}=await setup(t);
  const original=await store.savePolicy({environmentId:environment.id,repositoryId:'123',repositoryOwnerId:'456',branch:'refs/heads/main',workflow:'.github/workflows/deploy.yml',events:['push'],githubEnvironment:null,active:true});
  for(const input of [{},{active:'yes'},{environmentId:'bad'},{repositoryId:'0123'},{repositoryOwnerId:'x'},{branch:'refs/tags/main'},{workflow:'../deploy.yml'},{events:[]},{githubEnvironment:' unsafe '},{unexpected:'value'}]) {
    await assert.rejects(store.updatePolicy(original.id,input as any),{code:'invalid_input'});
    assert.deepEqual((await store.listPolicies())[0],original);
  }
  assert.equal((await store.updatePolicy(original.id,{active:false})).active,false);
  const edited=await store.updatePolicy(original.id,{workflow:'.github/workflows/new.yml'});assert.equal(edited.active,false);
  assert.deepEqual(await store.updatePolicy(original.id,{active:true}),{...original,workflow:'.github/workflows/new.yml'});
});
