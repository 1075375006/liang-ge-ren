import 'dotenv/config';
import { closePool, query } from '../server/db.js';

try {
  const result = await query<{ healthy: boolean }>(`
    SELECT last_seen_at >= clock_timestamp() - interval '2 minutes'
      AND last_seen_at <= clock_timestamp() + interval '15 seconds' AS healthy
    FROM worker_heartbeat WHERE name='main'`);
  if (!result.rows[0]?.healthy) {
    console.error('后台工作进程没有最近两分钟内的有效心跳。');
    process.exitCode = 1;
  }
} catch {
  console.error('无法读取后台工作进程心跳，请检查数据库连接。');
  process.exitCode = 1;
} finally {
  await closePool();
}
