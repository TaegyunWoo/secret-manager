CREATE TABLE staged_operations (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
 kind TEXT NOT NULL CHECK(kind IN ('import','restore','export')),
 environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
 counts TEXT NOT NULL CHECK(json_valid(counts)),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>=0),
 next_index INTEGER NOT NULL DEFAULT 0 CHECK(next_index>=0),
 bytes INTEGER NOT NULL CHECK(bytes>=0),
 state TEXT NOT NULL CHECK(state IN ('preparing','ready','committed','cancelled'))
);
CREATE INDEX staged_operations_expiry ON staged_operations(expires_at);
CREATE TABLE staged_chunks (
 operation_id TEXT NOT NULL REFERENCES staged_operations(id) ON DELETE CASCADE,
 table_name TEXT NOT NULL,
 chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='array'),
 bytes INTEGER NOT NULL CHECK(bytes>=0),
 PRIMARY KEY(operation_id,table_name,chunk_index)
);
