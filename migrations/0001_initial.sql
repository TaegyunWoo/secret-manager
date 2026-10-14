PRAGMA foreign_keys = ON;
CREATE TABLE projects (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 128)
);
CREATE TABLE environments (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 UNIQUE(project_id,name)
);
CREATE TABLE secrets (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('env','file')),
 current_version_id TEXT NOT NULL,
 deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at>=0),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 UNIQUE(environment_id,name),
 FOREIGN KEY(id,current_version_id) REFERENCES secret_versions(secret_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE secret_versions (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
 ciphertext TEXT NOT NULL CHECK(length(ciphertext) BETWEEN 24 AND 87404),
 nonce TEXT NOT NULL CHECK(length(nonce)=16),
 key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 128),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 UNIQUE(secret_id,id)
);
CREATE INDEX secret_versions_history ON secret_versions(secret_id,created_at DESC,id DESC);
CREATE INDEX secrets_trash ON secrets(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TABLE ci_policies (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
 repository_id TEXT NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 32 AND repository_id NOT GLOB '*[^0-9]*' AND repository_id NOT GLOB '0*'),
 repository_owner_id TEXT NOT NULL CHECK(length(repository_owner_id) BETWEEN 1 AND 32 AND repository_owner_id NOT GLOB '*[^0-9]*' AND repository_owner_id NOT GLOB '0*'),
 branch TEXT NOT NULL CHECK(length(branch) BETWEEN 12 AND 256),
 workflow TEXT NOT NULL CHECK(length(workflow) BETWEEN 1 AND 256),
 events TEXT NOT NULL CHECK(json_valid(events) AND json_type(events)='array' AND json_array_length(events) BETWEEN 1 AND 2),
 github_environment TEXT CHECK(github_environment IS NULL OR length(github_environment) BETWEEN 1 AND 128),
 active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE INDEX ci_policies_environment ON ci_policies(environment_id,active);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
 action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 64),
 target_id TEXT CHECK(target_id IS NULL OR length(target_id)=36),
 result TEXT NOT NULL CHECK(result IN ('success','denied','error')),
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE INDEX audit_events_time ON audit_events(created_at DESC,id DESC);
