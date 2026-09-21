import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  emptyData,
  type Bootstrap,
  type Data,
  type MailStatus,
  type Notice,
  type Page,
  type Task,
  type Product,
  type Order,
  type Entry,
  type Schedule,
} from './types';

type Dataset = 'tasks' | 'products' | 'orders' | 'entries' | 'schedules' | 'notifications';
type Row = { id: string };
type WorkspaceData = Data & { unreadCount: number };
type Options = {
  page: Page;
  taskFilter: string;
  orderFilter?: 'all' | 'actionable';
  search: string;
  busy: boolean;
  pendingDestination?: unknown;
};
type View = Pick<Options, 'page' | 'taskFilter' | 'orderFilter' | 'search'>;
type ListSpec = { key: Dataset; path: string; limit: number; signature: string };
type Collection = {
  signature: string;
  items: Row[];
  nextCursor: string | null;
  pages: number;
  unreadCount?: number;
};
type Cache = Partial<Record<Dataset, Collection>>;
const freshData = (): WorkspaceData => ({ ...emptyData, unreadCount: 0 });
const viewKey = ({ page, taskFilter, orderFilter, search }: View) =>
  JSON.stringify([page, taskFilter, orderFilter, search]);
const businessReady = (state: Bootstrap) =>
  Boolean(
    state.user &&
    state.space &&
    state.partner &&
    !state.space.archivedAt &&
    (!state.requireVerifiedEmail || state.user.emailVerified),
  );
const identityOf = (state: Bootstrap) =>
  state.user
    ? JSON.stringify([
        state.user.id,
        state.space?.id ?? null,
        state.partner?.id ?? null,
        businessReady(state),
      ])
    : null;
function primaryDataset(page: Page): Dataset | null {
  switch (page) {
    case 'tasks':
    case 'history':
      return 'tasks';
    case 'shop':
      return 'products';
    case 'orders':
      return 'orders';
    case 'points':
      return 'entries';
    case 'schedules':
      return 'schedules';
    case 'notifications':
      return 'notifications';
    default:
      return null;
  }
}
function listSpecs(state: Bootstrap, view: View): ListSpec[] {
  if (!state.user) return [];
  const identity = identityOf(state);
  const spec = (key: Dataset, path: string, limit = 60): ListSpec => ({
    key,
    path,
    limit,
    signature: JSON.stringify([identity, key, path, limit]),
  });
  const lists = [spec('notifications', '/notifications', view.page === 'notifications' ? 60 : 6)];
  if (!businessReady(state)) return lists;
  const taskView =
    view.page === 'history'
      ? 'history'
      : view.page === 'tasks' && ['mine', 'review'].includes(view.taskFilter)
        ? view.taskFilter
        : 'current';
  const taskQuery = new URLSearchParams({ view: taskView });
  if (view.search.trim() && ['tasks', 'history'].includes(view.page))
    taskQuery.set('q', view.search.trim());
  lists.push(spec('tasks', `/tasks?${taskQuery}`));
  lists.push(
    spec(
      'orders',
      `/orders?view=${view.page === 'orders' ? (view.orderFilter ?? 'all') : 'actionable'}`,
    ),
  );
  if (view.page === 'shop') lists.push(spec('products', '/products'));
  if (view.page === 'points') lists.push(spec('entries', '/ledger'));
  if (view.page === 'schedules') lists.push(spec('schedules', '/schedules'));
  return lists;
}
const uniqueRows = (rows: Row[]) => [...new Map(rows.map((row) => [row.id, row])).values()];
async function fetchPages(
  spec: ListSpec,
  count: number,
  isCurrent: () => boolean,
  initialCursor?: string,
): Promise<Collection | null> {
  const items: Row[] = [];
  let cursor: string | null = initialCursor ?? null;
  let unreadCount: number | undefined;
  let pages = 0;
  do {
    if (!isCurrent()) return null;
    const url = `${spec.path}${spec.path.includes('?') ? '&' : '?'}limit=${spec.limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await api<Record<string, unknown>>(url);
    if (!isCurrent()) return null;
    if (!Array.isArray(response[spec.key])) throw new Error('列表暂时无法读取，请重试');
    items.push(...(response[spec.key] as Row[]));
    cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    if (typeof response.unreadCount === 'number') unreadCount = response.unreadCount;
    pages++;
  } while (cursor && pages < count);
  return {
    signature: spec.signature,
    items: uniqueRows(items),
    nextCursor: cursor,
    pages,
    unreadCount,
  };
}
function dataFrom(cache: Cache, mail: MailStatus): WorkspaceData {
  return {
    tasks: (cache.tasks?.items ?? []) as Task[],
    products: (cache.products?.items ?? []) as Product[],
    orders: (cache.orders?.items ?? []) as Order[],
    entries: (cache.entries?.items ?? []) as Entry[],
    schedules: (cache.schedules?.items ?? []) as Schedule[],
    notifications: (cache.notifications?.items ?? []) as Notice[],
    unreadCount: cache.notifications?.unreadCount ?? 0,
    mail,
  };
}

/** Loads only the current view's pages; polling refreshes the pages the user has opened. */
export function useWorkspaceData(options: Options) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [data, setData] = useState<WorkspaceData>(freshData);
  const [loadError, setLoadError] = useState('');
  const [loadedDataFor, setLoadedDataFor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const currentOptions = useRef(options);
  currentOptions.current = options;
  const bootstrapRef = useRef<Bootstrap | null>(null);
  const cacheRef = useRef<Cache>({});
  const identityRef = useRef<string | null>(null);
  const versionRef = useRef(0);
  const inFlightRef = useRef(false);
  const moreInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const version = ++versionRef.current;
    const view = { ...currentOptions.current };
    const requestedView = viewKey(view);
    const current = () =>
      mountedRef.current &&
      version === versionRef.current &&
      requestedView === viewKey(currentOptions.current);
    inFlightRef.current = true;
    moreInFlightRef.current = false;
    setLoadingMore(false);
    try {
      const state = await api<Bootstrap>('/bootstrap');
      if (!current()) return;
      const identity = identityOf(state);
      if (identityRef.current !== identity) {
        identityRef.current = identity;
        cacheRef.current = {};
        setData(freshData());
        setLoadedDataFor(null);
        setListLoading(Boolean(state.user));
      }
      bootstrapRef.current = state;
      setBootstrap(state);
      if (!state.user) {
        cacheRef.current = {};
        setData(freshData());
        setLoadedDataFor(null);
        setLoadError('');
        return;
      }
      const specs = listSpecs(state, view);
      const results = await Promise.all([
        Promise.all(
          specs.map((spec) => {
            const previous = cacheRef.current[spec.key];
            const desiredPages = previous?.signature === spec.signature ? previous.pages : 1;
            return fetchPages(spec, desiredPages, current);
          }),
        ),
        api<MailStatus>('/mail/status'),
      ]);
      if (!current()) return;
      const next: Cache = {};
      results[0].forEach((collection, index) => {
        if (collection) next[specs[index].key] = collection;
      });
      cacheRef.current = next;
      setData(dataFrom(next, results[1]));
      setLoadedDataFor(businessReady(state) ? `${state.user.id}:${state.space!.id}` : null);
      setLoadError('');
    } catch (error) {
      if (!current()) return;
      setLoadError(error instanceof Error ? error.message : '读取空间内容失败，请重试');
      throw error;
    } finally {
      if (version === versionRef.current && mountedRef.current) {
        inFlightRef.current = false;
        setListLoading(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (moreInFlightRef.current || inFlightRef.current || currentOptions.current.busy) return;
    const state = bootstrapRef.current;
    if (!state?.user) return;
    const key = primaryDataset(currentOptions.current.page);
    const spec = listSpecs(state, currentOptions.current).find((item) => item.key === key);
    const previous = spec ? cacheRef.current[spec.key] : undefined;
    if (!spec || !previous?.nextCursor || previous.signature !== spec.signature) return;
    const version = versionRef.current;
    const requestedView = viewKey(currentOptions.current);
    const identity = identityRef.current;
    const current = () =>
      mountedRef.current &&
      version === versionRef.current &&
      identity === identityRef.current &&
      requestedView === viewKey(currentOptions.current);
    moreInFlightRef.current = true;
    setLoadingMore(true);
    try {
      const result = await fetchPages(spec, 1, current, previous.nextCursor);
      if (!result || !current()) return;
      const merged: Collection = {
        ...result,
        items: uniqueRows([...previous.items, ...result.items]),
        pages: previous.pages + result.pages,
      };
      cacheRef.current = { ...cacheRef.current, [spec.key]: merged };
      setData((old) => ({
        ...old,
        [spec.key]: merged.items,
        ...(spec.key === 'notifications'
          ? { unreadCount: merged.unreadCount ?? old.unreadCount }
          : {}),
      }));
      setLoadError('');
    } catch (error) {
      if (current())
        setLoadError(error instanceof Error ? error.message : '更多内容暂时没有加载成功，请重试');
    } finally {
      if (version === versionRef.current && mountedRef.current) {
        moreInFlightRef.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  const activeView = viewKey(options);
  useEffect(() => {
    setListLoading(true);
    setLoadError('');
    // Filter/search changes invalidate old responses immediately. A short search debounce avoids a request on every key.
    ++versionRef.current;
    inFlightRef.current = false;
    moreInFlightRef.current = false;
    setLoadingMore(false);
    const timer = window.setTimeout(
      () => {
        void refresh().catch(() => {});
      },
      options.search.trim() && ['tasks', 'history'].includes(options.page) ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [activeView, refresh]);

  useEffect(() => {
    mountedRef.current = true;
    function update() {
      if (
        !document.hidden &&
        !currentOptions.current.busy &&
        !inFlightRef.current &&
        !moreInFlightRef.current
      )
        void refresh().catch(() => {});
    }
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      mountedRef.current = false;
      ++versionRef.current;
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [refresh]);

  const primary = primaryDataset(options.page);
  const expected = bootstrap
    ? listSpecs(bootstrap, options).find((spec) => spec.key === primary)
    : undefined;
  const currentCollection = primary ? cacheRef.current[primary] : undefined;
  const matchesView = Boolean(expected && currentCollection?.signature === expected.signature);
  // Mask the previous filter's rows even on the render before the loading effect runs.
  const presented = primary && !matchesView ? { ...data, [primary]: [] } : data;
  return {
    bootstrap,
    data: presented,
    setData,
    refresh,
    loadError,
    setLoadError,
    loadedDataFor,
    listLoading: listLoading || (Boolean(expected) && !matchesView && !loadError),
    loadMore,
    hasMore: matchesView && Boolean(currentCollection?.nextCursor),
    loadingMore,
  };
}
