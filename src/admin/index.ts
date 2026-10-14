import { verifyAccess, type AccessConfig, type CiPolicy } from '../shared/auth.js';
import type { JWTVerifyGetKey } from 'jose';
import { exportBackup, restoreBackup } from '../shared/backup.js';
import { previewImport, applyImport } from '../shared/imports.js';
import { assertSameOrigin, readJson, jsonResponse, errorResponse, securityHeaders } from '../shared/http.js';
import { AppError } from '../shared/errors.js';
import { Store, validId, invalid } from '../shared/store.js';
import { configuredStore, objectInput, resolveInput, auditFailure, type StorageEnv } from '../shared/worker.js';
import type { SecretInput, SecretUpdate, ImportEntry } from '../shared/types.js';

export interface AdminEnv extends StorageEnv, AccessConfig { ASSETS: Pick<Fetcher, 'fetch'> }
interface Route {
  method: string; pattern: RegExp; action: string; fields?: string[];
  run(store: Store, match: RegExpMatchArray, body: unknown, url: URL): Promise<unknown>;
  status?: number;
}
function body<T>(value: unknown): T { return value as T; }
const expected = (value: unknown) => body<{expectedVersionId:string}>(value).expectedVersionId;
const filter = (url: URL, name: string) => url.searchParams.get(name) ?? undefined;
const policyFields = ['environmentId','repositoryId','repositoryOwnerId','branch','workflow','events','githubEnvironment','active'];
const routes: Route[] = [
  {method:'GET',pattern:/^\/api\/projects$/,action:'projects.list',run:async s=>({projects:await s.listProjects()})},
  {method:'POST',pattern:/^\/api\/projects$/,action:'projects.create',fields:['name','slug'],status:201,run:async(s,_m,b)=>s.createProject(body(b))},
  {method:'PATCH',pattern:/^\/api\/projects\/([^/]+)$/,action:'projects.update',fields:['name','slug'],run:async(s,m,b)=>s.updateProject(m[1]!,body(b))},
  {method:'DELETE',pattern:/^\/api\/projects\/([^/]+)$/,action:'projects.delete',fields:[],run:async(s,m)=>{await s.deleteProject(m[1]!);return {ok:true};}},
  {method:'GET',pattern:/^\/api\/environments$/,action:'environments.list',run:async(s,_m,_b,u)=>({environments:await s.listEnvironments(filter(u,'projectId'))})},
  {method:'POST',pattern:/^\/api\/environments$/,action:'environments.create',fields:['projectId','name'],status:201,run:async(s,_m,b)=>s.createEnvironment(body(b))},
  {method:'PATCH',pattern:/^\/api\/environments\/([^/]+)$/,action:'environments.update',fields:['name'],run:async(s,m,b)=>s.updateEnvironment(m[1]!,body(b))},
  {method:'DELETE',pattern:/^\/api\/environments\/([^/]+)$/,action:'environments.delete',fields:[],run:async(s,m)=>{await s.deleteEnvironment(m[1]!);return {ok:true};}},
  {method:'GET',pattern:/^\/api\/secrets$/,action:'secrets.list',run:async(s,_m,_b,u)=>({secrets:await s.listSecrets(filter(u,'environmentId')!)})},
  {method:'POST',pattern:/^\/api\/secrets$/,action:'secrets.create',fields:['environmentId','name','kind','value'],status:201,run:async(s,_m,b)=>s.createSecret(body<SecretInput>(b))},
  {method:'PATCH',pattern:/^\/api\/secrets\/([^/]+)$/,action:'secrets.update',fields:['expectedVersionId','name','kind','value'],run:async(s,m,b)=>s.updateSecret(m[1]!,body<SecretUpdate>(b))},
  {method:'DELETE',pattern:/^\/api\/secrets\/([^/]+)$/,action:'secrets.delete',fields:['expectedVersionId'],run:async(s,m,b)=>{await s.deleteSecret(m[1]!,expected(b));return {ok:true};}},
  {method:'POST',pattern:/^\/api\/secrets\/([^/]+)\/reveal$/,action:'secrets.reveal',fields:[],run:async(s,m)=>s.reveal(m[1]!)},
  {method:'GET',pattern:/^\/api\/secrets\/([^/]+)\/versions$/,action:'versions.list',run:async(s,m)=>({versions:await s.listVersions(m[1]!)})},
  {method:'POST',pattern:/^\/api\/secrets\/([^/]+)\/versions\/([^/]+)\/restore$/,action:'versions.restore',fields:['expectedVersionId'],run:async(s,m,b)=>s.restoreVersion(m[1]!,m[2]!,expected(b))},
  {method:'GET',pattern:/^\/api\/trash$/,action:'trash.list',run:async(s,_m,_b,u)=>({secrets:await s.listTrash(filter(u,'environmentId'))})},
  {method:'POST',pattern:/^\/api\/trash\/([^/]+)\/restore$/,action:'trash.restore',fields:['expectedVersionId'],run:async(s,m,b)=>s.restoreSecret(m[1]!,expected(b))},
  {method:'POST',pattern:/^\/api\/imports\/preview$/,action:'imports.preview',fields:['environmentId','source'],run:async(s,_m,b)=>{const input=body<{environmentId:string;source:string}>(b);validId(input.environmentId);return previewImport(s,input.environmentId,input.source);}},
  {method:'POST',pattern:/^\/api\/imports\/apply$/,action:'imports.apply',fields:['environmentId','entries'],run:async(s,_m,b)=>{
    const input=body<{environmentId:string;entries:unknown}>(b);
    if(!Array.isArray(input.entries)) invalid();
    const entries=input.entries.map(entry=>objectInput<ImportEntry>(entry,['name','value','expectedVersionId']));
    return {secrets:await applyImport(s,input.environmentId,entries)};
  }},
  {method:'POST',pattern:/^\/api\/resolve$/,action:'secrets.resolve',fields:['project','environment','names'],run:async(s,_m,b)=>{const input=resolveInput(b);return s.resolve(input.project,input.environment,input.names);}},
  {method:'GET',pattern:/^\/api\/ci-policies$/,action:'policies.list',run:async(s,_m,_b,u)=>({policies:await s.listPolicies(filter(u,'environmentId'))})},
  {method:'POST',pattern:/^\/api\/ci-policies$/,action:'policies.create',fields:policyFields,status:201,run:async(s,_m,b)=>s.savePolicy(body<Omit<CiPolicy,'id'>>(b))},
  {method:'PATCH',pattern:/^\/api\/ci-policies\/([^/]+)$/,action:'policies.update',fields:policyFields,run:async(s,m,b)=>{
    const old=(await s.listPolicies()).find(policy=>policy.id===m[1]);if(!old)throw new AppError(404,'not_found');
    return s.savePolicy({...old,...body<Partial<Omit<CiPolicy,'id'>>>(b),id:m[1]!});
  }},
  {method:'DELETE',pattern:/^\/api\/ci-policies\/([^/]+)$/,action:'policies.delete',fields:[],run:async(s,m)=>{await s.deletePolicy(m[1]!);return {ok:true};}},
  {method:'GET',pattern:/^\/api\/audit-events$/,action:'audit.list',run:async(s,_m,_b,u)=>({events:await s.listAudit(u.searchParams.has('limit')?Number(u.searchParams.get('limit')):100)})},
  {method:'GET',pattern:/^\/api\/backup$/,action:'backup.export',run:async s=>exportBackup(s)},
  {method:'POST',pattern:/^\/api\/backup\/restore$/,action:'backup.restore',run:async(s,_m,b)=>{await restoreBackup(s,b);return {ok:true};}},
];

export function createAdminHandler(jwks?: JWTVerifyGetKey) {
  return {
    async fetch(request: Request, env: AdminEnv): Promise<Response> {
      const auditStore = new Store(env.DB,{},'');
      let actor='anonymous', action='admin.unknown', targetId: string|null=null;
      try {
        actor=await verifyAccess(request,env,jwks);
        const url=new URL(request.url);
        const route=routes.find(route=>route.method===request.method && route.pattern.test(url.pathname));
        if(!route) {
          if(!url.pathname.startsWith('/api/') && url.pathname!=='/api' && ['GET','HEAD'].includes(request.method)) {
            const response=await env.ASSETS.fetch(request);
            const headers=new Headers(response.headers);for(const [name,value] of Object.entries(securityHeaders))headers.set(name,value);
            return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
          }
          throw new AppError(404,'not_found');
        }
        action=route.action;
        const match=url.pathname.match(route.pattern)!;
        for(const id of match.slice(1))validId(id);
        targetId=match[1]??null;
        let input:unknown;
        if(!['GET','HEAD'].includes(request.method)) {
          assertSameOrigin(request);input=await readJson(request);
          if(route.fields)input=objectInput(input,route.fields);
        }
        const result=await route.run(configuredStore(env),match,input,url);
        if(targetId===null && result && typeof result==='object' && 'id' in result){validId(result.id);targetId=result.id;}
        await auditStore.audit({actor,action,targetId,result:'success'});
        return jsonResponse(result,route.status);
      } catch(error) {await auditFailure(auditStore,actor,action,targetId,error);return errorResponse(error);}
    },
    async scheduled(_controller: ScheduledController, env: AdminEnv): Promise<void> {
      const store=new Store(env.DB,{},'');
      try {await store.cleanup(100);await store.audit({actor:'system',action:'cleanup',targetId:null,result:'success'});}
      catch(error){await auditFailure(store,'system','cleanup',null,error);throw new AppError(500,'cleanup_failed');}
    },
  };
}
export default createAdminHandler();
