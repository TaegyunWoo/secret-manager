import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
export async function database() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-01', d1Databases: ['DB'], cf: false }));
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  try {
    for (const migration of ['0001_initial.sql','0002_staged_operations.sql']) {
      const sql = await readFile(new URL('../../migrations/'+migration, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
    }
    return { db, dispose: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
