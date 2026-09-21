import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Copy,
  Gift,
  Heart,
  Home,
  Inbox,
  ListChecks,
  LoaderCircle,
  LogOut,
  Mail,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import { Button, Empty, Modal, ProductForm, TaskCard, TaskDetail, TaskForm } from './components';
import { WeChatAccountCard } from './WeChatAccountCard';
import { MailTemplatePicker } from './MailTemplatePicker';
import {
  api,
  dateText,
  emptyData,
  orderStatus,
  personName,
  requestKey,
  type Bootstrap,
  type Data,
  type Entry,
  type MailStatus,
  type Notice,
  type Order,
  type Page,
  type Product,
  type Schedule,
  type Task,
} from './types';

type ModalState =
  | { type: 'task-new' }
  | { type: 'task'; id: string }
  | { type: 'product-new' }
  | { type: 'product-edit'; id: string }
  | { type: 'redeem'; id: string; key: string }
  | null;
type PendingDestination =
  | { page: 'tasks'; taskId: string | null }
  | { page: 'shop'; orders: boolean; orderId: string | null };
const destinationStorageKey = 'couple.mailDestination';
function parseDestination(params: URLSearchParams): PendingDestination | null {
  if (params.get('page') === 'tasks') return { page: 'tasks', taskId: params.get('task') };
  if (params.get('page') === 'shop')
    return {
      page: 'shop',
      orders: params.get('tab') === 'orders' || !!params.get('order'),
      orderId: params.get('order'),
    };
  return null;
}
function initialDestination(): PendingDestination | null {
  const current = parseDestination(new URLSearchParams(location.search));
  if (current) return current;
  try {
    const saved = JSON.parse(sessionStorage.getItem(destinationStorageKey) || 'null');
    if (
      saved &&
      typeof saved.search === 'string' &&
      typeof saved.savedAt === 'number' &&
      Date.now() - saved.savedAt < 30 * 60 * 1000
    )
      return parseDestination(new URLSearchParams(saved.search));
  } catch {
    // Direct links still work when this browser does not allow session storage.
  }
  return null;
}
const navigation: { id: Page; label: string; icon: typeof Home }[] = [
  { id: 'home', label: '我们的今天', icon: Home },
  { id: 'tasks', label: '小小约定', icon: ListChecks },
  { id: 'shop', label: '心愿小店', icon: Gift },
  { id: 'points', label: '我的积分', icon: Wallet },
  { id: 'settings', label: '我们的空间', icon: Settings },
];
const pageCopy: Record<Page, { eyebrow: string; title: string; subtitle: string }> = {
  home: {
    eyebrow: 'OUR LITTLE EVERYDAY',
    title: '把平凡日常，过成小小的心意',
    subtitle: '一起做好每件小事，也别忘了奖励彼此。',
  },
  tasks: {
    eyebrow: 'A PROMISE, A LITTLE CLOSER',
    title: '小小约定',
    subtitle: '认真完成的每一件小事，都会被对方看见。',
  },
  shop: {
    eyebrow: 'MADE WITH LOVE, JUST FOR YOU',
    title: '心愿小店',
    subtitle: '攒下的每一分用心，都值得一份小小的期待。',
  },
  points: {
    eyebrow: 'EVERY LITTLE EFFORT COUNTS',
    title: '我的积分',
    subtitle: '记录每一份付出，也记录收到的每一份心意。',
  },
  settings: {
    eyebrow: 'A SPACE FOR JUST THE TWO OF US',
    title: '我们的空间',
    subtitle: '把通知、日常计划和两个人的小习惯，都安放在这里。',
  },
};

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [data, setData] = useState<Data>(emptyData);
  const [page, setPage] = useState<Page>('home');
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const [shopTab, setShopTab] = useState('products');
  const [shopFilter, setShopFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [pendingDestination, setPendingDestination] = useState(initialDestination);
  const [loadedDataFor, setLoadedDataFor] = useState<string | null>(null);
  const [highlightedOrder, setHighlightedOrder] = useState<string | null>(null);
  const verifyAttempt = useRef(false);
  const wechatCallbackHandled = useRef(false);
  const refreshVersion = useRef(0);
  const closeModal = useCallback(() => setModal(null), []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const state = await api<Bootstrap>('/bootstrap');
    if (version !== refreshVersion.current) return;
    setBootstrap(state);
    if (!state.user) {
      setData(emptyData);
      setLoadedDataFor(null);
      return;
    }
    const [notifications, mail] = await Promise.all([
      api<{ notifications: Notice[] }>('/notifications'),
      api<MailStatus>('/mail/status'),
    ]);
    if (state.space && state.partner) {
      const [tasks, products, orders, ledger] = await Promise.all([
        api<{ tasks: Task[]; schedules: Schedule[] }>('/tasks'),
        api<{ products: Product[] }>('/products'),
        api<{ orders: Order[] }>('/orders'),
        api<{ entries: Entry[] }>('/ledger'),
      ]);
      if (version !== refreshVersion.current) return;
      setData({
        ...tasks,
        ...products,
        ...orders,
        ...ledger,
        notifications: notifications.notifications,
        mail,
      });
      setLoadedDataFor(`${state.user.id}:${state.space.id}`);
    } else if (version === refreshVersion.current) {
      setData({ ...emptyData, notifications: notifications.notifications, mail });
      setLoadedDataFor(null);
    }
  }, []);
  useEffect(() => {
    refresh().catch((error) => setLoadError(error.message));
  }, [refresh]);
  useEffect(() => {
    const update = () => {
      if (!document.hidden && !busy) void refresh().catch(() => {});
    };
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [busy, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 7500 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const perform = useCallback(
    async (path: string, body: unknown, message: string, method = 'POST') => {
      if (busy) return false;
      setBusy(true);
      try {
        await api(path, method, body);
        await refresh();
        setToast({ text: message });
        return true;
      } catch (error) {
        setToast({
          text: error instanceof Error ? error.message : '暂时没能完成，请再试一次',
          error: true,
        });
        await refresh().catch((refreshError: unknown) =>
          setLoadError(
            refreshError instanceof Error ? refreshError.message : '读取空间内容失败，请重试',
          ),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );
  useEffect(() => {
    const params = new URLSearchParams(location.search),
      token = params.get('verify') || params.get('token');
    if (!bootstrap || !token || verifyAttempt.current) return;
    verifyAttempt.current = true;
    void perform('/auth/verify', { token }, '邮箱验证成功，可以开启邮件提醒了').then((success) => {
      if (success) {
        const url = new URL(location.href);
        url.searchParams.delete('verify');
        url.searchParams.delete('token');
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
        setPage('settings');
      }
    });
  }, [bootstrap, perform]);
  useEffect(() => {
    const url = new URL(location.href);
    const result = url.searchParams.get('wechat');
    if (!bootstrap || !result || wechatCallbackHandled.current) return;
    wechatCallbackHandled.current = true;
    const messages: Record<string, string> = {
      disabled: '微信登录暂未启用，请使用邮箱登录或稍后再试。',
      invalid_state: '这次微信授权已过期或失效，请重新发起。',
      session_changed: '登录状态已发生变化，请重新登录后再绑定微信。',
      cancelled: '微信授权尚未完成，你可以重新发起。',
      provider_error: '微信登录服务暂时没有响应，请稍后再试。',
      identity_conflict: '这个微信已关联其他账号，无法绑定到当前账号。',
    };
    if (result === 'logged_in' && bootstrap.user) {
      setToast({ text: '微信登录成功，欢迎来到两个人' });
    } else if (result === 'bound' && bootstrap.user?.wechatBound) {
      setToast({ text: '微信已绑定，下次可以直接使用微信登录' });
      if (bootstrap.space && bootstrap.partner) setPage('settings');
    } else {
      setToast({
        text: messages[url.searchParams.get('reason') || ''] || '微信授权未能完成，请重新发起。',
        error: true,
      });
    }
    url.searchParams.delete('wechat');
    url.searchParams.delete('reason');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [bootstrap]);
  useEffect(() => {
    if (
      !pendingDestination ||
      busy ||
      !bootstrap?.user ||
      !bootstrap.space ||
      !bootstrap.partner ||
      loadedDataFor !== `${bootstrap.user.id}:${bootstrap.space.id}`
    )
      return;
    setPage(pendingDestination.page);
    setSearch('');
    if (pendingDestination.page === 'tasks') {
      setTaskFilter('all');
      if (pendingDestination.taskId) {
        if (data.tasks.some((task) => task.id === pendingDestination.taskId))
          setModal({ type: 'task', id: pendingDestination.taskId });
        else setToast({ text: '这条约定暂时无法查看，你可以在这里查看其他约定。', error: true });
      }
    } else {
      setShopTab(pendingDestination.orders ? 'orders' : 'products');
      if (pendingDestination.orderId) {
        if (data.orders.some((order) => order.id === pendingDestination.orderId))
          setHighlightedOrder(pendingDestination.orderId);
        else
          setToast({ text: '这笔兑换暂时无法查看，你可以在这里查看其他兑换记录。', error: true });
      }
    }
    setPendingDestination(null);
    try {
      sessionStorage.removeItem(destinationStorageKey);
    } catch {
      // The in-memory destination has already been consumed.
    }
    const url = new URL(location.href);
    for (const key of ['page', 'task', 'tab', 'order']) url.searchParams.delete(key);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [bootstrap, busy, data, loadedDataFor, pendingDestination]);
  useEffect(() => {
    if (!highlightedOrder || page !== 'shop' || shopTab !== 'orders') return;
    const row = document.getElementById(`order-${highlightedOrder}`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.focus({ preventScroll: true });
  }, [highlightedOrder, page, shopTab]);

  async function startWechat(intent: 'login' | 'bind') {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/auth/wechat/start', 'POST', { intent });
      if (new URL(url).protocol !== 'https:') throw new Error('微信授权地址无效，请稍后再试');
      if (pendingDestination) {
        const params = new URLSearchParams({ page: pendingDestination.page });
        if (pendingDestination.page === 'tasks' && pendingDestination.taskId)
          params.set('task', pendingDestination.taskId);
        if (pendingDestination.page === 'shop') {
          if (pendingDestination.orders) params.set('tab', 'orders');
          if (pendingDestination.orderId) params.set('order', pendingDestination.orderId);
        }
        try {
          sessionStorage.setItem(
            destinationStorageKey,
            JSON.stringify({ search: params.toString(), savedAt: Date.now() }),
          );
        } catch {
          // Login can continue even when the browser disables session storage.
        }
      }
      window.location.assign(url);
    } catch (error) {
      setToast({
        text: error instanceof Error ? error.message : '暂时无法打开微信授权，请稍后再试',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  function navigate(next: Page) {
    setPage(next);
    setSearch('');
    setHighlightedOrder(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function clipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setToast({ text: '邀请码已复制，分享给你的另一半吧' });
    } catch {
      setToast({ text: '浏览器暂不支持复制，请长按或选中邀请码复制', error: true });
    }
  }
  const toastView = toast && (
    <div
      className={`toast ${toast.error ? 'toast-error' : ''}`}
      role={toast.error ? 'alert' : 'status'}
    >
      {toast.error ? <X size={19} /> : <Check size={19} />}
      <span>{toast.text}</span>
      <button aria-label="关闭提示" onClick={() => setToast(null)}>
        <X size={16} />
      </button>
    </div>
  );
  if (
    !bootstrap ||
    (pendingDestination &&
      bootstrap.user &&
      bootstrap.space &&
      bootstrap.partner &&
      loadedDataFor !== `${bootstrap.user.id}:${bootstrap.space.id}`)
  )
    return (
      <div className="loading-screen">
        <Brand />
        <div className="loading-message">
          {loadError ? (
            <>
              <p>{loadError}</p>
              <Button
                className="primary"
                onClick={() => {
                  setLoadError('');
                  void refresh().catch((error) => setLoadError(error.message));
                }}
              >
                <RefreshCw size={17} />
                重新连接
              </Button>
            </>
          ) : (
            <>
              <LoaderCircle className="spin" />
              <p>{bootstrap ? '正在打开邮件中的内容…' : '正在打开我们的小空间…'}</p>
            </>
          )}
        </div>
      </div>
    );
  if (!bootstrap.user)
    return (
      <>
        <Auth
          busy={busy}
          wechatEnabled={bootstrap.wechatEnabled}
          onWechat={() => startWechat('login')}
          onSubmit={async (path, body) => {
            await perform(path, body, '欢迎来到两个人');
          }}
        />
        {toastView}
      </>
    );
  if (!bootstrap.space || !bootstrap.partner)
    return (
      <>
        <Onboarding
          bootstrap={bootstrap}
          busy={busy}
          onAction={perform}
          onCopy={clipboard}
          onWechat={() => startWechat('bind')}
        />
        {toastView}
      </>
    );

  const user = bootstrap.user,
    partner = bootstrap.partner;
  const unread = data.notifications.filter((item) => !item.readAt).length;
  const myTasks = data.tasks.filter(
    (task) => task.claimantId === user.id && task.status === 'CLAIMED',
  );
  const reviewTasks = data.tasks.filter(
    (task) => task.status === 'SUBMITTED' && task.claimantId !== user.id,
  );
  const openTasks = data.tasks.filter(
    (task) => task.status === 'OPEN' && (task.mode === 'RACE' || task.assignedTo === user.id),
  );
  const activeTasks = [...reviewTasks, ...myTasks, ...openTasks].slice(0, 4);
  const visibleTasks = data.tasks.filter(
    (task) =>
      (taskFilter === 'all' ||
        (taskFilter === 'open' && openTasks.some((item) => item.id === task.id)) ||
        (taskFilter === 'mine' &&
          task.claimantId === user.id &&
          ['CLAIMED', 'SUBMITTED'].includes(task.status)) ||
        (taskFilter === 'review' && reviewTasks.some((item) => item.id === task.id)) ||
        (taskFilter === 'done' && ['APPROVED', 'CANCELLED', 'EXPIRED'].includes(task.status))) &&
      (!search || `${task.title} ${task.description}`.includes(search)),
  );
  const visibleProducts = data.products.filter(
    (product) =>
      (product.active || product.creatorId === user.id) &&
      (shopFilter === 'all' ||
        (shopFilter === 'mine' ? product.creatorId === user.id : product.creatorId !== user.id)),
  );
  const featuredProducts = data.products
    .filter((product) => product.active && product.stock > 0)
    .slice(0, 2);
  const selectedTask =
    modal?.type === 'task' ? data.tasks.find((task) => task.id === modal.id) : undefined;
  const selectedProduct =
    modal?.type === 'product-edit' || modal?.type === 'redeem'
      ? data.products.find((product) => product.id === modal.id)
      : undefined;
  const greeting =
    new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false })
      .formatToParts(new Date())
      .find((part) => part.type === 'hour')?.value || '12';
  const greetingText =
    Number(greeting) < 11
      ? '早上好'
      : Number(greeting) < 14
        ? '中午好'
        : Number(greeting) < 18
          ? '下午好'
          : '晚上好';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-caption">两个人，一起把日子过好。</div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={20} strokeWidth={page === item.id ? 2.2 : 1.7} />
              <span>{item.label}</span>
              {item.id === 'tasks' && reviewTasks.length > 0 && (
                <span className="nav-count">{reviewTasks.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="space-stamp">
            <div className="paired-avatars">
              <span>{user.name.slice(0, 1)}</span>
              <span>{partner.name.slice(0, 1)}</span>
              <Heart size={12} />
            </div>
            <strong>{bootstrap.space.name}</strong>
            <small>只属于你们的私密空间</small>
          </div>
          <div className="sidebar-foot">
            <ShieldCheck size={13} />
            两个人的小事，也值得认真对待
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="topbar-date">
            <CalendarDays size={15} />
            {new Intl.DateTimeFormat('zh-CN', {
              timeZone: 'Asia/Shanghai',
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            }).format(new Date())}
            <span className="date-divider" />
            今天也要好好在一起
          </span>
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="topbar-actions">
            <button
              className="notification-button"
              aria-label={`通知${unread ? `，${unread}条未读` : ''}`}
              onClick={() => navigate('settings')}
            >
              <Bell size={20} />
              {unread > 0 && <span />}
            </button>
            <button
              className="profile-button"
              onClick={() => navigate('settings')}
              aria-label="个人设置"
            >
              <span>{user.name.slice(0, 1)}</span>
              <b>{user.name}</b>
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">{pageCopy[page].eyebrow}</span>
              <h1>{pageCopy[page].title}</h1>
              <p>{pageCopy[page].subtitle}</p>
            </div>
            {page === 'home' || page === 'tasks' ? (
              <Button className="primary" onClick={() => setModal({ type: 'task-new' })}>
                <Plus size={18} />
                发布小约定
              </Button>
            ) : page === 'shop' ? (
              <Button className="primary" onClick={() => setModal({ type: 'product-new' })}>
                <Plus size={18} />
                上架心愿
              </Button>
            ) : null}
          </div>

          {page === 'home' && (
            <>
              <section className="welcome-card">
                <div className="welcome-copy">
                  <span className="welcome-tag">
                    <span />
                    OUR SPACE · 我们的小世界
                  </span>
                  <h2>
                    {greetingText}，{user.name} <span>☀</span>
                  </h2>
                  <p>
                    幸福藏在日常的小事里。
                    <br />
                    今天，也为{partner.name}做一点什么吧。
                  </p>
                  <button
                    className="text-link"
                    onClick={() => {
                      setTaskFilter('open');
                      navigate('tasks');
                    }}
                  >
                    看看有哪些小约定 <ArrowRight size={17} />
                  </button>
                </div>
                <div className="couple-art" aria-hidden="true">
                  <span className="art-orbit orbit-one" />
                  <span className="art-orbit orbit-two" />
                  <span className="art-spark spark-one">✦</span>
                  <span className="art-spark spark-two">✧</span>
                  <span className="art-spark spark-three">✦</span>
                  <div className="art-heart heart-one">
                    <Heart fill="currentColor" />
                  </div>
                  <div className="art-heart heart-two">
                    <Heart fill="currentColor" />
                  </div>
                  <div className="art-note">
                    <Heart size={13} fill="currentColor" /> little things, big love
                  </div>
                </div>
              </section>
              <div className="stats-grid">
                <button className="stat-card" onClick={() => navigate('points')}>
                  <span className="stat-icon rose">
                    <Sparkles size={22} />
                  </span>
                  <div>
                    <span className="stat-label">我的心意积分</span>
                    <strong>
                      {bootstrap.balance}
                      <small>积分</small>
                    </strong>
                  </div>
                  <ArrowUpRight size={17} />
                </button>
                <button
                  className="stat-card"
                  onClick={() => {
                    setTaskFilter('mine');
                    navigate('tasks');
                  }}
                >
                  <span className="stat-icon peach">
                    <ClipboardList size={22} />
                  </span>
                  <div>
                    <span className="stat-label">我在做的小约定</span>
                    <strong>
                      {myTasks.length}
                      <small>件进行中</small>
                    </strong>
                  </div>
                  <ArrowUpRight size={17} />
                </button>
                <button
                  className="stat-card"
                  onClick={() => {
                    setTaskFilter('review');
                    navigate('tasks');
                  }}
                >
                  <span className="stat-icon sage">
                    <CheckCheck size={22} />
                  </span>
                  <div>
                    <span className="stat-label">等待我的验收</span>
                    <strong>
                      {reviewTasks.length}
                      <small>份用心</small>
                    </strong>
                  </div>
                  <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="dashboard-grid">
                <section className="panel today-panel">
                  <div className="section-heading">
                    <div>
                      <span className="section-kicker">LITTLE PROMISES</span>
                      <h2>今天，为彼此做点什么</h2>
                    </div>
                    <button className="text-link muted-link" onClick={() => navigate('tasks')}>
                      查看全部 <ChevronRight size={15} />
                    </button>
                  </div>
                  {activeTasks.length ? (
                    <div className="task-list">
                      {activeTasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          bootstrap={bootstrap}
                          onOpen={() => setModal({ type: 'task', id: task.id })}
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<ListChecks size={27} />} title="日常的美好，从一个小约定开始">
                      做一顿晚饭、一起散步，或是认真说一句晚安。
                      <Button className="subtle" onClick={() => setModal({ type: 'task-new' })}>
                        <Plus size={16} />
                        写下第一个约定
                      </Button>
                    </Empty>
                  )}
                  <div className="panel-footer">
                    <Heart size={14} />
                    每一件小事，都是「我在乎你」的另一种说法。
                  </div>
                </section>
                <section className="panel wish-preview">
                  <div className="section-heading">
                    <div>
                      <span className="section-kicker">A LITTLE SOMETHING</span>
                      <h2>攒一份小期待</h2>
                    </div>
                    <Gift size={20} className="rose-text" />
                  </div>
                  {featuredProducts.length ? (
                    featuredProducts.map((product) => (
                      <button
                        key={product.id}
                        className="mini-product"
                        onClick={() =>
                          setModal({ type: 'redeem', id: product.id, key: requestKey() })
                        }
                      >
                        <span className="mini-product-emoji">{product.emoji}</span>
                        <div>
                          <strong>{product.title}</strong>
                          <span>
                            {product.price} 积分 ·{' '}
                            {bootstrap.balance >= product.price
                              ? '现在就能兑换'
                              : `还差 ${product.price - bootstrap.balance} 积分`}
                          </span>
                          <div className="progress-track">
                            <span
                              style={{
                                width: `${Math.min(100, (bootstrap.balance / product.price) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                        <ChevronRight size={17} />
                      </button>
                    ))
                  ) : (
                    <div className="wish-empty">
                      <span>🎁</span>
                      <p>
                        暂时没有可兑换的心愿
                        <br />
                        把你们想要的小惊喜放上来吧。
                      </p>
                    </div>
                  )}
                  <button className="button subtle wide" onClick={() => navigate('shop')}>
                    去心愿小店逛逛 <ArrowRight size={16} />
                  </button>
                </section>
              </div>
              <div className="daily-note">
                <span>♡</span>
                <p>
                  我们不必把日子过得多么盛大，<b>认真对待彼此就很好。</b>
                </p>
                <span>♡</span>
              </div>
            </>
          )}

          {page === 'tasks' && (
            <section className="panel page-panel">
              <div className="toolbar">
                <div className="tabs" role="group" aria-label="任务筛选">
                  {[
                    ['all', '全部约定'],
                    ['open', '可以领取'],
                    ['mine', '我的任务'],
                    ['review', `待我验收${reviewTasks.length ? ` ${reviewTasks.length}` : ''}`],
                    ['done', '已结束'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={taskFilter === key ? 'active' : ''}
                      onClick={() => setTaskFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="search-field">
                  <Search size={17} />
                  <input
                    aria-label="搜索任务"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="找一个小约定"
                  />
                </label>
              </div>
              {visibleTasks.length ? (
                <div className="task-list full-task-list">
                  {visibleTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      bootstrap={bootstrap}
                      onOpen={() => setModal({ type: 'task', id: task.id })}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<ListChecks size={28} />}
                  title={
                    search
                      ? '没有找到这个约定'
                      : taskFilter === 'review'
                        ? '暂时没有等待验收的任务'
                        : '这里还没有小约定'
                  }
                >
                  {search
                    ? '试试换个关键词，或者查看全部约定。'
                    : '给日常一点仪式感，写下一件想一起完成的小事。'}
                  {!search && (
                    <Button className="subtle" onClick={() => setModal({ type: 'task-new' })}>
                      <Plus size={16} />
                      发布小约定
                    </Button>
                  )}
                </Empty>
              )}
              <div className="panel-footer">
                <CalendarDays size={14} />
                想每天或每周重复？发布时选择时间类型，之后可在「我们的空间」管理计划。
              </div>
            </section>
          )}

          {page === 'shop' && (
            <>
              <div className="shop-top">
                <div className="tabs" role="group" aria-label="商城页面">
                  <button
                    className={shopTab === 'products' ? 'active' : ''}
                    onClick={() => setShopTab('products')}
                  >
                    <Gift size={16} />
                    心愿架
                  </button>
                  <button
                    className={shopTab === 'orders' ? 'active' : ''}
                    onClick={() => setShopTab('orders')}
                  >
                    <ShoppingBag size={16} />
                    兑换记录
                    {data.orders.filter(
                      (order) =>
                        (order.status === 'PENDING' && order.sellerId === user.id) ||
                        (order.status === 'FULFILLED' && order.buyerId === user.id),
                    ).length > 0 && <span className="tiny-dot" />}
                  </button>
                </div>
                <span className="balance-label">
                  <Sparkles size={17} />
                  可用积分 <strong>{bootstrap.balance}</strong>
                </span>
              </div>
              {shopTab === 'products' ? (
                <>
                  <div className="filter-line">
                    {[
                      ['all', '全部心愿'],
                      ['partner', `${partner.name}上架的`],
                      ['mine', '我上架的'],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        className={shopFilter === key ? 'selected' : ''}
                        onClick={() => setShopFilter(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {visibleProducts.length ? (
                    <div className="product-grid">
                      {visibleProducts.map((product, index) => (
                        <article className="product-card" key={product.id}>
                          <div className={`product-art product-color-${index % 4}`}>
                            <span>{product.emoji}</span>
                            {product.creatorId === user.id && (
                              <span className="product-owner">我上架的</span>
                            )}
                            {!product.active && <span className="product-inactive">已下架</span>}
                          </div>
                          <div className="product-body">
                            <span className="product-from">
                              {personName(product.creatorId, bootstrap)}上架 · 兑换后由另一半兑现
                            </span>
                            <h3>{product.title}</h3>
                            <p>{product.description || '一份等待兑现的小美好。'}</p>
                            <div className="product-price">
                              <strong>
                                {product.price}
                                <small>积分</small>
                              </strong>
                              <span>剩余 {product.stock} 份</span>
                            </div>
                            {product.creatorId === user.id && (
                              <div className="product-actions">
                                <Button
                                  className="subtle"
                                  onClick={() => setModal({ type: 'product-edit', id: product.id })}
                                >
                                  <Pencil size={15} />
                                  编辑心愿
                                </Button>
                                <Button
                                  className="ghost"
                                  busy={busy}
                                  onClick={() =>
                                    perform(
                                      `/products/${product.id}`,
                                      { active: !product.active },
                                      product.active
                                        ? '心愿已下架，现有订单仍可继续兑现'
                                        : '心愿重新上架啦',
                                      'PATCH',
                                    )
                                  }
                                >
                                  {product.active ? '下架' : '上架'}
                                </Button>
                              </div>
                            )}
                            <Button
                              className="subtle wide product-redeem"
                              disabled={!product.active || product.stock === 0}
                              onClick={() =>
                                setModal({ type: 'redeem', id: product.id, key: requestKey() })
                              }
                            >
                              {!product.active
                                ? '心愿已下架'
                                : product.stock === 0
                                  ? '这份心意暂时兑完啦'
                                  : bootstrap.balance < product.price
                                    ? `还差 ${product.price - bootstrap.balance} 积分`
                                    : '兑换这份心意'}
                              <ArrowRight size={16} />
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <section className="panel">
                      <Empty icon={<Gift size={28} />} title="把你们想要的心愿放上来">
                        一杯奶茶、一场电影、一次专属按摩，都可以成为值得期待的奖励。
                        <Button
                          className="primary"
                          onClick={() => setModal({ type: 'product-new' })}
                        >
                          <Plus size={17} />
                          上架第一份心愿
                        </Button>
                      </Empty>
                    </section>
                  )}
                </>
              ) : (
                <section className="panel orders-panel">
                  {data.orders.length ? (
                    data.orders.map((order) => (
                      <article
                        className={`order-card ${highlightedOrder === order.id ? 'order-highlighted' : ''}`}
                        key={order.id}
                        id={`order-${order.id}`}
                        tabIndex={-1}
                      >
                        <div className="order-icon">
                          <Gift size={23} />
                        </div>
                        <div className="order-info">
                          <div className="order-title">
                            <h3>{order.title}</h3>
                            <span
                              className={`status status-${order.status === 'COMPLETED' ? 'approved' : order.status === 'CANCELLED' ? 'cancelled' : 'submitted'}`}
                            >
                              {orderStatus[order.status]}
                            </span>
                          </div>
                          <p>
                            {personName(order.buyerId, bootstrap)}兑换 · 由
                            {personName(order.sellerId, bootstrap)}兑现 · {order.price} 积分
                          </p>
                          <small>{dateText(order.createdAt, true)}</small>
                          {order.description && (
                            <p className="order-description">{order.description}</p>
                          )}
                        </div>
                        <div className="order-actions">
                          {order.status === 'PENDING' && order.sellerId === user.id && (
                            <Button
                              busy={busy}
                              className="primary small"
                              onClick={() =>
                                perform(
                                  `/orders/${order.id}/action`,
                                  { action: 'fulfill' },
                                  '已标记兑现，等待对方确认',
                                )
                              }
                            >
                              <Check size={15} />
                              我已兑现
                            </Button>
                          )}
                          {order.status === 'FULFILLED' && order.buyerId === user.id && (
                            <Button
                              busy={busy}
                              className="primary small"
                              onClick={() =>
                                perform(
                                  `/orders/${order.id}/action`,
                                  { action: 'complete' },
                                  '心意已收到，这次兑换圆满完成',
                                )
                              }
                            >
                              <Heart size={15} />
                              确认收到
                            </Button>
                          )}
                          {order.status === 'PENDING' && (
                            <Button
                              busy={busy}
                              className="ghost small"
                              onClick={() =>
                                perform(
                                  `/orders/${order.id}/action`,
                                  { action: 'cancel' },
                                  '兑换已取消，积分和库存已退回',
                                )
                              }
                            >
                              {order.buyerId === user.id ? '取消兑换' : '暂不能兑现'}
                            </Button>
                          )}
                        </div>
                      </article>
                    ))
                  ) : (
                    <Empty icon={<ShoppingBag size={28} />} title="还没有兑换记录">
                      完成小约定赚取积分，再来兑换一份专属心意。
                      <Button className="subtle" onClick={() => setShopTab('products')}>
                        去心愿架看看 <ArrowRight size={16} />
                      </Button>
                    </Empty>
                  )}
                </section>
              )}
            </>
          )}

          {page === 'points' && (
            <>
              <section className="wallet-card">
                <div>
                  <span className="eyebrow">MY LITTLE REWARDS</span>
                  <p>我的可用积分</p>
                  <strong>
                    {bootstrap.balance}
                    <span>积分</span>
                  </strong>
                  <span className="wallet-note">每一分，都是认真在一起的证据。</span>
                </div>
                <div className="wallet-decoration" aria-hidden="true">
                  <Sparkles size={70} strokeWidth={1} />
                </div>
                <Button className="light" onClick={() => navigate('shop')}>
                  去兑换心愿 <ArrowRight size={16} />
                </Button>
              </section>
              <section className="panel ledger-panel">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">LITTLE EFFORTS, WELL REMEMBERED</span>
                    <h2>积分的来来往往</h2>
                  </div>
                  <span className="muted">仅展示我的积分</span>
                </div>
                {data.entries.length ? (
                  data.entries.map((entry) => (
                    <div className="ledger-row" key={entry.id}>
                      <span className={`ledger-icon ${entry.delta > 0 ? 'sage' : 'rose'}`}>
                        {entry.delta > 0 ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}
                      </span>
                      <div>
                        <strong>{ledgerReason(entry.reason)}</strong>
                        <small>{dateText(entry.createdAt, true)}</small>
                      </div>
                      <div className="ledger-value">
                        <strong className={entry.delta > 0 ? 'positive' : ''}>
                          {entry.delta > 0 ? '+' : ''}
                          {entry.delta}
                        </strong>
                        <small>余额 {entry.balanceAfter}</small>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty icon={<Sparkles size={29} />} title="第一份积分，等着你的用心">
                    领取并完成一个任务，经过对方验收后，积分就会出现在这里。
                    <Button className="subtle" onClick={() => navigate('tasks')}>
                      看看小约定 <ArrowRight size={16} />
                    </Button>
                  </Empty>
                )}
                <div className="panel-footer">
                  <ShieldCheck size={14} />
                  积分来自任务奖励，可用于兑换；取消待兑现的订单会自动退款。
                </div>
              </section>
            </>
          )}

          {page === 'settings' && (
            <div className="settings-grid">
              <section className="panel settings-panel">
                <div className="section-heading">
                  <h2>
                    <Heart size={20} />
                    两个人的资料
                  </h2>
                </div>
                <div className="settings-couple">
                  <div>
                    <span className="large-avatar">{user.name.slice(0, 1)}</span>
                    <strong>{user.name}</strong>
                    <small>我</small>
                  </div>
                  <Heart className="rose-text" size={23} />
                  <div>
                    <span className="large-avatar partner-avatar">{partner.name.slice(0, 1)}</span>
                    <strong>{partner.name}</strong>
                    <small>另一半</small>
                  </div>
                </div>
                <div className="settings-pair">
                  <span>空间名称</span>
                  <strong>{bootstrap.space.name}</strong>
                </div>
                <WeChatAccountCard
                  bootstrap={bootstrap}
                  busy={busy}
                  onAction={perform}
                  onWechat={() => startWechat('bind')}
                />
                <Button
                  busy={busy}
                  className="ghost wide logout-button"
                  onClick={async () => {
                    if (await perform('/auth/logout', {}, '已安全退出')) {
                      setPage('home');
                      setModal(null);
                    }
                  }}
                >
                  <LogOut size={16} />
                  退出登录
                </Button>
              </section>
              <section className="panel settings-panel">
                <div className="section-heading">
                  <h2>
                    <Mail size={20} />
                    邮件小提醒
                  </h2>
                </div>
                <p className="settings-description">
                  任务发布、领取、提交和验收，以及心愿兑换与兑现的进展，都可以通过邮件提醒你。
                  验证邮箱并开启下方开关后，就能收到与你有关的提醒。
                </p>
                <label className="toggle-row">
                  <span>
                    <strong>接收邮件通知</strong>
                    <small>
                      {!user.email
                        ? '先补充并验证邮箱，即可开启邮件提醒'
                        : !user.emailVerified
                          ? '先验证邮箱，再开启邮件提醒'
                          : user.notifyEmail
                            ? '已开启，相关任务和兑换进展会发到你的邮箱'
                            : '邮箱已验证，开启后接收任务和兑换提醒'}
                    </small>
                  </span>
                  <input
                    aria-label="接收邮件通知"
                    type="checkbox"
                    checked={user.notifyEmail}
                    disabled={
                      busy ||
                      !user.email ||
                      !user.emailVerified ||
                      (!bootstrap.smtpConfigured && !user.notifyEmail)
                    }
                    onChange={(event) =>
                      void perform(
                        '/settings',
                        { notifyEmail: event.target.checked },
                        event.target.checked ? '邮件通知已开启' : '邮件通知已关闭',
                        'PATCH',
                      )
                    }
                  />
                  <span className="toggle" aria-hidden="true" />
                </label>
                {!bootstrap.smtpConfigured && (
                  <div className="inline-message warning">
                    <Mail size={18} />
                    <span>邮件服务暂未启用，暂时无法发送邮件。你仍可以在这里查看站内消息。</span>
                  </div>
                )}
                {data.mail && (
                  <>
                    <div className="mail-stats">
                      <div>
                        <strong>{data.mail.counts.pending}</strong>
                        <span>等待发送</span>
                      </div>
                      <div>
                        <strong>{data.mail.counts.sent}</strong>
                        <span>已发送</span>
                      </div>
                      <div>
                        <strong>{data.mail.counts.failed}</strong>
                        <span>发送失败</span>
                      </div>
                    </div>
                    {data.mail.counts.failed > 0 && (
                      <Button
                        busy={busy}
                        className="subtle wide"
                        onClick={() => perform('/mail/retry', {}, '失败邮件已重新加入发送队列')}
                      >
                        <RefreshCw size={16} />
                        重试失败邮件
                      </Button>
                    )}
                  </>
                )}
                <MailTemplatePicker
                  currentTheme={user.emailTheme}
                  busy={busy}
                  onSave={(emailTheme) =>
                    perform(
                      '/settings',
                      { emailTheme },
                      '邮件样式已保存，之后的提醒将使用这个样式',
                      'PATCH',
                    )
                  }
                />
              </section>
              <section className="panel settings-panel wide-panel">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">OUR ROUTINES</span>
                    <h2>
                      <CalendarDays size={20} />
                      定时与日常计划
                    </h2>
                  </div>
                  <Button className="subtle small" onClick={() => setModal({ type: 'task-new' })}>
                    <Plus size={16} />
                    新建计划
                  </Button>
                </div>
                {data.schedules.length ? (
                  data.schedules.map((schedule) => (
                    <div className="schedule-row" key={schedule.id}>
                      <span className={`schedule-icon ${schedule.active ? 'rose' : ''}`}>
                        <CalendarDays size={21} />
                      </span>
                      <div>
                        <strong>
                          {schedule.title}
                          <span
                            className={`status ${schedule.active ? 'status-approved' : 'status-cancelled'}`}
                          >
                            {schedule.active ? '进行中' : '已暂停 / 结束'}
                          </span>
                        </strong>
                        <p>
                          {scheduleText(schedule)} · {schedule.reward} 积分 · 发布后{' '}
                          {schedule.durationHours} 小时截止
                        </p>
                        <small>
                          {schedule.active && schedule.nextRunAt
                            ? `下次发布 ${dateText(schedule.nextRunAt, true)}`
                            : '暂停不会影响已经发布的任务'}
                        </small>
                      </div>
                      {schedule.creatorId === user.id ? (
                        <Button
                          busy={busy}
                          className="subtle small"
                          onClick={() =>
                            perform(
                              `/schedules/${schedule.id}`,
                              { active: !schedule.active },
                              schedule.active
                                ? '计划已暂停，已发布任务保持不变'
                                : '计划已恢复，从下一个未来时刻继续',
                              'PATCH',
                            )
                          }
                        >
                          {schedule.active ? <Pause size={15} /> : <Play size={15} />}
                          {schedule.active ? '暂停' : '恢复'}
                        </Button>
                      ) : (
                        <span className="muted">{partner.name}创建</span>
                      )}
                    </div>
                  ))
                ) : (
                  <Empty icon={<CalendarDays size={25} />} title="一起养成小小的好习惯">
                    每天散步、每周一次约会，设置重复计划后，到点就会自动发布任务。
                  </Empty>
                )}
                <div className="form-hint">
                  <CalendarDays size={14} />
                  日程固定使用北京时间，暂停只影响未来的发布。
                </div>
              </section>
              <section className="panel settings-panel wide-panel" id="notifications">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">A NOTE FOR YOU</span>
                    <h2>
                      <Bell size={20} />
                      消息与提醒{unread > 0 && <span className="count-badge">{unread}</span>}
                    </h2>
                  </div>
                  <Button
                    className="ghost small"
                    disabled={unread === 0}
                    busy={busy}
                    onClick={() => perform('/notifications/read', {}, '所有消息已标记为已读')}
                  >
                    <CheckCheck size={16} />
                    全部已读
                  </Button>
                </div>
                {data.notifications.length ? (
                  data.notifications.map((notice) => (
                    <article
                      className={`notice-row ${notice.readAt ? '' : 'unread'}`}
                      key={notice.id}
                    >
                      <span className="notice-dot" />
                      <div>
                        <h3>{notice.title}</h3>
                        <p>{notice.body}</p>
                        <small>{dateText(notice.createdAt, true)}</small>
                      </div>
                    </article>
                  ))
                ) : (
                  <Empty icon={<Inbox size={25} />} title="这里会收到对方的小消息">
                    任务进展、兑换和验收通知，都将在这里好好保存。
                  </Empty>
                )}
              </section>
            </div>
          )}

          <footer className="page-footer">
            <Heart size={12} />
            两个人 · 把喜欢，放进每一天
          </footer>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="手机主导航">
        {navigation.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? 'active' : ''}
            onClick={() => navigate(item.id)}
          >
            <item.icon size={21} />
            <span>
              {item.id === 'home'
                ? '今天'
                : item.id === 'tasks'
                  ? '约定'
                  : item.id === 'shop'
                    ? '心愿'
                    : item.id === 'points'
                      ? '积分'
                      : '我们'}
            </span>
            {item.id === 'tasks' && reviewTasks.length > 0 && <i />}
          </button>
        ))}
      </nav>

      {modal?.type === 'task-new' && (
        <Modal
          title="写下一个小约定"
          subtitle="把希望对方做的小事，变成一份认真对待的约定。"
          onClose={closeModal}
        >
          <TaskForm
            busy={busy}
            partner={partner.name}
            onSave={async (body, scheduled) => {
              if (
                await perform(
                  scheduled ? '/schedules' : '/tasks',
                  body,
                  scheduled ? '定时约定创建好啦，到点会自动发布' : '小约定发布啦',
                )
              )
                closeModal();
            }}
          />
        </Modal>
      )}
      {modal?.type === 'task' && selectedTask && (
        <Modal title={selectedTask.title} onClose={closeModal}>
          <TaskDetail
            key={selectedTask.id}
            task={selectedTask}
            bootstrap={bootstrap}
            busy={busy}
            onAction={async (action, body = {}) => {
              const messages: Record<string, string> = {
                claim: '约定接下啦，好好完成吧',
                release: '任务已放回，可以重新领取',
                submit: '已提交完成，等待对方验收',
                review: body.approve ? '验收通过，积分已到账' : '反馈已送达',
                cancel: '小约定已取消',
              };
              if (
                await perform(
                  `/tasks/${selectedTask.id}/${action}`,
                  body,
                  messages[action] || '操作完成',
                )
              )
                closeModal();
            }}
          />
        </Modal>
      )}
      {(modal?.type === 'product-new' || modal?.type === 'product-edit') && (
        <Modal
          title={modal.type === 'product-new' ? '放上一份小心意' : '编辑这份心意'}
          subtitle="两个人都能兑换，使用自己的积分，由另一半来兑现。"
          onClose={closeModal}
        >
          <ProductForm
            key={selectedProduct?.id || 'new'}
            busy={busy}
            product={selectedProduct}
            onSave={async (body) => {
              if (
                await perform(
                  selectedProduct ? `/products/${selectedProduct.id}` : '/products',
                  body,
                  selectedProduct ? '心愿已更新，已有订单内容保持不变' : '心愿上架啦',
                  selectedProduct ? 'PATCH' : 'POST',
                )
              ) {
                closeModal();
                setShopTab('products');
                setShopFilter('all');
              }
            }}
          />
        </Modal>
      )}
      {modal?.type === 'redeem' && selectedProduct && (
        <Modal title="把这份心意带回家" onClose={closeModal}>
          <div className="redeem-preview">
            <span>{selectedProduct.emoji}</span>
            <h3>{selectedProduct.title}</h3>
            <p>{selectedProduct.description || '一份等待兑现的小美好。'}</p>
            <strong>
              {selectedProduct.price} <small>积分</small>
            </strong>
          </div>
          <div className="redeem-summary">
            <span>
              我的可用积分 <b>{bootstrap.balance}</b>
            </span>
            <span>
              兑换后剩余 <b>{Math.max(0, bootstrap.balance - selectedProduct.price)}</b>
            </span>
          </div>
          <div className="form-hint">
            <Heart size={16} />
            本次扣除我的 {selectedProduct.price} 积分，由{partner.name}来兑现。
            自己上架的心愿也能兑换；待兑现时取消，积分会退回。
          </div>
          <Button
            busy={busy}
            className="primary wide"
            disabled={
              !selectedProduct.active ||
              bootstrap.balance < selectedProduct.price ||
              selectedProduct.stock < 1
            }
            onClick={async () => {
              if (
                await perform(
                  `/products/${selectedProduct.id}/redeem`,
                  { idempotencyKey: modal.key },
                  '兑换成功，等待对方送上这份心意',
                )
              ) {
                closeModal();
                setShopTab('orders');
                navigate('shop');
              }
            }}
          >
            <Gift size={18} />
            {!selectedProduct.active
              ? '这份心意已下架'
              : bootstrap.balance < selectedProduct.price
                ? `还差 ${selectedProduct.price - bootstrap.balance} 积分，继续加油`
                : selectedProduct.stock < 1
                  ? '这份心意已经兑完啦'
                  : `确认使用 ${selectedProduct.price} 积分兑换`}
          </Button>
        </Modal>
      )}
      {toastView}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Heart size={21} fill="currentColor" />
        <Check size={13} />
      </span>
      <div>
        <strong>
          两个人<span>。</span>
        </strong>
        <small>BETTER, TOGETHER</small>
      </div>
    </div>
  );
}
function ledgerReason(reason: string) {
  return (
    (
      {
        TASK_REWARD: '完成任务 · 收到奖励',
        REDEMPTION: '兑换心愿 · 送给自己',
        ORDER_REDEEM: '兑换心愿 · 送给自己',
        ORDER_REFUND: '取消兑换 · 积分退回',
        REFUND: '取消兑换 · 积分退回',
      } as Record<string, string>
    )[reason] || reason
  );
}
function scheduleText(schedule: Schedule) {
  return schedule.kind === 'ONCE'
    ? '定时发布一次'
    : schedule.kind === 'DAILY'
      ? `每天 ${schedule.time || ''}`
      : `每周${['', '一', '二', '三', '四', '五', '六', '日'][schedule.weekday || 1]} ${schedule.time || ''}`;
}

function Auth({
  busy,
  wechatEnabled,
  onWechat,
  onSubmit,
}: {
  busy: boolean;
  wechatEnabled: boolean;
  onWechat: () => Promise<void>;
  onSubmit: (path: string, body: unknown) => Promise<void>;
}) {
  const [register, setRegister] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await onSubmit(register ? '/auth/register' : '/auth/login', {
      ...(register ? { name: String(values.get('name')).trim() } : {}),
      email: String(values.get('email')).trim(),
      password: values.get('password'),
    });
  }
  return (
    <div className="auth-shell">
      <section className="auth-story">
        <Brand />
        <div className="auth-story-main">
          <span className="eyebrow">LITTLE THINGS. BIG LOVE.</span>
          <h1>
            把喜欢，
            <br />
            放进每一天<span>。</span>
          </h1>
          <p>
            写下小约定，攒一点心意。
            <br />
            两个人一起，把平凡的日子过得闪闪发光。
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <span className="auth-heart-one">♡</span>
            <span className="auth-heart-two">♡</span>
            <div className="floating-note">
              <CheckCheck size={21} />
              <div>
                <strong>认真完成的小事</strong>
                <small>都值得被好好奖励</small>
              </div>
              <Sparkles size={20} />
            </div>
          </div>
        </div>
        <span className="auth-bottom">A PRIVATE LITTLE WORLD, JUST FOR TWO.</span>
      </section>
      <section className="auth-form-side">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-card">
          <span className="eyebrow">WELCOME TO OUR LITTLE SPACE</span>
          <h2>{register ? '美好的日常，从这里开始' : '欢迎回到，两个人'}</h2>
          <p>{register ? '创建你的账号，邀请另一半加入。' : '你们的小小约定，还在这里等你。'}</p>
          <div className="auth-tabs">
            <button className={!register ? 'active' : ''} onClick={() => setRegister(false)}>
              登录
            </button>
            <button className={register ? 'active' : ''} onClick={() => setRegister(true)}>
              创建账号
            </button>
          </div>
          <form className="form-stack" onSubmit={submit}>
            {register && (
              <label>
                怎么称呼你
                <input
                  name="name"
                  placeholder="你的名字或昵称"
                  required
                  maxLength={30}
                  autoComplete="nickname"
                />
              </label>
            )}
            <label>
              邮箱
              <input
                type="email"
                name="email"
                placeholder="your@email.com"
                maxLength={254}
                required
                autoComplete="email"
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                minLength={register ? 8 : 1}
                maxLength={128}
                placeholder={register ? '至少 8 位，留一个安心的小秘密' : '输入你的密码'}
                required
                autoComplete={register ? 'new-password' : 'current-password'}
              />
            </label>
            <Button className="primary wide" type="submit" busy={busy}>
              {register ? '创建我的账号' : '进入我们的小空间'}
              <ArrowRight size={18} />
            </Button>
          </form>
          <div className="auth-wechat">
            <div className="auth-divider">
              <span>也可以用微信进入</span>
            </div>
            <Button
              className="wechat-button wide"
              busy={busy}
              disabled={!wechatEnabled}
              onClick={onWechat}
              aria-describedby="wechat-login-hint"
            >
              <MessageCircle size={19} />
              微信登录
            </Button>
            <p id="wechat-login-hint" className="account-hint">
              {wechatEnabled
                ? '首次微信登录将创建账号。已有邮箱账号？请先用邮箱登录，再绑定微信。'
                : '微信登录暂未启用，请先使用邮箱登录或创建账号。'}
            </p>
          </div>
          <div className="auth-privacy">
            <ShieldCheck size={15} />
            私密空间，仅属于你和你的另一半
          </div>
        </div>
        <span className="auth-legal">没有复杂的规则，只有认真对待彼此的小心意。</span>
      </section>
    </div>
  );
}

function Onboarding({
  bootstrap,
  busy,
  onAction,
  onCopy,
  onWechat,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: (path: string, body: unknown, message: string, method?: string) => Promise<boolean>;
  onCopy: (code: string) => Promise<void>;
  onWechat: () => Promise<void>;
}) {
  const [join, setJoin] = useState(false);
  return (
    <div className="onboard-shell">
      <header>
        <Brand />
        <Button
          busy={busy}
          className="ghost"
          onClick={() => onAction('/auth/logout', {}, '已退出登录')}
        >
          <LogOut size={16} />
          退出
        </Button>
      </header>
      <section className="onboard-card">
        <div className="onboard-art">
          <Heart size={44} fill="currentColor" />
          <span>+</span>
          <Heart size={44} fill="currentColor" />
        </div>
        <span className="eyebrow">TWO IS BETTER THAN ONE</span>
        <h1>{bootstrap.space ? '再等一个人，我们就完整了' : `你好，${bootstrap.user?.name}`}</h1>
        <p>
          {bootstrap.space
            ? '把邀请码分享给另一半，让日常从此多一份期待。'
            : '创建一个私密空间，或加入另一半的小世界。'}
        </p>
        {bootstrap.space ? (
          <>
            <div className="invite-box">
              <span>你们的专属邀请码</span>
              <strong>{bootstrap.space.inviteCode || '邀请码已失效'}</strong>
              {bootstrap.space.inviteExpiresAt && (
                <small>有效期至 {dateText(bootstrap.space.inviteExpiresAt, true)}</small>
              )}
            </div>
            <Button
              className="primary wide"
              disabled={!bootstrap.space.inviteCode}
              onClick={() => onCopy(bootstrap.space!.inviteCode!)}
            >
              <Copy size={17} />
              复制邀请码
            </Button>
            <div className="onboard-actions">
              <Button
                busy={busy}
                className="ghost"
                onClick={() => onAction('/spaces/invite', {}, '已生成新的邀请码')}
              >
                <RefreshCw size={15} />
                刷新邀请码
              </Button>
              <Button
                busy={busy}
                className="ghost"
                onClick={() => onAction('/bootstrap', undefined, '已检查配对状态', 'GET')}
              >
                <Check size={15} />
                对方已加入
              </Button>
            </div>
            <div className="form-hint">
              <ShieldCheck size={16} />
              另一半注册并输入邀请码后，两个人的任务和心愿小店就会开启。
            </div>
          </>
        ) : (
          <>
            <div className="auth-tabs">
              <button className={!join ? 'active' : ''} onClick={() => setJoin(false)}>
                创建我们的空间
              </button>
              <button className={join ? 'active' : ''} onClick={() => setJoin(true)}>
                我有邀请码
              </button>
            </div>
            <form
              className="form-stack"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                await onAction(
                  join ? '/spaces/join' : '/spaces',
                  join
                    ? { code: String(form.get('code')).trim() }
                    : { name: String(form.get('name')).trim() },
                  join ? '你们的小空间已经准备好啦' : '空间创建成功，把邀请码分享给对方吧',
                );
              }}
            >
              {join ? (
                <label>
                  另一半的邀请码
                  <input
                    name="code"
                    required
                    maxLength={32}
                    placeholder="输入收到的邀请码"
                    autoComplete="off"
                    className="code-input"
                  />
                </label>
              ) : (
                <label>
                  给你们的小世界取个名字
                  <input name="name" required maxLength={40} defaultValue="我们的小日子" />
                </label>
              )}
              <Button busy={busy} type="submit" className="primary wide">
                {join ? '加入我们的空间' : '创建空间，邀请另一半'}
                <ArrowRight size={17} />
              </Button>
            </form>
          </>
        )}
      </section>
      <div className="onboard-account panel">
        <WeChatAccountCard
          bootstrap={bootstrap}
          busy={busy}
          onAction={onAction}
          onWechat={onWechat}
        />
      </div>
      <p className="onboard-foot">好好在一起，从认真对待每一件小事开始。</p>
    </div>
  );
}
