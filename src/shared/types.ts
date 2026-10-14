export interface Project { id: string; name: string; slug: string }
export interface Environment { id: string; projectId: string; name: string }
export type SecretKind = 'env' | 'file';
export interface Secret { id: string; environmentId: string; name: string; kind: SecretKind; currentVersionId: string; deletedAt: number | null; createdAt: number; updatedAt: number }
export interface Version { id: string; secretId: string; keyId: string; createdAt: number }
export interface ResolvedSecret { name: string; kind: SecretKind; value: string }
export interface AuditEvent { id: string; actor: string; action: string; targetId: string | null; result: 'success' | 'denied' | 'error'; createdAt: number }
export interface SecretInput { environmentId: string; name: string; kind: SecretKind; value: string }
export interface SecretUpdate { expectedVersionId: string; name?: string; kind?: SecretKind; value?: string }
export interface ImportEntry { name: string; value: string; expectedVersionId?: string }
