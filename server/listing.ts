import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { QueryResultRow } from 'pg';
import { z, ZodError } from 'zod';
import { query } from './db.js';
import { digest } from './security.js';

type Dependencies = {
  spaceContext: (
    request: FastifyRequest,
    requirePair?: boolean,
  ) => Promise<{
    user: { id: string };
    space: QueryResultRow;
    partner: QueryResultRow | null;
  }>;
  loggedIn: (request: FastifyRequest) => { id: string };
  camel: (value: unknown) => unknown;
};
const pageFields = {
  limit: z.coerce.number().int().min(1, '每页至少一条').max(200, '每页最多 200 条').default(60),
  cursor: z.string().min(1).max(1024).optional(),
};
const pageSchema = z.object(pageFields);
const cursorSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime({ offset: true }).max(40),
    id: z.string().uuid(),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type PageInput = z.infer<typeof pageSchema>;
const recordId = (request: FastifyRequest) =>
  z.object({ id: z.string().uuid('无效的记录编号') }).parse(request.params).id;

function invalidCursor(): never {
  throw new ZodError([
    { code: 'custom', path: ['cursor'], message: '分页位置无效，请从列表开头重试' },
  ]);
}
function decodeCursor(value: string, scope: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return invalidCursor();
    const cursor = cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    if (cursor.scope !== scope) return invalidCursor();
    return cursor;
  } catch {
    return invalidCursor();
  }
}
function encodeCursor(row: QueryResultRow, scope: string): string {
  // PostgreSQL's text value preserves microseconds; pg's Date conversion does not.
  const createdAt = String(row.cursor_created_at)
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  return Buffer.from(JSON.stringify({ version: 1, createdAt, id: row.id, scope })).toString(
    'base64url',
  );
}

async function page(
  table: string,
  fields: string,
  where: string,
  values: unknown[],
  input: PageInput,
  context: unknown[],
) {
  const scope = digest(JSON.stringify([table, ...context]));
  const params = [...values];
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, scope);
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (created_at,id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`;
  }
  params.push(input.limit + 1);
  const { rows } = await query(
    `SELECT ${fields},created_at::text AS cursor_created_at FROM ${table}
     WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
    params,
  );
  const selected = rows.slice(0, input.limit);
  const nextCursor =
    rows.length > input.limit ? encodeCursor(selected[selected.length - 1], scope) : null;
  const items = selected.map(({ cursor_created_at: _hidden, ...item }) => item);
  return { items, nextCursor };
}

/** All values are parameterized; table and field names are fixed by these route definitions. */
export function registerListRoutes(
  app: FastifyInstance,
  { spaceContext, loggedIn, camel }: Dependencies,
): void {
  app.get('/api/tasks', async (request) => {
    const { user, space } = await spaceContext(request, false);
    const input = z
      .object({
        ...pageFields,
        view: z.enum(['current', 'history', 'mine', 'review', 'all']).default('all'),
        q: z.string().trim().max(100, '搜索内容最多 100 字').default(''),
      })
      .parse(request.query);
    const values: unknown[] = [space.id];
    let where = 'space_id=$1';
    if (input.view === 'current') where += " AND status IN ('OPEN','CLAIMED','SUBMITTED')";
    if (input.view === 'history') where += " AND status IN ('APPROVED','CANCELLED','EXPIRED')";
    if (input.view === 'mine') {
      values.push(user.id);
      where += ` AND status IN ('OPEN','CLAIMED','SUBMITTED') AND (claimant_id=$${values.length} OR assigned_to=$${values.length})`;
    }
    if (input.view === 'review') {
      values.push(user.id);
      where += ` AND status='SUBMITTED' AND claimant_id<>$${values.length}`;
    }
    if (input.q) {
      values.push(`%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
      where += ` AND (title ILIKE $${values.length} OR description ILIKE $${values.length})`;
    }
    const [tasks, schedules] = await Promise.all([
      page('tasks', '*', where, values, input, [space.id, user.id, input.view, input.q]),
      page('schedules', '*', 'space_id=$1', [space.id], { limit: input.limit }, [
        space.id,
        user.id,
      ]),
    ]);
    return {
      tasks: camel(tasks.items),
      schedules: camel(schedules.items),
      nextCursor: tasks.nextCursor,
      schedulesNextCursor: schedules.nextCursor,
    };
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { space } = await spaceContext(request, false);
    const {
      rows: [task],
    } = await query('SELECT * FROM tasks WHERE id=$1 AND space_id=$2', [
      recordId(request),
      space.id,
    ]);
    if (!task) return reply.code(404).send({ error: '约定不存在或已无法访问' });
    return { task: camel(task) };
  });

  app.get('/api/schedules', async (request) => {
    const { user, space } = await spaceContext(request, false);
    const result = await page(
      'schedules',
      '*',
      'space_id=$1',
      [space.id],
      pageSchema.parse(request.query),
      [space.id, user.id],
    );
    return { schedules: camel(result.items), nextCursor: result.nextCursor };
  });

  app.get('/api/products', async (request) => {
    const { user, space } = await spaceContext(request, false);
    const result = await page(
      'products',
      '*',
      'space_id=$1 AND (active OR creator_id=$2)',
      [space.id, user.id],
      pageSchema.parse(request.query),
      [space.id, user.id],
    );
    return { products: camel(result.items), nextCursor: result.nextCursor };
  });

  app.get('/api/orders', async (request) => {
    const { user, space } = await spaceContext(request, false);
    const input = z
      .object({ ...pageFields, view: z.enum(['all', 'actionable']).default('all') })
      .parse(request.query);
    const values: unknown[] = [space.id];
    let where = 'space_id=$1';
    if (input.view === 'actionable') {
      values.push(user.id);
      where += " AND ((status='PENDING' AND seller_id=$2) OR (status='FULFILLED' AND buyer_id=$2))";
    }
    const result = await page('orders', '*', where, values, input, [space.id, user.id, input.view]);
    return { orders: camel(result.items), nextCursor: result.nextCursor };
  });

  app.get('/api/orders/:id', async (request, reply) => {
    const { space } = await spaceContext(request, false);
    const {
      rows: [order],
    } = await query('SELECT * FROM orders WHERE id=$1 AND space_id=$2', [
      recordId(request),
      space.id,
    ]);
    if (!order) return reply.code(404).send({ error: '兑换记录不存在或已无法访问' });
    return { order: camel(order) };
  });

  app.get('/api/ledger', async (request) => {
    const { user, space } = await spaceContext(request, false);
    const [wallet, result] = await Promise.all([
      query('SELECT balance FROM wallets WHERE user_id=$1', [user.id]),
      page(
        'point_ledger',
        'id,delta,balance_after,reason,created_at',
        'user_id=$1 AND space_id=$2',
        [user.id, space.id],
        pageSchema.parse(request.query),
        [space.id, user.id],
      ),
    ]);
    return {
      balance: wallet.rows[0]?.balance ?? 0,
      entries: camel(result.items),
      nextCursor: result.nextCursor,
    };
  });

  app.get('/api/notifications', async (request) => {
    const user = loggedIn(request);
    const [unread, result] = await Promise.all([
      query(
        'SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL',
        [user.id],
      ),
      page(
        'notifications',
        'id,title,body,read_at,created_at',
        'user_id=$1',
        [user.id],
        pageSchema.parse(request.query),
        [user.id],
      ),
    ]);
    return {
      notifications: camel(result.items),
      unreadCount: unread.rows[0].count,
      nextCursor: result.nextCursor,
    };
  });
}
