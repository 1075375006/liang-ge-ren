import type pg from 'pg';

/** Refuse a non-test name, wait for backend exit, then drop without killing clients. */
export async function dropTestDatabase(admin: pg.Pool, name: string): Promise<void> {
  if (
    !/^couple_(test|wechat|privacy|multi|policy|account_test|creation_test|listing_test|maintenance_test|lifecycle_test|contract_test)_[a-f0-9]{32}$/.test(
      name,
    )
  )
    throw new Error('Refusing to drop a non-test database');
  const deadline = Date.now() + 5000;
  while (true) {
    const {
      rows: [state],
    } = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
      [name],
    );
    if (state.count === 0) break;
    if (Date.now() >= deadline)
      throw new Error(`Test database still has ${state.count} open connections: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await admin.query(`DROP DATABASE "${name}"`);
}
