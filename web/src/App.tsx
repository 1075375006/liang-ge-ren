import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Gift,
  Heart,
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
  X,
} from 'lucide-react';
import {
  Button,
  Empty,
  Modal,
  PageDoodle,
  ProductForm,
  TaskCard,
  TaskDetail,
  TaskForm,
} from './components';
import { AccountSecurity, PasswordRecovery } from './AccountSecurity';
import { PrivacyCenter, PrivacyPolicy } from './PrivacyCenter';
import { useWorkspaceData } from './useWorkspaceData';
import { WeChatAccountCard } from './WeChatAccountCard';
import { MailTemplatePicker } from './MailTemplatePicker';
import {
  api,
  dateText,
  orderStatus,
  personName,
  requestKey,
  type Bootstrap,
  type Order,
  type Page,
  type Product,
  type Schedule,
  type Task,
} from './types';

type ModalState =
  | { type: 'policy' }
  | { type: 'task-new'; scheduled?: boolean }
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
const navigation: { id: Page; label: string; icon: typeof Heart }[] = [
  { id: 'tasks', label: '约定', icon: ListChecks },
  { id: 'shop', label: '心愿', icon: Gift },
  { id: 'settings', label: '我们', icon: Heart },
];
const pageCopy: Record<Page, { title: string; subtitle: string }> = {
  tasks: { title: '约定', subtitle: '一起做好日常的小事。' },
  shop: { title: '心愿', subtitle: '把用心攒成喜欢的事。' },
  settings: { title: '我们', subtitle: '' },
  points: { title: '积分记录', subtitle: '' },
  orders: { title: '兑换记录', subtitle: '在这里兑现和确认彼此的心意。' },
  history: { title: '历史约定', subtitle: '完成、取消和到期的约定都在这里。' },
  schedules: { title: '定时计划', subtitle: '' },
  notifications: { title: '消息', subtitle: '' },
  account: { title: '账号设置', subtitle: '' },
  mail: { title: '邮件提醒', subtitle: '' },
};
function currentPage(): Page {
  const hash = location.hash.slice(1);
  return Object.hasOwn(pageCopy, hash) ? (hash as Page) : 'tasks';
}

export default function App() {
  const [recovery, setRecovery] = useState<string | null>(() =>
    location.hash.startsWith('#reset-password=')
      ? location.hash.slice('#reset-password='.length)
      : null,
  );
  const [inviteToken] = useState(() => new URLSearchParams(location.search).get('invite'));
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [legalOpen, setLegalOpen] = useState(false);
  const [page, setPage] = useState<Page>(currentPage);
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [taskFilter, setTaskFilter] = useState('current');
  const [orderFilter, setOrderFilter] = useState<'all' | 'actionable'>('all');
  const navigationVersion = useRef(0);
  const performingRef = useRef(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(6);
  const [pendingDestination, setPendingDestination] = useState(initialDestination);
  const [highlightedOrder, setHighlightedOrder] = useState<string | null>(null);
  const verifyAttempt = useRef(false);
  const wechatCallbackHandled = useRef(false);
  const [deepLinkedTask, setDeepLinkedTask] = useState<Task | null>(null);
  const [deepLinkedOrder, setDeepLinkedOrder] = useState<Order | null>(null);
  const {
    bootstrap,
    data,
    refresh,
    loadError,
    setLoadError,
    loadedDataFor,
    listLoading,
    loadMore,
    hasMore,
    loadingMore,
  } = useWorkspaceData({ page, taskFilter, orderFilter, search, busy, pendingDestination });
  const spaceKey =
    bootstrap?.user && bootstrap.space ? `${bootstrap.user.id}:${bootstrap.space.id}` : null;
  const spaceKeyRef = useRef(spaceKey);
  spaceKeyRef.current = spaceKey;
  useEffect(() => {
    ++navigationVersion.current;
    setDeepLinkedTask(null);
    setDeepLinkedOrder(null);
  }, [spaceKey]);
  const closeModal = useCallback(() => setModal(null), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 7500 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const perform = useCallback(
    async (path: string, body: unknown, message: string, method = 'POST') => {
      if (performingRef.current) return false;
      performingRef.current = true;
      setBusy(true);
      try {
        let result: { order?: Order };
        try {
          result = await api<{ order?: Order }>(path, method, body);
        } catch (error) {
          setToast({
            text: error instanceof Error ? error.message : '暂时没能完成，请再试一次',
            error: true,
          });
          await refresh().catch(() => {});
          return false;
        }
        if (result?.order) {
          const order = result.order;
          setDeepLinkedOrder((previous) => (previous?.id === order.id ? order : previous));
        }
        try {
          await refresh();
          setToast({ text: message });
        } catch {
          setToast({ text: `${message}。最新内容暂未读取成功，请稍后重试刷新。` });
        }
        return true;
      } finally {
        performingRef.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!inviteToken) return;
    void api<{ email: string; inviterName: string }>(
      `/spaces/email-invite/info?token=${encodeURIComponent(inviteToken)}`,
    )
      .then((data) => {
        setInviteEmail(data.email);
        setInviteName(data.inviterName);
      })
      .catch((error) => setToast({ text: error.message, error: true }));
  }, [inviteToken]);
  const inviteAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    const userId = bootstrap?.user?.id;
    if (!userId || !inviteToken || inviteAttemptedFor.current === userId) return;
    inviteAttemptedFor.current = userId;
    void perform(
      '/spaces/email-invite/accept',
      { token: inviteToken },
      '邀请已接受，请先确认你们的相处契约',
    ).then((success) => {
      if (!success) return;
      const url = new URL(location.href);
      url.searchParams.delete('invite');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    });
  }, [bootstrap?.user?.id, inviteToken, perform]);
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
        navigate(bootstrap.space && bootstrap.partner ? 'account' : 'tasks', true);
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
      if (bootstrap.space && bootstrap.partner) navigate('account', true);
    } else {
      setToast({
        text: messages[url.searchParams.get('reason') || ''] || '微信授权未能完成，请重新发起。',
        error: true,
      });
    }
    url.searchParams.delete('wechat');
    url.searchParams.delete('reason');
    history.replaceState(null, '', `${url.pathname}${url.search}${location.hash}`);
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
    navigate(
      pendingDestination.page === 'shop' && pendingDestination.orders
        ? 'orders'
        : pendingDestination.page,
      true,
    );
    setSearch('');
    const expectedSpace = spaceKey;
    const expectedNavigation = navigationVersion.current;
    if (pendingDestination.page === 'tasks' && pendingDestination.taskId) {
      const id = pendingDestination.taskId;
      void api<{ task: Task }>(`/tasks/${encodeURIComponent(id)}`)
        .then(({ task }) => {
          if (
            spaceKeyRef.current !== expectedSpace ||
            navigationVersion.current !== expectedNavigation
          )
            return;
          setDeepLinkedTask(task);
          setModal({ type: 'task', id: task.id });
        })
        .catch((error) => {
          if (
            spaceKeyRef.current === expectedSpace &&
            navigationVersion.current === expectedNavigation
          )
            setToast({ text: error.message, error: true });
        });
    } else if (pendingDestination.page === 'shop' && pendingDestination.orderId) {
      const id = pendingDestination.orderId;
      void api<{ order: Order }>(`/orders/${encodeURIComponent(id)}`)
        .then(({ order }) => {
          if (
            spaceKeyRef.current !== expectedSpace ||
            navigationVersion.current !== expectedNavigation
          )
            return;
          setDeepLinkedOrder(order);
          setHighlightedOrder(order.id);
        })
        .catch((error) => {
          if (
            spaceKeyRef.current === expectedSpace &&
            navigationVersion.current === expectedNavigation
          )
            setToast({ text: error.message, error: true });
        });
    }
    setPendingDestination(null);
    try {
      sessionStorage.removeItem(destinationStorageKey);
    } catch {
      // The in-memory destination has already been consumed.
    }
    const url = new URL(location.href);
    for (const key of ['page', 'task', 'tab', 'order']) url.searchParams.delete(key);
    history.replaceState(null, '', `${url.pathname}${url.search}${location.hash}`);
  }, [bootstrap, busy, loadedDataFor, pendingDestination, spaceKey]);
  useEffect(() => {
    if (!highlightedOrder || page !== 'orders') return;
    const row = document.getElementById(`order-${highlightedOrder}`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.focus({ preventScroll: true });
  }, [highlightedOrder, page, listLoading]);

  useEffect(() => {
    setVisibleCount(6);
  }, [page, taskFilter, orderFilter, search]);
  useEffect(() => {
    const restorePage = () => {
      ++navigationVersion.current;
      setRecovery(
        location.hash.startsWith('#reset-password=')
          ? location.hash.slice('#reset-password='.length)
          : null,
      );
      setPage(currentPage());
      setModal(null);
      setSearch('');
      setSearchOpen(false);
      setHighlightedOrder(null);
    };
    window.addEventListener('popstate', restorePage);
    return () => window.removeEventListener('popstate', restorePage);
  }, []);

  async function startWechat(intent: 'login' | 'bind') {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/auth/wechat/start', 'POST', {
        intent,
        acceptTerms: true,
      });
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

  function navigate(next: Page, replace = false) {
    ++navigationVersion.current;
    if (next === 'orders')
      setOrderFilter(
        !replace &&
          data.orders.some(
            (order) =>
              (order.status === 'PENDING' && order.sellerId === bootstrap?.user?.id) ||
              (order.status === 'FULFILLED' && order.buyerId === bootstrap?.user?.id),
          )
          ? 'actionable'
          : 'all',
      );
    if (location.hash !== `#${next}`) {
      if (replace) history.replaceState(null, '', `#${next}`);
      else history.pushState(null, '', `#${next}`);
    }
    setPage(next);
    setSearchOpen(false);
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
    (recovery === null &&
      pendingDestination &&
      bootstrap.user &&
      bootstrap.space &&
      bootstrap.partner &&
      !bootstrap.space.archivedAt &&
      !(bootstrap.requireVerifiedEmail && !bootstrap.user.emailVerified) &&
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
  if (recovery !== null)
    return (
      <PasswordRecovery
        key={recovery}
        token={recovery || undefined}
        smtpConfigured={bootstrap.smtpConfigured}
        onBack={async () => {
          history.replaceState(null, '', '/#tasks');
          setRecovery(null);
          setPage('tasks');
          await refresh();
        }}
      />
    );
  if (!bootstrap.user)
    return (
      <>
        <Auth
          busy={busy}
          bootstrap={bootstrap}
          onForgot={() => setRecovery('')}
          onPolicy={() => setLegalOpen(true)}
          wechatEnabled={bootstrap.wechatEnabled}
          onWechat={() => startWechat('login')}
          initialEmail={inviteEmail}
          inviteName={inviteName}
          onSubmit={async (path, body) => {
            await perform(path, body, '欢迎来到两个人');
          }}
        />
        {legalOpen && (
          <Modal title="隐私与使用说明" onClose={() => setLegalOpen(false)}>
            <PrivacyPolicy bootstrap={bootstrap} />
          </Modal>
        )}
        {toastView}
      </>
    );
  if (
    (!bootstrap.space || !bootstrap.partner) &&
    bootstrap.requireVerifiedEmail &&
    !bootstrap.user.emailVerified
  )
    return (
      <EmailVerificationGate
        bootstrap={bootstrap}
        busy={busy}
        onAction={perform}
        onWechat={() => startWechat('bind')}
        onRefresh={refresh}
        toast={toastView}
      />
    );
  if (bootstrap.space?.archivedAt)
    return <ArchivedSpace bootstrap={bootstrap} busy={busy} onAction={perform} toast={toastView} />;
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
  if (!bootstrap.contract.ready)
    return (
      <ContractGate
        bootstrap={bootstrap}
        busy={busy}
        onAccept={async () => {
          if (await perform('/contract/accept', {}, '已确认契约，等另一半确认后就可以开始啦'))
            await refresh();
        }}
        toast={toastView}
      />
    );
  if (bootstrap.requireVerifiedEmail && !bootstrap.user.emailVerified)
    return (
      <EmailVerificationGate
        bootstrap={bootstrap}
        busy={busy}
        onAction={perform}
        onWechat={() => startWechat('bind')}
        onRefresh={refresh}
        toast={toastView}
      />
    );

  const user = bootstrap.user,
    partner = bootstrap.partner;
  const unread = data.unreadCount;
  const myTasks = data.tasks.filter(
    (task) => task.claimantId === user.id && task.status === 'CLAIMED',
  );
  const reviewTasks = data.tasks.filter(
    (task) => task.status === 'SUBMITTED' && task.claimantId !== user.id,
  );
  const openTasks = data.tasks.filter(
    (task) =>
      task.status === 'OPEN' &&
      (task.mode === 'RACE' || task.mode === 'TOGETHER' || task.assignedTo === user.id),
  );
  const activeTab: Page = page === 'tasks' || page === 'shop' ? page : 'settings';
  const secondaryPage = !navigation.some((item) => item.id === page);
  const pendingOrders = data.orders.filter(
    (order) =>
      (order.status === 'PENDING' && order.sellerId === user.id) ||
      (order.status === 'FULFILLED' && order.buyerId === user.id),
  );
  const orderRecords =
    deepLinkedOrder &&
    highlightedOrder === deepLinkedOrder.id &&
    !data.orders.some((order) => order.id === deepLinkedOrder.id)
      ? [deepLinkedOrder, ...data.orders]
      : data.orders;
  const sortedOrders = [...orderRecords].sort(
    (a, b) => Number(pendingOrders.includes(b)) - Number(pendingOrders.includes(a)),
  );
  const orderLimit = Math.max(
    visibleCount,
    sortedOrders.findIndex((order) => order.id === highlightedOrder) + 1,
  );
  const taskPriority = (task: Task) =>
    reviewTasks.includes(task) ? 0 : myTasks.includes(task) ? 1 : openTasks.includes(task) ? 2 : 3;
  const visibleTasks = [...data.tasks].sort((a, b) =>
    page === 'history' ? 0 : taskPriority(a) - taskPriority(b),
  );
  const visibleProducts = data.products.filter(
    (product) => product.active || product.creatorId === user.id,
  );
  const selectedTask =
    modal?.type === 'task'
      ? (data.tasks.find((task) => task.id === modal.id) ??
        (deepLinkedTask?.id === modal.id ? deepLinkedTask : undefined))
      : undefined;
  const selectedProduct =
    modal?.type === 'product-edit' || modal?.type === 'redeem'
      ? data.products.find((product) => product.id === modal.id)
      : undefined;

  return (
    <div className="app-shell compact-app">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-caption">两个人，一起把日子过好。</div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
              aria-current={activeTab === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={20} strokeWidth={activeTab === item.id ? 2.2 : 1.7} />
              <span>{item.label}</span>
              {item.id === 'tasks' && bootstrap.stats.review > 0 && (
                <span className="nav-count">{bootstrap.stats.review}</span>
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
              onClick={() => navigate('notifications')}
            >
              <Bell size={20} />
              {unread > 0 && <span />}
            </button>
          </div>
        </header>
        <main>
          {secondaryPage && (
            <button className="back-link" onClick={() => navigate('settings')}>
              <ChevronLeft size={20} />
              我们
            </button>
          )}
          <div className="page-heading">
            <div>
              <h1>
                {pageCopy[page].title}
                {(page === 'tasks' || page === 'shop' || page === 'settings') && (
                  <PageDoodle kind={page} />
                )}
              </h1>
              {pageCopy[page].subtitle && <p>{pageCopy[page].subtitle}</p>}
            </div>
            {page === 'tasks' ? (
              <Button className="primary" onClick={() => setModal({ type: 'task-new' })}>
                <Plus size={18} />
                新建约定
              </Button>
            ) : page === 'shop' ? (
              <Button className="primary" onClick={() => setModal({ type: 'product-new' })}>
                <Plus size={18} />
                添加心愿
              </Button>
            ) : null}
          </div>

          {loadError && (
            <div className="inline-message warning connection-warning" role="alert">
              <span>{loadError}</span>
              <Button className="subtle small" onClick={() => void refresh().catch(() => {})}>
                重试
              </Button>
            </div>
          )}
          {listLoading && !['tasks', 'history'].includes(page) && (
            <div className="list-loading" role="status">
              <LoaderCircle className="spin" size={18} />
              正在读取…
            </div>
          )}
          <div className={listLoading ? 'workspace-view is-loading' : 'workspace-view'}>
            {(page === 'tasks' || page === 'history') && (
              <section className="panel page-panel">
                <div className="toolbar">
                  {page === 'tasks' && (
                    <div className="tabs" role="group" aria-label="约定筛选">
                      {[
                        ['current', '当前'],
                        ['mine', '我的'],
                        [
                          'review',
                          `待验收${bootstrap.stats.review ? ` ${bootstrap.stats.review}` : ''}`,
                        ],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          aria-pressed={taskFilter === key}
                          className={taskFilter === key ? 'active' : ''}
                          onClick={() => setTaskFilter(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className="icon-button search-toggle"
                    aria-label={searchOpen ? '收起搜索' : '搜索约定'}
                    aria-expanded={searchOpen}
                    onClick={() => {
                      setSearchOpen(!searchOpen);
                      setSearch('');
                    }}
                  >
                    {searchOpen ? <X size={19} /> : <Search size={19} />}
                  </button>
                  {searchOpen && (
                    <label className="search-field">
                      <Search size={17} />
                      <input
                        aria-label="搜索约定"
                        autoFocus
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="搜索约定"
                      />
                    </label>
                  )}
                </div>
                {listLoading ? (
                  <div className="list-loading" role="status">
                    <LoaderCircle className="spin" size={18} />
                    正在读取…
                  </div>
                ) : visibleTasks.length ? (
                  <div className="task-list full-task-list">
                    {visibleTasks.slice(0, visibleCount).map((task) => (
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
                        ? '没有找到相关约定'
                        : page === 'history'
                          ? '还没有历史约定'
                          : taskFilter === 'review'
                            ? '没有待验收的约定'
                            : taskFilter === 'mine'
                              ? '暂时没有你的约定'
                              : '现在没有待办约定'
                    }
                  >
                    {search
                      ? '换个关键词试试。'
                      : page === 'history'
                        ? '结束的约定会留在这里。'
                        : taskFilter === 'review'
                          ? '对方提交完成后，会出现在这里。'
                          : '一起散步，或为对方做一顿晚饭。'}
                    {!search && page !== 'history' && taskFilter !== 'review' && (
                      <Button className="subtle" onClick={() => setModal({ type: 'task-new' })}>
                        <Plus size={16} />
                        写下一个约定
                      </Button>
                    )}
                  </Empty>
                )}
                <MoreItems
                  shown={visibleCount}
                  total={visibleTasks.length}
                  onMore={() => setVisibleCount((count) => count + 6)}
                />
              </section>
            )}

            {page === 'shop' && (
              <>
                <div className="wish-balance">
                  <span>
                    <Sparkles size={17} />
                    可用积分
                  </span>
                  <strong>{bootstrap.balance}</strong>
                </div>
                {pendingOrders.length > 0 && (
                  <button className="action-reminder" onClick={() => navigate('orders')}>
                    <Gift size={18} />
                    <span>{pendingOrders.length} 份心愿等你处理</span>
                    <ChevronRight size={18} />
                  </button>
                )}
                {visibleProducts.length ? (
                  <section className="compact-wishes" aria-label="心愿列表">
                    {visibleProducts.slice(0, visibleCount).map((product) => (
                      <article className="wish-row" key={product.id}>
                        <span className="wish-symbol" aria-hidden="true">
                          {product.emoji}
                        </span>
                        <div className="wish-copy">
                          <h3>{product.title}</h3>
                          <p className="wish-meta">
                            <strong>{product.price} 积分</strong>
                            <span>
                              {!product.active
                                ? '已下架'
                                : product.stock === 0
                                  ? '已兑完'
                                  : bootstrap.balance < product.price
                                    ? `还差 ${product.price - bootstrap.balance} 分`
                                    : '可以兑换'}
                            </span>
                          </p>
                        </div>
                        <div className="wish-actions">
                          <Button
                            className="subtle small"
                            onClick={() =>
                              setModal({ type: 'redeem', id: product.id, key: requestKey() })
                            }
                          >
                            查看
                          </Button>
                          {product.creatorId === user.id && (
                            <button
                              className="icon-button"
                              aria-label={`管理心愿：${product.title}`}
                              onClick={() => setModal({ type: 'product-edit', id: product.id })}
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </section>
                ) : (
                  <section className="panel">
                    <Empty icon={<Gift size={28} />} title="放上第一份心愿">
                      一杯奶茶、一场电影，都值得期待。
                      <Button className="subtle" onClick={() => setModal({ type: 'product-new' })}>
                        <Plus size={17} />
                        添加心愿
                      </Button>
                    </Empty>
                  </section>
                )}
                <MoreItems
                  shown={visibleCount}
                  total={visibleProducts.length}
                  onMore={() => setVisibleCount((count) => count + 6)}
                />
              </>
            )}

            {page === 'settings' && (
              <div className="us-page">
                <section className="us-profile">
                  <div className="paired-avatars">
                    <span>{user.name.slice(0, 1)}</span>
                    <span>{partner.name.slice(0, 1)}</span>
                    <Heart size={12} />
                  </div>
                  <div>
                    <h2>{bootstrap.space.name}</h2>
                    <p>
                      {user.name} <span>与</span> {partner.name}
                    </p>
                  </div>
                </section>
                <button className="us-balance" onClick={() => navigate('points')}>
                  <Sparkles size={21} />
                  <span>我的积分</span>
                  <strong>{bootstrap.balance}</strong>
                  <ChevronRight size={18} />
                </button>
                <div className="settings-menu" role="group" aria-label="我们的记录">
                  <SettingsLink
                    icon={ShoppingBag}
                    label="兑换记录"
                    value={
                      pendingOrders.length
                        ? `${pendingOrders.length}${pendingOrders.length >= 60 ? '+' : ''} 待处理`
                        : undefined
                    }
                    onClick={() => navigate('orders')}
                  />
                  <SettingsLink
                    icon={ListChecks}
                    label="历史约定"
                    onClick={() => navigate('history')}
                  />
                  <SettingsLink
                    icon={CalendarDays}
                    label="定时计划"
                    onClick={() => navigate('schedules')}
                  />
                </div>
                <div className="settings-menu" role="group" aria-label="消息与设置">
                  <SettingsLink
                    icon={Bell}
                    label="消息"
                    value={unread ? `${unread} 未读` : undefined}
                    onClick={() => navigate('notifications')}
                  />
                  <SettingsLink
                    icon={Settings}
                    label="账号设置"
                    onClick={() => navigate('account')}
                  />
                  <SettingsLink
                    icon={Mail}
                    label="邮件提醒"
                    value={user.notifyEmail ? '已开启' : '已关闭'}
                    onClick={() => navigate('mail')}
                  />
                </div>
              </div>
            )}

            {page === 'orders' && (
              <section className="panel orders-panel">
                <div className="toolbar">
                  <div className="tabs" role="group" aria-label="兑换筛选">
                    {(
                      [
                        ['actionable', '待我处理'],
                        ['all', '全部记录'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        className={orderFilter === value ? 'active' : ''}
                        aria-pressed={orderFilter === value}
                        onClick={() => {
                          setOrderFilter(value);
                          setHighlightedOrder(null);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {sortedOrders.length ? (
                  sortedOrders.slice(0, orderLimit).map((order) => (
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
                  <Empty
                    icon={<ShoppingBag size={28} />}
                    title={
                      orderFilter === 'actionable' ? '暂时没有需要处理的兑换' : '还没有兑换记录'
                    }
                  >
                    完成小约定赚取积分，再来兑换一份专属心意。
                    <Button className="subtle" onClick={() => navigate('shop')}>
                      去心愿架看看 <ArrowRight size={16} />
                    </Button>
                  </Empty>
                )}
                <MoreItems
                  shown={orderLimit}
                  total={sortedOrders.length}
                  onMore={() => setVisibleCount(orderLimit + 6)}
                />
              </section>
            )}
            {page === 'points' && (
              <>
                <div className="balance-summary">
                  <span>可用积分</span>
                  <strong>
                    {bootstrap.balance}
                    <small> 积分</small>
                  </strong>
                </div>
                <section className="panel ledger-panel">
                  <div className="section-heading">
                    <div>
                      <h2>收支记录</h2>
                    </div>
                    <span className="muted">仅展示我的积分</span>
                  </div>
                  {data.entries.length ? (
                    data.entries.slice(0, visibleCount).map((entry) => (
                      <div className="ledger-row" key={entry.id}>
                        <span className={`ledger-icon ${entry.delta > 0 ? 'sage' : 'rose'}`}>
                          {entry.delta > 0 ? (
                            <ArrowDownLeft size={20} />
                          ) : (
                            <ArrowUpRight size={20} />
                          )}
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
                  <MoreItems
                    shown={visibleCount}
                    total={data.entries.length}
                    onMore={() => setVisibleCount((count) => count + 6)}
                  />
                  <div className="panel-footer">
                    <ShieldCheck size={14} />
                    积分来自任务奖励，可用于兑换；取消待兑现的订单会自动退款。
                  </div>
                </section>
              </>
            )}

            {page === 'account' && (
              <section className="panel settings-panel">
                <AccountSecurity bootstrap={bootstrap} busy={busy} onAction={perform} />
                <WeChatAccountCard
                  bootstrap={bootstrap}
                  busy={busy}
                  onAction={perform}
                  onWechat={() => startWechat('bind')}
                />
                <PrivacyCenter bootstrap={bootstrap} busy={busy} onAction={perform} />
                <Button
                  busy={busy}
                  className="ghost wide logout-button"
                  onClick={async () => {
                    if (await perform('/auth/logout', {}, '已安全退出')) {
                      navigate('tasks');
                      setModal(null);
                    }
                  }}
                >
                  <LogOut size={16} />
                  退出登录
                </Button>
              </section>
            )}
            {page === 'mail' && (
              <section className="panel settings-panel">
                <div className="section-heading">
                  <h2>
                    <Mail size={20} />
                    邮件提醒
                  </h2>
                </div>
                <p className="settings-description">通过邮件接收约定和兑换进展。</p>
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
                {!!data.mail?.counts.failed && (
                  <Button
                    busy={busy}
                    className="subtle wide"
                    onClick={() => perform('/mail/retry', {}, '失败邮件已重新加入发送队列')}
                  >
                    <RefreshCw size={16} /> 重试 {data.mail.counts.failed} 封未发送的邮件
                  </Button>
                )}
                <details className="form-options">
                  <summary>
                    邮件外观 <ChevronRight size={17} />
                  </summary>
                  <div className="form-options-body">
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
                  </div>
                </details>
              </section>
            )}
            {page === 'schedules' && (
              <section className="panel settings-panel wide-panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      <CalendarDays size={20} />
                      定时计划
                    </h2>
                  </div>
                  <Button
                    className="subtle small"
                    onClick={() => setModal({ type: 'task-new', scheduled: true })}
                  >
                    <Plus size={16} />
                    新建计划
                  </Button>
                </div>
                {data.schedules.length ? (
                  data.schedules.slice(0, visibleCount).map((schedule) => (
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
                <MoreItems
                  shown={visibleCount}
                  total={data.schedules.length}
                  onMore={() => setVisibleCount((count) => count + 6)}
                />
                <div className="form-hint">
                  <CalendarDays size={14} />
                  日程固定使用北京时间，暂停只影响未来的发布。
                </div>
              </section>
            )}
            {page === 'notifications' && (
              <section className="panel settings-panel wide-panel" id="notifications">
                <div className="section-heading">
                  <div>
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
                  data.notifications.slice(0, visibleCount).map((notice) => (
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
                <MoreItems
                  shown={visibleCount}
                  total={data.notifications.length}
                  onMore={() => setVisibleCount((count) => count + 6)}
                />
              </section>
            )}
            {hasMore &&
              (page === 'orders' ? orderLimit : visibleCount) >=
                (page === 'tasks' || page === 'history'
                  ? visibleTasks.length
                  : page === 'shop'
                    ? visibleProducts.length
                    : page === 'orders'
                      ? data.orders.length
                      : page === 'points'
                        ? data.entries.length
                        : page === 'schedules'
                          ? data.schedules.length
                          : data.notifications.length) && (
                <Button
                  className="subtle wide list-continue"
                  busy={loadingMore}
                  onClick={async () => {
                    await loadMore();
                    setVisibleCount((count) => count + 6);
                  }}
                >
                  加载更早的记录
                </Button>
              )}
          </div>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="手机主导航">
        {navigation.map((item) => (
          <button
            key={item.id}
            className={activeTab === item.id ? 'active' : ''}
            aria-current={activeTab === item.id ? 'page' : undefined}
            onClick={() => navigate(item.id)}
          >
            <item.icon size={21} />
            <span>{item.label}</span>
            {((item.id === 'tasks' && bootstrap.stats.review > 0) ||
              (item.id === 'settings' && (unread > 0 || pendingOrders.length > 0))) && <i />}
          </button>
        ))}
      </nav>

      {modal?.type === 'task-new' && (
        <Modal title={modal.scheduled ? '新建计划' : '新建约定'} onClose={closeModal}>
          <TaskForm
            scheduled={modal.scheduled}
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
        <Modal title={modal.type === 'product-new' ? '添加心愿' : '管理心愿'} onClose={closeModal}>
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
                navigate('shop');
              }
            }}
          />
          {modal.type === 'product-edit' && selectedProduct && (
            <Button
              busy={busy}
              className="ghost wide"
              onClick={async () => {
                if (
                  await perform(
                    `/products/${selectedProduct.id}`,
                    { active: !selectedProduct.active },
                    selectedProduct.active ? '心愿已下架' : '心愿已上架',
                    'PATCH',
                  )
                )
                  closeModal();
              }}
            >
              {selectedProduct.active ? '下架这个心愿' : '重新上架'}
            </Button>
          )}
        </Modal>
      )}
      {modal?.type === 'redeem' && selectedProduct && (
        <Modal title="兑换心愿" onClose={closeModal}>
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
            待兑现时取消，积分会退回。
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
                navigate('orders');
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

function MoreItems({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <button className="list-more" onClick={onMore}>
      再看 {Math.min(6, total - shown)} 条 <ChevronDown size={16} />
    </button>
  );
}
function SettingsLink({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: typeof Heart;
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <button className="settings-link" onClick={onClick}>
      <Icon size={20} />
      <span>{label}</span>
      {value && <span className="menu-value">{value}</span>}
      <ChevronRight size={17} />
    </button>
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
  bootstrap,
  onForgot,
  onPolicy,
  busy,
  wechatEnabled,
  onWechat,
  initialEmail,
  inviteName,
  onSubmit,
}: {
  busy: boolean;
  wechatEnabled: boolean;
  onWechat: () => Promise<void>;
  initialEmail?: string;
  inviteName?: string;
  onSubmit: (path: string, body: unknown) => Promise<void>;
  bootstrap: Bootstrap;
  onForgot: () => void;
  onPolicy: () => void;
}) {
  const [register, setRegister] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [email, setEmail] = useState(initialEmail ?? '');
  useEffect(() => {
    if (initialEmail && !email) setEmail(initialEmail);
  }, [email, initialEmail]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await onSubmit(register ? '/auth/register' : '/auth/login', {
      ...(register ? { name: String(values.get('name')).trim(), acceptTerms: accepted } : {}),
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
          {inviteName && (
            <p className="account-hint invite-hint">
              {inviteName} 邀请你加入，登录或注册后就会进入相处契约。
            </p>
          )}
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
                value={email}
                onChange={(event) => setEmail(event.target.value)}
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
            {register && (
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                  required
                />
                <span>
                  我已满 18 岁，并同意
                  <button type="button" className="text-link" onClick={onPolicy}>
                    使用条款与隐私说明
                  </button>
                </span>
              </label>
            )}
            <Button
              className="primary wide"
              type="submit"
              busy={busy}
              disabled={register && bootstrap.registrationOpen === false}
            >
              {register ? '创建我的账号' : '进入我们的小空间'}
              <ArrowRight size={18} />
            </Button>
          </form>
          {!register && (
            <button className="text-link forgot-link" onClick={onForgot}>
              忘记密码？
            </button>
          )}
          {register && bootstrap.registrationOpen === false && (
            <p className="account-hint" role="status">
              本站暂时关闭新账号注册，请稍后再来。
            </p>
          )}
          {wechatEnabled && (
            <div className="auth-wechat">
              <div className="auth-divider">
                <span>也可以用微信进入</span>
              </div>
              {wechatEnabled && !register && (
                <label className="consent-row">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => setAccepted(event.target.checked)}
                  />
                  <span>
                    微信登录前请同意
                    <button type="button" className="text-link" onClick={onPolicy}>
                      使用条款与隐私说明
                    </button>
                  </span>
                </label>
              )}
              <Button
                className="wechat-button wide"
                busy={busy}
                disabled={!wechatEnabled || !accepted}
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
          )}
          <div className="auth-privacy">
            <ShieldCheck size={15} />
            <button onClick={onPolicy}>隐私与使用说明</button>
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
            <form
              className="email-invite-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                if (
                  await onAction(
                    '/spaces/email-invite',
                    { email: String(form.get('email')).trim() },
                    '邀请邮件已发送，请让对方从邮件链接进入',
                  )
                )
                  event.currentTarget.reset();
              }}
            >
              <label>
                直接发到对方邮箱
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  placeholder="partner@example.com"
                  autoComplete="email"
                />
              </label>
              <Button busy={busy} className="primary wide" type="submit">
                <Mail size={17} />
                发送邀请链接
              </Button>
            </form>
            <div className="form-hint">
              <ShieldCheck size={16} />
              邀请链接会带对方进入注册、登录和契约确认，完成后你们就可以开始啦。
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
        <AccountSecurity bootstrap={bootstrap} busy={busy} onAction={onAction} />
        <PrivacyCenter bootstrap={bootstrap} busy={busy} onAction={onAction} />
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

function ContractGate({
  bootstrap,
  busy,
  onAccept,
  toast,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAccept: () => Promise<void>;
  toast: React.ReactNode;
}) {
  return (
    <div className="onboard-shell contract-gate">
      <Brand />
      <section className="onboard-card">
        <div className="onboard-art">
          <Heart size={42} fill="currentColor" />
          <span>♡</span>
          <Heart size={42} fill="currentColor" />
        </div>
        <span className="eyebrow">A PROMISE FOR TWO</span>
        <h1>开始之前，先确认你们的契约</h1>
        <p>这是只属于你们两个人的约定。双方都确认后，任务、积分和心愿小店才会开启。</p>
        <article className="contract-text">
          <h2>两个人的相处契约</h2>
          <p>{bootstrap.contract.text}</p>
        </article>
        <div className="contract-status">
          <span className={bootstrap.contract.myAccepted ? 'done' : ''}>
            {bootstrap.contract.myAccepted ? '✓ 我已确认' : '○ 等我确认'}
          </span>
          <Heart size={16} fill="currentColor" />
          <span className={bootstrap.contract.partnerAccepted ? 'done' : ''}>
            {bootstrap.contract.partnerAccepted ? '✓ 另一半已确认' : '○ 等另一半确认'}
          </span>
        </div>
        <Button
          className="primary wide"
          busy={busy}
          disabled={bootstrap.contract.myAccepted}
          onClick={() => void onAccept()}
        >
          {bootstrap.contract.myAccepted ? '已确认，等另一半' : '我已阅读并确认'}
        </Button>
        <p className="form-hint">
          <ShieldCheck size={15} />
          可以诚实沟通、一起调整，但不要敷衍对方的心意。
        </p>
      </section>
      {toast}
    </div>
  );
}

function EmailVerificationGate({
  bootstrap,
  busy,
  onAction,
  onWechat,
  onRefresh,
  toast,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: (path: string, body: unknown, message: string, method?: string) => Promise<boolean>;
  onWechat: () => Promise<void>;
  onRefresh: () => Promise<unknown>;
  toast: React.ReactNode;
}) {
  return (
    <div className="onboard-shell">
      <Brand />
      <section className="onboard-card">
        <h1>先确认这是你的邮箱</h1>
        <p>
          验证邮箱后，就能创建或加入两个人的空间。
          {bootstrap.user?.email
            ? '注册验证邮件已发送，请查收收件箱与垃圾邮件。'
            : '请先补充邮箱，我们会发送验证链接。'}
        </p>
        <WeChatAccountCard
          bootstrap={bootstrap}
          busy={busy}
          onAction={onAction}
          onWechat={onWechat}
        />
        <Button className="primary wide" onClick={() => void onRefresh().catch(() => undefined)}>
          我已验证，继续
        </Button>
        <Button
          className="ghost wide"
          busy={busy}
          onClick={() => onAction('/auth/logout', {}, '已退出登录')}
        >
          退出登录
        </Button>
      </section>
      {toast}
    </div>
  );
}

function ArchivedSpace({
  bootstrap,
  busy,
  onAction,
  toast,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: (path: string, body: unknown, message: string, method?: string) => Promise<boolean>;
  toast: React.ReactNode;
}) {
  return (
    <div className="onboard-shell">
      <Brand />
      <section className="onboard-card">
        <h1>这个空间已关闭</h1>
        <p>
          空间已由成员关闭，或其中一位成员已注销。共同历史仍可导出；待兑现的兑换已退回，已兑现的记录保留原结果。
        </p>
        <PrivacyCenter bootstrap={bootstrap} busy={busy} onAction={onAction} />
        <details className="form-options">
          <summary>离开旧空间，重新开始</summary>
          <form
            className="form-stack form-options-body"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              await onAction(
                '/spaces/leave-archived',
                { confirmation: form.get('confirmation') },
                '已离开旧空间，可以重新配对',
              );
            }}
          >
            <p>请先导出数据。离开后旧空间积分会结算清零，无法再访问旧空间；新空间从 0 积分开始。</p>
            <label>
              输入“离开空间”确认
              <input name="confirmation" pattern="离开空间" required />
            </label>
            <Button type="submit" className="primary wide" busy={busy}>
              确认离开旧空间
            </Button>
          </form>
        </details>
        <Button className="ghost wide" onClick={() => onAction('/auth/logout', {}, '已退出登录')}>
          退出登录
        </Button>
      </section>
      {toast}
    </div>
  );
}
