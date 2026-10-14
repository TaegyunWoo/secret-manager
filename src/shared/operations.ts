import {AppError} from './errors.js';
import {decrypt} from './crypto.js';
import {Store,validId,validText,validName,validKind,validPolicy,validValue,invalid,MAX_IMPORT_BYTES} from './store.js';
import {backupColumns,MAX_BACKUP_BYTES,MAX_BACKUP_ROWS,type BackupRow} from './backup.js';
import type {ImportEntry} from './types.js';
import type {CiPolicy} from './auth.js';

type Table=keyof typeof backupColumns;
const tables=Object.keys(backupColumns) as Table[];
const byteLength=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
const conflict=()=>{throw new AppError(409,'conflict');};
const invalidBackup=()=>{throw new AppError(400,'invalid_backup');};
function timestamp(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)invalidBackup();}
function object(value:unknown):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))invalid();}
export interface Operation {
  id:string;actor:string;kind:'import'|'restore'|'export';environmentId:string|null;
  counts:Record<string,number>;createdAt:number;expiresAt:number;nextIndex:number;bytes:number;
  state:'preparing'|'ready'|'committed'|'cancelled';
}
interface StoredOperation extends Omit<Operation,'counts'>{counts:string}
export interface OperationInput {kind:unknown;environmentId?:unknown;counts?:unknown;createdAt?:unknown}
const operationColumns='id,actor,kind,environment_id AS environmentId,counts,created_at AS createdAt,expires_at AS expiresAt,next_index AS nextIndex,bytes,state';

export class Operations {
  constructor(private readonly store:Store,private readonly actor:string){validText(actor,256);}
  async get(id:string):Promise<Operation>{
    validId(id);const row=await this.store.one<StoredOperation>(`SELECT ${operationColumns} FROM staged_operations WHERE id=? AND actor=?`,id,this.actor);
    if(row.expiresAt<=Date.now())throw new AppError(409,'operation_expired');
    return {...row,counts:JSON.parse(row.counts) as Record<string,number>};
  }
  async begin(input:OperationInput):Promise<Operation>{
    if(input.kind==='export'){
      if(input.environmentId!==undefined||input.counts!==undefined||input.createdAt!==undefined)invalid();
      return this.snapshot();
    }
    if(input.kind!=='import'&&input.kind!=='restore')invalid();
    object(input.counts);const expected=input.kind==='import'?['imports']:tables;
    if(Object.keys(input.counts).sort().join(',')!==[...expected].sort().join(','))invalid();
    const counts:Record<string,number>={};
    for(const table of expected){const count=input.counts[table];if(!Number.isInteger(count)||(count as number)<0||(count as number)>(input.kind==='import'?100:MAX_BACKUP_ROWS))invalid();counts[table]=count as number;}
    let createdAt=Date.now(),bytes=2;
    if(input.kind==='import'){validId(input.environmentId);if(counts.imports!<1||input.createdAt!==undefined)invalid();}
    else {if(input.environmentId!==undefined)invalid();timestamp(input.createdAt);createdAt=input.createdAt;bytes=byteLength({schemaVersion:1,createdAt,tables:Object.fromEntries(tables.map(table=>[table,[]]))});}
    const now=Date.now(),id=crypto.randomUUID();
    await this.store.batch([this.store.statement(`INSERT INTO staged_operations(id,actor,kind,environment_id,counts,created_at,expires_at,bytes,state) VALUES(?,?,?,?,?,?,?,?,CASE WHEN (SELECT count(*) FROM staged_operations WHERE expires_at>? AND state IN ('preparing','ready'))<8 THEN 'preparing' ELSE NULL END)`,id,this.actor,input.kind,input.environmentId??null,JSON.stringify(counts),createdAt,now+600000,bytes,now)]);
    return this.get(id);
  }
  private async uploaded(id:string):Promise<Record<string,number>>{
    const rows=await this.store.rows<{tableName:string;count:number}>('SELECT table_name AS tableName,sum(json_array_length(payload)) AS count FROM staged_chunks WHERE operation_id=? GROUP BY table_name',id);
    return Object.fromEntries(rows.map(row=>[row.tableName,row.count]));
  }
  async upload(id:string,index:number,table:string,rows:unknown):Promise<{ok:true}>{
    const operation=await this.get(id);
    if(operation.kind==='export'||operation.state!=='preparing'||!Number.isInteger(index)||index<0)invalid();
    if(index!==operation.nextIndex)conflict();
    const order=operation.kind==='import'?['imports']:tables;
    const uploaded=await this.uploaded(id);
    if(table!==order.find(name=>(uploaded[name]??0)<operation.counts[name]!))conflict();
    if(!Array.isArray(rows)||!rows.length||rows.length>(table==='imports'||table==='secret_versions'?10:100))invalid();
    const inputBytes=byteLength(rows);
    if(inputBytes>(table==='imports'?MAX_IMPORT_BYTES:90000))throw new AppError(413,'chunk_required');
    const delta=inputBytes-2+((uploaded[table]??0)>0?1:0),limit=operation.kind==='import'?MAX_IMPORT_BYTES:MAX_BACKUP_BYTES;
    if(operation.bytes+delta>limit)throw new AppError(413,'payload_too_large');
    if((uploaded[table]??0)+rows.length>operation.counts[table]!)conflict();
    let payload:string;
    if(table==='imports'){
      let valueBytes=0;
      const entries=rows.map(row=>{object(row);if(Object.keys(row).some(key=>!['name','value','expectedVersionId'].includes(key)))invalid();validName(row.name);validValue(row.value);valueBytes+=new TextEncoder().encode(row.value).length;return row as unknown as ImportEntry;});
      if(valueBytes>65536)throw new AppError(413,'chunk_required');
      const names=await this.store.rows<{name:string}>(`SELECT j.value->>'name' AS name FROM staged_chunks c,json_each(c.payload) j WHERE c.operation_id=?`,id);
      if(entries.some(entry=>names.some(row=>row.name===entry.name)))conflict();
      payload=JSON.stringify(await this.store.prepareImportEntries(operation.environmentId!,entries));
    }else{
      for(const row of rows)await this.validateRow(id,table as Table,row);
      payload=JSON.stringify(rows);
    }
    const result=await this.store.batch([
      this.store.statement(`UPDATE staged_operations SET next_index=CASE WHEN state='preparing' AND expires_at>? AND next_index=? AND bytes+?<=? AND coalesce((SELECT sum(json_array_length(payload)) FROM staged_chunks WHERE operation_id=? AND table_name=?),0)+?<=json_extract(counts,?) THEN next_index+1 ELSE NULL END,bytes=bytes+? WHERE id=? AND actor=?`,Date.now(),index,delta,limit,id,table,rows.length,'$.'+table,delta,id,this.actor),
      this.store.statement('INSERT INTO staged_chunks(operation_id,table_name,chunk_index,payload,bytes) VALUES(?,?,?,?,?)',id,table,index,payload,new TextEncoder().encode(payload).length)
    ]);
    if(!result[0]!.meta.changes)conflict();return {ok:true};
  }
  private async validateRow(id:string,table:Table,value:unknown):Promise<void>{
    try {
      object(value);if(Object.keys(value).sort().join(',')!==[...backupColumns[table]].sort().join(','))invalidBackup();
      const row=value as BackupRow;validId(row.id);
      if(table==='projects'){validText(row.name);validText(row.slug);if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug as string))invalidBackup();}
      if(table==='environments'){validId(row.project_id);validText(row.name);}
      if(table==='secrets'){validId(row.environment_id);validId(row.current_version_id);validName(row.name);validKind(row.kind);timestamp(row.created_at);timestamp(row.updated_at);if(row.deleted_at!==null)timestamp(row.deleted_at);if(row.updated_at<row.created_at)invalidBackup();}
      if(table==='secret_versions'){
        validId(row.secret_id);validText(row.key_id);timestamp(row.created_at);
        if(typeof row.ciphertext!=='string'||row.ciphertext.length>87404||typeof row.nonce!=='string')invalidBackup();
        const context=await this.store.one<{environmentId:string;projectId:string;updatedAt:number}>(`SELECT s.value->>'environment_id' AS environmentId,e.value->>'project_id' AS projectId,s.value->>'updated_at' AS updatedAt FROM staged_chunks sc,json_each(sc.payload) s,staged_chunks ec,json_each(ec.payload) e WHERE sc.operation_id=? AND ec.operation_id=? AND sc.table_name='secrets' AND ec.table_name='environments' AND s.value->>'id'=? AND e.value->>'id'=s.value->>'environment_id'`,id,id,row.secret_id);
        if(row.created_at>context.updatedAt)invalidBackup();
        validValue(await decrypt({ciphertext:row.ciphertext as string,nonce:row.nonce as string,keyId:row.key_id as string},{projectId:context.projectId,environmentId:context.environmentId,secretId:row.secret_id as string,versionId:row.id as string},this.store.keyring));
      }
      if(table==='ci_policies'){
        if(typeof row.events!=='string'||(row.active!==0&&row.active!==1))invalidBackup();
        validPolicy({id:row.id,environmentId:row.environment_id,repositoryId:row.repository_id,repositoryOwnerId:row.repository_owner_id,branch:row.branch,workflow:row.workflow,events:JSON.parse(row.events as string),githubEnvironment:row.github_environment,active:row.active===1} as CiPolicy);
      }
      if(table==='audit_events'){validText(row.actor,256);validText(row.action,64);timestamp(row.created_at);if(row.target_id!==null)validId(row.target_id);if(!['success','denied','error'].includes(row.result as string))invalidBackup();}
    }catch{invalidBackup();}
  }
  async commit(id:string):Promise<{ok:true}>{
    const operation=await this.get(id);if(operation.state==='committed')return {ok:true};
    if(operation.kind==='export'||operation.state!=='preparing')invalid();
    const uploaded=await this.uploaded(id);if(Object.entries(operation.counts).some(([table,count])=>(uploaded[table]??0)!==count))conflict();
    const guard=this.store.statement(`UPDATE staged_operations SET state=CASE WHEN state='preparing' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM json_each(counts) n WHERE n.value!=coalesce((SELECT sum(json_array_length(payload)) FROM staged_chunks c WHERE c.operation_id=staged_operations.id AND c.table_name=n.key),0)) THEN 'committed' ELSE NULL END WHERE id=? AND actor=?`,Date.now(),id,this.actor);
    let statements:D1PreparedStatement[];
    if(operation.kind==='import'){
      const source="(SELECT j.value FROM staged_chunks c,json_each(c.payload) j WHERE c.operation_id=? AND c.table_name='imports')";
      statements=this.store.importWriteStatements(source,[id]);
    }else{
      await this.validateReferences(id);
      const occupied=tables.filter(table=>table!=='audit_events').map(table=>`EXISTS(SELECT 1 FROM ${table})`).join(' OR '),sentinel=crypto.randomUUID();
      statements=[this.store.statement(`INSERT INTO projects(id,name,slug) VALUES(CASE WHEN ${occupied} THEN NULL ELSE ? END,?,?)`,sentinel,sentinel,sentinel)];
      for(const table of tables){const columns=backupColumns[table];const select=columns.map(column=>table==='ci_policies'&&column==='active'?'0':`j.value->>'${column}'`).join(',');statements.push(this.store.statement(`${table==='audit_events'?'INSERT OR IGNORE':'INSERT'} INTO ${table}(${columns.join(',')}) SELECT ${select} FROM staged_chunks c,json_each(c.payload) j WHERE c.operation_id=? AND c.table_name=?`,id,table));}
      statements.push(this.store.statement('DELETE FROM projects WHERE id=?',sentinel));
    }
    const result=await this.store.batch([guard,...statements,this.store.statement('DELETE FROM staged_chunks WHERE operation_id=?',id)]);
    if(!result[0]!.meta.changes)conflict();return {ok:true};
  }
  private async validateReferences(id:string):Promise<void>{
    const ctes=tables.map(table=>`${table} AS (SELECT j.value FROM staged_chunks c,json_each(c.payload) j WHERE c.operation_id=? AND c.table_name='${table}')`).join(',');
    const duplicates=tables.map(table=>`EXISTS(SELECT 1 FROM ${table} GROUP BY value->>'id' HAVING count(*)>1)`);
    const invalidity=[...duplicates,
      "EXISTS(SELECT 1 FROM projects GROUP BY value->>'slug' HAVING count(*)>1)",
      "EXISTS(SELECT 1 FROM environments e WHERE NOT EXISTS(SELECT 1 FROM projects p WHERE p.value->>'id'=e.value->>'project_id'))",
      "EXISTS(SELECT 1 FROM environments GROUP BY value->>'project_id',value->>'name' HAVING count(*)>1)",
      "EXISTS(SELECT 1 FROM secrets s WHERE NOT EXISTS(SELECT 1 FROM environments e WHERE e.value->>'id'=s.value->>'environment_id') OR NOT EXISTS(SELECT 1 FROM secret_versions v WHERE v.value->>'id'=s.value->>'current_version_id' AND v.value->>'secret_id'=s.value->>'id'))",
      "EXISTS(SELECT 1 FROM secrets GROUP BY value->>'environment_id',value->>'name' HAVING count(*)>1)",
      "EXISTS(SELECT 1 FROM secret_versions v WHERE NOT EXISTS(SELECT 1 FROM secrets s WHERE s.value->>'id'=v.value->>'secret_id' AND s.value->>'updated_at'>=v.value->>'created_at'))",
      "EXISTS(SELECT 1 FROM secret_versions GROUP BY value->>'secret_id' HAVING count(*)>10)",
      "EXISTS(SELECT 1 FROM ci_policies c WHERE NOT EXISTS(SELECT 1 FROM environments e WHERE e.value->>'id'=c.value->>'environment_id'))"];
    const result=await this.store.one<{invalid:number}>(`WITH ${ctes} SELECT (${invalidity.join(' OR ')}) AS invalid`,...tables.map(()=>id));
    if(result.invalid)invalidBackup();
  }
  private async snapshot():Promise<Operation>{
    const id=crypto.randomUUID(),now=Date.now(),counts=Object.fromEntries(tables.map(table=>[table,0]));
    const emptyBytes=byteLength({schemaVersion:1,createdAt:now,tables:Object.fromEntries(tables.map(table=>[table,[]]))});
    const estimates=await this.store.batch(tables.map(table=>{
      const encoded=`json_object(${backupColumns[table].flatMap(column=>[`'${column}'`,column]).join(',')})`;
      return this.store.statement(`SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM (SELECT ${encoded} AS payload FROM ${table} LIMIT ?)`,MAX_BACKUP_ROWS+1);
    }));
    let totalBytes=emptyBytes;
    for(const result of estimates){const stats=result.results[0] as {count:number;bytes:number};if(stats.count>MAX_BACKUP_ROWS)throw new AppError(413,'backup_too_large');totalBytes+=stats.bytes+Math.max(0,stats.count-1);}
    if(totalBytes>MAX_BACKUP_BYTES)throw new AppError(413,'backup_too_large');
    const statements=[this.store.statement(`INSERT INTO staged_operations(id,actor,kind,counts,created_at,expires_at,bytes,state) VALUES(?,?,'export',?,?,?,?,CASE WHEN (SELECT count(*) FROM staged_operations WHERE expires_at>? AND state IN ('preparing','ready'))<8 THEN 'preparing' ELSE NULL END)`,id,this.actor,JSON.stringify(counts),now,now+600000,emptyBytes,now)];
    for(const table of tables){const encoded=`json_array(json_object(${backupColumns[table].flatMap(column=>[`'${column}'`,column]).join(',')}))`;statements.push(this.store.statement(`INSERT INTO staged_chunks(operation_id,table_name,chunk_index,payload,bytes) SELECT ?,?,row_number() OVER(ORDER BY id)-1,${encoded},length(CAST(${encoded} AS BLOB)) FROM ${table} LIMIT ?`,id,table,MAX_BACKUP_ROWS+1));}
    const countSql=tables.map(table=>`'${table}',(SELECT count(*) FROM staged_chunks WHERE operation_id=? AND table_name='${table}')`).join(',');
    const bytesSql=`?+coalesce((SELECT sum(bytes-2) FROM staged_chunks WHERE operation_id=?),0)+coalesce((SELECT sum(n-1) FROM (SELECT count(*) n FROM staged_chunks WHERE operation_id=? GROUP BY table_name)),0)`;
    statements.push(this.store.statement(`UPDATE staged_operations SET counts=json_object(${countSql}),bytes=${bytesSql} WHERE id=?`,...tables.map(()=>id),emptyBytes,id,id,id));
    statements.push(this.store.statement(`UPDATE staged_operations SET state=CASE WHEN bytes<=? AND NOT EXISTS(SELECT 1 FROM json_each(counts) WHERE value>?) THEN 'ready' ELSE NULL END WHERE id=?`,MAX_BACKUP_BYTES,MAX_BACKUP_ROWS,id));
    try {await this.store.batch(statements);}catch(error){if(error instanceof AppError&&error.code==='conflict')throw new AppError(413,'backup_too_large');throw error;}
    return this.get(id);
  }
  async page(id:string,table:string,index:number):Promise<{rows:BackupRow[];nextIndex:number|null}>{
    const operation=await this.get(id);
    if(operation.kind!=='export'||operation.state!=='ready'||!tables.includes(table as Table)||!Number.isInteger(index)||index<0||index>operation.counts[table]!)invalid();
    const limit=table==='secret_versions'?10:100;
    const chunks=await this.store.rows<{payload:string;chunkIndex:number}>(`SELECT payload,chunk_index AS chunkIndex FROM (SELECT payload,chunk_index,sum(bytes-1) OVER(ORDER BY chunk_index) AS total FROM staged_chunks WHERE operation_id=? AND table_name=? AND chunk_index>=? ORDER BY chunk_index LIMIT ?) WHERE total<=90000 OR chunk_index=? ORDER BY chunk_index`,id,table,index,limit,index);
    const next=chunks.length?chunks[chunks.length-1]!.chunkIndex+1:operation.counts[table]!;
    return {rows:chunks.flatMap(chunk=>JSON.parse(chunk.payload) as BackupRow[]),nextIndex:next<operation.counts[table]!?next:null};
  }
  async cancel(id:string):Promise<{ok:true}>{
    await this.get(id);
    await this.store.batch([this.store.statement("UPDATE staged_operations SET state=CASE WHEN state='committed' THEN state ELSE 'cancelled' END WHERE id=? AND actor=?",id,this.actor),this.store.statement('DELETE FROM staged_chunks WHERE operation_id=?',id)]);
    return {ok:true};
  }
}
