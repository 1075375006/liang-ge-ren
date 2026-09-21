import 'dotenv/config';
import { pool, query } from '../server/db.js';

try {
  // One statement observes a single database snapshot while other users keep working.
  const result = await query<{
    user_id: string;
    wallet_balance: number | null;
    ledger_balance: string;
    matches: boolean;
  }>(`WITH totals AS (
      SELECT user_id,SUM(delta)::bigint AS ledger_balance
      FROM point_ledger GROUP BY user_id
    )
    SELECT COALESCE(wallet.user_id,totals.user_id) AS user_id,
      wallet.balance AS wallet_balance,
      COALESCE(totals.ledger_balance,0)::text AS ledger_balance,
      wallet.user_id IS NOT NULL AND wallet.balance::bigint=COALESCE(totals.ledger_balance,0) AS matches
    FROM wallets AS wallet FULL OUTER JOIN totals ON wallet.user_id=totals.user_id
    ORDER BY user_id`);
  const mismatches = result.rows.filter((row) => !row.matches);
  if (mismatches.length) {
    console.error(`对账失败：${mismatches.length} 个账户的余额与积分流水不一致。未修改任何数据。`);
    for (const mismatch of mismatches) console.error(JSON.stringify(mismatch));
    process.exitCode = 1;
  } else {
    console.info(`对账通过：${result.rows.length} 个账户的余额均与积分流水一致。`);
  }
} catch {
  console.error('积分对账无法完成，请检查数据库连接与数据表。未修改任何数据。');
  process.exitCode = 1;
} finally {
  await pool.end();
}
