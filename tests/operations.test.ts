import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './helpers/d1.js';
import {Store} from '../src/shared/store.js';
import {Operations} from '../src/shared/operations.js';
import {exportBackup} from '../src/shared/backup.js';
const keys={main:Buffer.alloc(32,41).toString('base64')};
async function setup(t:{after:(callback:()=>Promise<void>)=>void}){
  const fixture=await database();t.after(fixture.dispose);const store=new Store(fixture.db,keys,'main');
  const project=await store.createProject({name:'Batch test',slug:'batch-test'}),environment=await store.createEnvironment({projectId:project.id,name:'dev'});
  return {...fixture,store,project,environment,operations:new Operations(store,'owner@example.test')};
}
test('staged imports store only ciphertext, stay invisible, commit atomically and retry safely',async t=>{
  const {store,db,environment,operations}=await setup(t);
  const operation=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:2}});
  await operations.upload(operation.id,0,'imports',[{name:'A',value:'private-first'}]);
  assert.equal((await store.listSecrets(environment.id)).length,0);
  assert(!JSON.stringify((await db.prepare('SELECT payload FROM staged_chunks').all()).results).includes('private-first'));
  await assert.rejects(operations.commit(operation.id),{code:'conflict'});
  await operations.upload(operation.id,1,'imports',[{name:'B',value:'private-second'}]);
  await operations.commit(operation.id);await operations.commit(operation.id);
  assert.deepEqual((await store.resolve('batch-test','dev',['A','B'])).secrets.map(s=>s.value),['private-first','private-second']);
  assert.equal((await db.prepare('SELECT payload FROM staged_chunks').all()).results.length,0);
});
test('staging enforces owner, sequence, expiry and rolls back every write on stale CAS',async t=>{
  const {store,db,environment,operations}=await setup(t);
  const old=await store.createSecret({environmentId:environment.id,name:'OLD',kind:'env',value:'old'});
  const operation=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:2}});
  await assert.rejects(new Operations(store,'other@example.test').get(operation.id),{code:'not_found'});
  await assert.rejects(operations.upload(operation.id,1,'imports',[{name:'NEW',value:'value'}]),{code:'conflict'});
  await operations.upload(operation.id,0,'imports',[{name:'NEW',value:'value'},{name:'OLD',value:'staged',expectedVersionId:old.currentVersionId}]);
  await store.updateSecret(old.id,{expectedVersionId:old.currentVersionId,value:'concurrent'});
  await assert.rejects(operations.commit(operation.id),{code:'conflict'});
  assert.equal((await store.listSecrets(environment.id)).length,1);assert.equal((await store.reveal(old.id)).value,'concurrent');
  const expired=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:1}});
  await db.prepare('UPDATE staged_operations SET expires_at=0 WHERE id=?').bind(expired.id).run();
  await assert.rejects(operations.upload(expired.id,0,'imports',[{name:'X',value:'x'}]),{code:'operation_expired'});
});
test('backup restore stages validated rows and rejects missing references without partial data',async t=>{
  const source=await setup(t);await source.store.createSecret({environmentId:source.environment.id,name:'FILE',kind:'file',value:'\uFEFFvalue\r\n'});
  const backup=await exportBackup(source.store),target=await database();t.after(target.dispose);
  const store=new Store(target.db,keys,'main'),operations=new Operations(store,'owner@example.test');
  const operation=await operations.begin({kind:'restore',createdAt:backup.createdAt,counts:Object.fromEntries(Object.entries(backup.tables).map(([name,rows])=>[name,rows.length]))});
  let index=0;for(const [table,rows] of Object.entries(backup.tables))if(rows.length)await operations.upload(operation.id,index++,table,rows);
  assert.equal((await store.listProjects()).length,0);await operations.commit(operation.id);await operations.commit(operation.id);
  assert.equal((await store.resolve('batch-test','dev',['FILE'])).secrets[0]?.value,'\uFEFFvalue\r\n');
  const second=await operations.begin({kind:'restore',createdAt:backup.createdAt,counts:Object.fromEntries(Object.entries(backup.tables).map(([name,rows])=>[name,rows.length]))});
  index=0;for(const [table,rows] of Object.entries(backup.tables))if(rows.length)await operations.upload(second.id,index++,table,rows);
  await assert.rejects(operations.commit(second.id),{code:'conflict'});assert.equal((await store.listProjects()).length,1);
});
test('snapshot export pages remain unchanged after later writes and cleanup removes expired staging',async t=>{
  const {store,db,environment,operations}=await setup(t);
  await store.createSecret({environmentId:environment.id,name:'FILE',kind:'file',value:'value'});
  const operation=await operations.begin({kind:'export'});
  await store.createSecret({environmentId:environment.id,name:'LATER',kind:'env',value:'later'});
  const page=await operations.page(operation.id,'secrets',0);
  assert.equal(page.rows.length,1);assert.equal(page.rows[0]?.name,'FILE');
  await db.prepare('UPDATE staged_operations SET expires_at=0 WHERE id=?').bind(operation.id).run();
  await store.cleanup();assert.equal((await db.prepare('SELECT id FROM staged_operations').all()).results.length,0);
  assert.equal((await db.prepare('SELECT payload FROM staged_chunks').all()).results.length,0);
});
test('concurrent preparation accepts only one matching sequence and preserves incomplete state',async t=>{
  const {store,db,environment,operations}=await setup(t),operation=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:2}});
  const results=await Promise.allSettled(['A','B'].map(name=>operations.upload(operation.id,0,'imports',[{name,value:'value'}])));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await operations.get(operation.id)).nextIndex,1);
  assert.equal((await db.prepare('SELECT payload FROM staged_chunks WHERE operation_id=?').bind(operation.id).all()).results.length,1);
  await assert.rejects(operations.commit(operation.id),{code:'conflict'});assert.equal((await store.listSecrets(environment.id)).length,0);
});
test('restore rejects cross-chunk duplicate IDs and missing current versions before any data appears',async t=>{
  const source=await setup(t);await source.store.createSecret({environmentId:source.environment.id,name:'FILE',kind:'file',value:'value'});
  const backup=await exportBackup(source.store);
  for(const mode of ['duplicate','missing-current']){
    const target=await database();t.after(target.dispose);const store=new Store(target.db,keys,'main'),operations=new Operations(store,'owner@example.test');
    const changed=structuredClone(backup);
    if(mode==='duplicate')changed.tables.projects.push({...changed.tables.projects[0]!});else changed.tables.secrets[0]!.current_version_id=crypto.randomUUID();
    const operation=await operations.begin({kind:'restore',createdAt:changed.createdAt,counts:Object.fromEntries(Object.entries(changed.tables).map(([table,rows])=>[table,rows.length]))});
    let index=0;for(const [table,rows] of Object.entries(changed.tables))for(const row of rows)await operations.upload(operation.id,index++,table,[row]);
    await assert.rejects(operations.commit(operation.id),{code:'invalid_backup'});assert.equal((await store.listProjects()).length,0);
  }
});
test('staging enforces accumulated bytes and declared counts without retaining losing chunks',async t=>{
  const {store,db,environment,operations}=await setup(t);
  const operation=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:3}});
  await operations.upload(operation.id,0,'imports',[{name:'A',value:'x'.repeat(65536)}]);
  await assert.rejects(operations.upload(operation.id,1,'imports',[{name:'B',value:'x'.repeat(65536)}]),{code:'payload_too_large'});
  assert.equal((await operations.get(operation.id)).nextIndex,1);
  assert.equal((await db.prepare('SELECT payload FROM staged_chunks WHERE operation_id=?').bind(operation.id).all()).results.length,1);
  const small=await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:1}});
  await assert.rejects(operations.upload(small.id,0,'imports',[{name:'B',value:''},{name:'C',value:''}]),{code:'conflict'});
  assert.equal((await store.listSecrets(environment.id)).length,0);
});
test('capacity is bounded and cancelled staging is removed while receipts remain',async t=>{
  const {db,environment,operations}=await setup(t);const ids=[];
  for(let i=0;i<8;i++)ids.push((await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:1}})).id);
  await assert.rejects(operations.begin({kind:'import',environmentId:environment.id,counts:{imports:1}}),{code:'conflict'});
  await operations.upload(ids[0]!,0,'imports',[{name:'A',value:'private'}]);await operations.cancel(ids[0]!);
  assert.equal((await db.prepare('SELECT payload FROM staged_chunks WHERE operation_id=?').bind(ids[0]).all()).results.length,0);
  await assert.rejects(operations.commit(ids[0]!),{code:'invalid_input'});
  await operations.begin({kind:'import',environmentId:environment.id,counts:{imports:1}});
});
test('restore cryptographic tampering is rejected before storing the version',async t=>{
  const source=await setup(t);await source.store.createSecret({environmentId:source.environment.id,name:'FILE',kind:'file',value:'private'});
  const backup=await exportBackup(source.store),target=await database();t.after(target.dispose);const store=new Store(target.db,keys,'main'),operations=new Operations(store,'owner@example.test');
  const operation=await operations.begin({kind:'restore',createdAt:backup.createdAt,counts:Object.fromEntries(Object.entries(backup.tables).map(([table,rows])=>[table,rows.length]))});
  let index=0;for(const table of ['projects','environments','secrets'] as const)await operations.upload(operation.id,index++,table,backup.tables[table]);
  const version={...backup.tables.secret_versions[0]!},bytes=Buffer.from(version.ciphertext as string,'base64');bytes[0]=bytes[0]!^1;version.ciphertext=bytes.toString('base64');
  await assert.rejects(operations.upload(operation.id,index,'secret_versions',[version]),{code:'invalid_backup'});
  assert.equal((await store.listProjects()).length,0);
});
