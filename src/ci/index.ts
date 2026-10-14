import type { JWTVerifyGetKey } from 'jose';
import { verifyGitHub, authorizeGitHub, type GitHubConfig } from '../shared/auth.js';
import { AppError } from '../shared/errors.js';
import { assertSameOrigin, readJson, jsonResponse, errorResponse } from '../shared/http.js';
import { Store } from '../shared/store.js';
import { configuredStore, resolveInput, auditFailure, type StorageEnv } from '../shared/worker.js';
export interface CiEnv extends StorageEnv, GitHubConfig {}

export function createCiHandler(jwks?: JWTVerifyGetKey) {
  return {
    async fetch(request: Request, env: CiEnv): Promise<Response> {
      const auditStore=new Store(env.DB,{},'');
      let actor='anonymous',targetId:string|null=null,action='ci.unknown';
      try {
        const claims=await verifyGitHub(request,env,jwks);
        actor=typeof claims.repository_id==='string' && claims.repository_id.length<=32 ? `github:${claims.repository_id}` : 'github:unmatched';
        if(new URL(request.url).pathname!=='/v1/resolve'||request.method!=='POST')throw new AppError(404,'not_found');
        action='ci.resolve';
        assertSameOrigin(request);
        const input=resolveInput(await readJson(request));
        const store=configuredStore(env);
        let environment;
        try {environment=await store.getEnvironment(input.project,input.environment);}
        catch(error){if(error instanceof AppError && error.status===404)throw new AppError(403,'forbidden');throw error;}
        targetId=environment.id;
        authorizeGitHub(claims,await store.listPolicies(environment.id,true));
        const result=await store.resolveEnvironment(environment.id,input.names);
        await auditStore.audit({actor,action,targetId,result:'success'});
        return jsonResponse(result);
      } catch(error){await auditFailure(auditStore,actor,action,targetId,error);return errorResponse(error);}
    },
  };
}
export default createCiHandler();
