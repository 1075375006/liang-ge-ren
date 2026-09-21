import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { digest } from './security.js';

export const creationRequestKey = z
  .string()
  .trim()
  .min(8, '请求编号至少 8 位')
  .max(128, '请求编号最多 128 位')
  .optional();
type Kind = 'task' | 'schedule' | 'product';
const tables: Record<Kind, string> = { task: 'tasks', schedule: 'schedules', product: 'products' };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Must run inside the same space transaction as both creation and its notification. */
export async function createRecordOnce<T extends QueryResultRow>(
  client: PoolClient,
  context: { userId: string; spaceId: string; kind: Kind; requestKey?: string; payload: unknown },
  create: () => Promise<T>,
  fail: (statusCode: number, message: string) => never,
): Promise<T> {
  if (!context.requestKey) return create();
  const { userId, spaceId, kind, requestKey } = context;
  const payloadHash = digest(JSON.stringify(canonical(context.payload)));
  const identity = JSON.stringify(['creation', userId, spaceId, kind, requestKey]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [identity]);
  const {
    rows: [existing],
  } = await client.query<{ record_id: string; payload_hash: string }>(
    'SELECT record_id,payload_hash FROM creation_requests WHERE user_id=$1 AND space_id=$2 AND kind=$3 AND request_key=$4',
    [userId, spaceId, kind, requestKey],
  );
  if (existing) {
    if (existing.payload_hash !== payloadHash)
      return fail(409, '这次提交已保存过其他内容，请关闭表单后重新创建');
    const {
      rows: [record],
    } = await client.query<T>(
      `SELECT * FROM ${tables[kind]} WHERE id=$1 AND space_id=$2 AND creator_id=$3`,
      [existing.record_id, spaceId, userId],
    );
    if (!record) return fail(409, '原记录已无法访问，请关闭表单后重新创建');
    return record;
  }
  const record = await create();
  await client.query(
    'INSERT INTO creation_requests(user_id,space_id,kind,request_key,payload_hash,record_id) VALUES($1,$2,$3,$4,$5,$6)',
    [userId, spaceId, kind, requestKey, payloadHash, record.id],
  );
  return record;
}
