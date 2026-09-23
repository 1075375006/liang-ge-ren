import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  Eye,
  EyeOff,
  Heart,
  Inbox,
  KeyRound,
  LogOut,
  Mail,
  MessageCircle,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';

type AdminMode = 'checking' | 'login' | 'setup' | 'app';

type AdminStatus = {
  configured?: boolean;
  setupRequired?: boolean;
  authenticated?: boolean;
  adminName?: string | null;
  username?: string | null;
  version?: string | null;
};

type Overview = {
  overview?: {
    users?: number;
    activeUsers?: number;
    spaces?: number;
    activeSpaces?: number;
    tasks?: number;
    completedTasks?: number;
    orders?: number;
    completedOrders?: number;
  };
  users?: Array<{
    id: string;
    name: string;
    email?: string | null;
    createdAt?: string;
    spaceName?: string | null;
  }>;
  spaces?: Array<{
    id: string;
    name: string;
    members?: number;
    createdAt?: string;
    archivedAt?: string | null;
  }>;
  queue?: { pending?: number; sending?: number; sent?: number; failed?: number };
  worker?: {
    healthy?: boolean;
    lastSeenAt?: string | null;
    lastError?: string | null;
    processedAt?: string | null;
  };
  smtp?: {
    configured?: boolean;
    host?: string | null;
    port?: number | null;
    secure?: boolean;
    requireTLS?: boolean;
    user?: string | null;
    from?: string | null;
  };
  wechat?: { enabled?: boolean; appId?: string | null; appKeyConfigured?: boolean };
};

type SmtpForm = {
  host: string;
  port: string;
  secure: boolean;
  requireTLS: boolean;
  user: string;
  pass: string;
  from: string;
};

type WechatForm = { enabled: boolean; appId: string; appKey: string };
type AccountForm = {
  username: string;
  currentPassword: string;
  password: string;
  confirm: string;
};

const emptySmtp: SmtpForm = {
  host: '',
  port: '587',
  secure: false,
  requireTLS: true,
  user: '',
  pass: '',
  from: '',
};
const emptyWechat: WechatForm = { enabled: false, appId: '', appKey: '' };
const emptyAccount: AccountForm = { username: '', currentPassword: '', password: '', confirm: '' };

async function adminApi<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '暂时无法完成，请稍后重试');
    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请检查网络后重试');
    if (error instanceof TypeError) throw new Error('网络连接中断，请稍后重试');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function valueOf<T>(value: T | null | undefined, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

function dateText(value?: string | null) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

function Mark() {
  return (
    <div className="admin-mark" aria-hidden="true">
      <Heart size={20} fill="currentColor" />
      <Check size={12} strokeWidth={3} />
    </div>
  );
}

function Button({
  children,
  variant = 'primary',
  busy = false,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'soft' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      className={`admin-button admin-${variant} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy && <RefreshCw className="admin-spin" size={15} />}
      {children}
    </button>
  );
}

function Card({
  title,
  icon: Icon,
  children,
  className = '',
  action,
}: {
  title: string;
  icon: typeof Heart;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`admin-card ${className}`}>
      <div className="admin-card-title">
        <span className="admin-card-heading">
          <Icon size={17} />
          {title}
        </span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="admin-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="admin-switch" aria-hidden="true">
        <i />
      </span>
      <span>{label}</span>
    </label>
  );
}

function Metric({
  label,
  value,
  tone = 'rose',
  note,
}: {
  label: string;
  value: number | string;
  tone?: string;
  note?: string;
}) {
  return (
    <div className={`admin-metric admin-metric-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {note && <span>{note}</span>}
    </div>
  );
}

function Login({
  setup,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  setup: boolean;
  busy: boolean;
  error: string;
  onSubmit: (values: {
    username: string;
    password: string;
    bootstrapToken?: string;
  }) => Promise<void>;
  onBack?: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError('');
    if (setup && password !== confirm) {
      setLocalError('两次密码不一致，再检查一下吧');
      return;
    }
    await onSubmit({
      username: username.trim(),
      password,
      ...(bootstrapToken ? { bootstrapToken } : {}),
    });
  }
  return (
    <main className="admin-auth-shell">
      <div className="admin-auth-card">
        <div className="admin-auth-brand">
          <Mark />
          <span>
            两个人<span>。</span>
          </span>
        </div>
        <span className="admin-eyebrow">PRIVATE LITTLE WORLD</span>
        <h1>{setup ? '先设置管理员账号' : '欢迎回来，管理员'}</h1>
        <p className="admin-auth-copy">
          {setup
            ? '只需要设置一次，之后从这里管理你们的小空间。'
            : '登录后查看运行状态，管理邮件和微信登录。'}
        </p>
        <form className="admin-form" onSubmit={submit}>
          <Field label="管理员账号">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="例如 admin"
              required
              minLength={3}
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}"
            />
          </Field>
          <Field
            label={setup ? '设置密码' : '管理员密码'}
            hint={setup ? '至少 8 位，建议使用专用密码。' : undefined}
          >
            <div className="admin-password-input">
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete={setup ? 'new-password' : 'current-password'}
                minLength={setup ? 8 : 1}
                maxLength={128}
                required
                placeholder="输入密码"
              />
              <button
                type="button"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </Field>
          {setup && (
            <Field label="再输入一次密码">
              <input
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
                placeholder="确认管理员密码"
              />
            </Field>
          )}
          {setup && (
            <Field
              label="初始化令牌（可选）"
              hint="如果部署时设置了 ADMIN_BOOTSTRAP_TOKEN，请在这里填写。"
            >
              <input
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
                type="password"
                autoComplete="off"
                maxLength={512}
                placeholder="未设置时可留空"
              />
            </Field>
          )}
          {(error || localError) && (
            <p className="admin-error" role="alert">
              <CircleAlert size={15} />
              {error || localError}
            </p>
          )}
          <Button type="submit" busy={busy} className="admin-wide">
            {setup ? '完成设置' : '进入后台'}
            <ArrowRight size={17} />
          </Button>
        </form>
        {setup && (
          <p className="admin-security-note">
            <ShieldCheck size={15} />
            设置完成后请保存好管理员密码，项目不会显示或导出它。
          </p>
        )}
        {onBack && (
          <button className="admin-back" onClick={onBack}>
            返回登录
          </button>
        )}
      </div>
      <p className="admin-auth-foot">
        <Sparkles size={14} />
        认真管理每一件小事，空间才会一直轻盈。
      </p>
    </main>
  );
}

export default function Admin() {
  const [mode, setMode] = useState<AdminMode>('checking');
  const [status, setStatus] = useState<AdminStatus>({});
  const [snapshot, setSnapshot] = useState<Overview>({});
  const [smtp, setSmtp] = useState<SmtpForm>(emptySmtp);
  const [wechat, setWechat] = useState<WechatForm>(emptyWechat);
  const [account, setAccount] = useState<AccountForm>(emptyAccount);
  const [busy, setBusy] = useState(false);
  const [sectionBusy, setSectionBusy] = useState<'account' | 'smtp' | 'wechat' | 'queue' | null>(
    null,
  );
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [authError, setAuthError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const notify = useCallback((text: string, error = false) => {
    setMessage({ text, error });
    window.setTimeout(
      () => setMessage((current) => (current?.text === text ? null : current)),
      error ? 6_000 : 3_500,
    );
  }, []);

  const applySnapshot = useCallback((data: Overview) => {
    setSnapshot(data || {});
    const mail = data.smtp || {};
    setSmtp((current) => ({
      ...current,
      host: valueOf(mail.host, current.host),
      port: String(mail.port ?? (current.port || '587')),
      secure: valueOf(mail.secure, current.secure),
      requireTLS: valueOf(mail.requireTLS, current.requireTLS),
      user: valueOf(mail.user, current.user),
      from: valueOf(mail.from, current.from),
      pass: '',
    }));
    const wx = data.wechat || {};
    setWechat((current) => ({
      ...current,
      enabled: valueOf(wx.enabled, current.enabled),
      appId: valueOf(wx.appId, current.appId),
      appKey: '',
    }));
    setLastUpdated(new Date().toISOString());
  }, []);

  const refreshData = useCallback(
    async (quiet = false) => {
      try {
        const data = await adminApi<Overview>('/overview');
        applySnapshot(data);
        if (!quiet) notify('数据已更新');
      } catch (error) {
        if (!quiet) notify(error instanceof Error ? error.message : '刷新失败，请稍后重试', true);
        throw error;
      }
    },
    [applySnapshot, notify],
  );

  useEffect(() => {
    let active = true;
    adminApi<AdminStatus>('/status')
      .then((data) => {
        if (!active) return;
        setStatus(data || {});
        if (data.authenticated) {
          setMode('app');
          void refreshData(true).catch(() => {});
        } else if (data.setupRequired || data.configured === false) setMode('setup');
        else setMode('login');
      })
      .catch((error) => {
        if (!active) return;
        setAuthError(error instanceof Error ? error.message : '后台暂时无法打开');
        setMode('login');
      });
    return () => {
      active = false;
    };
  }, [refreshData]);

  async function submitAuth(values: {
    username: string;
    password: string;
    bootstrapToken?: string;
  }) {
    setBusy(true);
    setAuthError('');
    try {
      const path = mode === 'setup' ? '/setup' : '/login';
      const data = await adminApi<AdminStatus>(path, 'POST', values);
      setStatus((current) => ({ ...current, ...data, authenticated: true }));
      setAccount((current) => ({ ...current, username: values.username }));
      setMode('app');
      await refreshData(true);
      notify(mode === 'setup' ? '管理员账号已设置' : '登录成功');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败，请检查账号和密码');
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(kind: 'smtp' | 'wechat') {
    setSectionBusy(kind);
    try {
      if (kind === 'smtp') {
        const body: Record<string, unknown> = { ...smtp, port: Number(smtp.port) || 587 };
        if (!body.pass) delete body.pass;
        await adminApi('/settings/smtp', 'PATCH', body);
        setSmtp((current) => ({ ...current, pass: '' }));
        notify('邮件设置已保存');
      } else {
        const body = { ...wechat };
        if (!body.appKey) delete (body as Partial<WechatForm>).appKey;
        await adminApi('/settings/wechat', 'PATCH', body);
        setWechat((current) => ({ ...current, appKey: '' }));
        notify('微信登录设置已保存');
      }
      await refreshData(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存失败，请稍后重试', true);
    } finally {
      setSectionBusy(null);
    }
  }

  async function saveAccount() {
    if (account.password && account.password !== account.confirm) {
      notify('两次新密码不一致', true);
      return;
    }
    setSectionBusy('account');
    try {
      const body: Record<string, unknown> = {
        username: account.username.trim(),
        currentPassword: account.currentPassword,
      };
      if (account.password) body.password = account.password;
      const data = await adminApi<{ admin: { username: string } }>('/account', 'PATCH', body);
      setStatus((current) => ({
        ...current,
        username: data.admin.username,
        adminName: data.admin.username,
      }));
      setAccount({ ...emptyAccount, username: data.admin.username });
      notify('后台账号已更新');
    } catch (error) {
      notify(error instanceof Error ? error.message : '账号更新失败，请稍后重试', true);
    } finally {
      setSectionBusy(null);
    }
  }

  async function retryQueue() {
    setSectionBusy('queue');
    try {
      await adminApi('/queue/retry', 'POST');
      notify('失败邮件已重新排队');
      await refreshData(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : '重新排队失败', true);
    } finally {
      setSectionBusy(null);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await adminApi('/logout', 'POST');
      setMode('login');
      setStatus({});
      setSnapshot({});
      notify('已安全退出');
    } catch (error) {
      notify(error instanceof Error ? error.message : '退出失败，请重试', true);
    } finally {
      setBusy(false);
    }
  }

  const overview = snapshot.overview || {};
  const queue = snapshot.queue || {};
  const worker = snapshot.worker || {};
  const smtpConfigured = Boolean(snapshot.smtp?.configured);
  const wechatConfigured = Boolean(snapshot.wechat?.appKeyConfigured || snapshot.wechat?.appId);
  const workerLabel = worker.healthy ? '运行正常' : worker.lastError ? '需要处理' : '等待心跳';
  const workerTone = worker.healthy ? 'good' : worker.lastError ? 'bad' : 'idle';

  const page = useMemo(() => {
    if (mode === 'checking')
      return (
        <main className="admin-loading">
          <RefreshCw className="admin-spin" size={22} />
          <p>正在打开后台…</p>
        </main>
      );
    if (mode === 'login' || mode === 'setup')
      return (
        <Login
          setup={mode === 'setup'}
          busy={busy}
          error={authError}
          onSubmit={submitAuth}
          onBack={
            mode === 'setup' && status.configured !== false
              ? () => {
                  setMode('login');
                  setAuthError('');
                }
              : undefined
          }
        />
      );
    return (
      <main className="admin-shell">
        <header className="admin-header">
          <div className="admin-brand">
            <Mark />
            <div>
              <strong>
                两个人<span>。</span>
              </strong>
              <small>管理后台</small>
            </div>
          </div>
          <div className="admin-header-actions">
            <span className="admin-user">
              <ShieldCheck size={15} />
              {status.adminName || status.username || '管理员'}
            </span>
            <Button variant="ghost" onClick={logout} busy={busy}>
              <LogOut size={16} />
              退出
            </Button>
          </div>
        </header>
        <div className="admin-content">
          <div className="admin-page-intro">
            <div>
              <span className="admin-eyebrow">GOOD MORNING, ADMIN</span>
              <h1>小空间，轻松管理。</h1>
              <p>看一眼状态，处理需要你关心的设置。</p>
            </div>
            <Button variant="soft" onClick={() => void refreshData()}>
              <RefreshCw size={16} />
              刷新数据
            </Button>
          </div>
          {message && (
            <div className={`admin-toast ${message.error ? 'is-error' : ''}`} role="status">
              {message.error ? <CircleAlert size={16} /> : <Check size={16} />}
              {message.text}
              <button aria-label="关闭提示" onClick={() => setMessage(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          <div className="admin-metrics">
            <Metric
              label="注册用户"
              value={valueOf(overview.users, 0)}
              tone="rose"
              note={
                overview.activeUsers !== undefined
                  ? `${overview.activeUsers} 位近期活跃`
                  : undefined
              }
            />
            <Metric
              label="情侣空间"
              value={valueOf(overview.spaces, 0)}
              tone="peach"
              note={
                overview.activeSpaces !== undefined
                  ? `${overview.activeSpaces} 个进行中`
                  : undefined
              }
            />
            <Metric
              label="已完成约定"
              value={valueOf(overview.completedTasks, 0)}
              tone="mint"
              note={overview.tasks !== undefined ? `共 ${overview.tasks} 个约定` : undefined}
            />
            <Metric
              label="已完成心愿"
              value={valueOf(overview.completedOrders, 0)}
              tone="blue"
              note={overview.orders !== undefined ? `共 ${overview.orders} 笔兑换` : undefined}
            />
          </div>
          <div className="admin-grid admin-grid-top">
            <Card
              title="邮件服务"
              icon={Mail}
              action={
                <span className={`admin-pill ${smtpConfigured ? 'good' : 'idle'}`}>
                  {smtpConfigured ? '已配置' : '未配置'}
                </span>
              }
            >
              <div className="admin-status-row">
                <span className="admin-status-icon">
                  <Mail size={19} />
                </span>
                <div>
                  <strong>{smtpConfigured ? '邮件提醒可以正常工作' : '还没有配置邮件'}</strong>
                  <small>
                    {smtpConfigured
                      ? `${smtp.host || 'SMTP'} · ${smtp.from || '发件地址未设置'}`
                      : '保存 SMTP 后，验证和提醒邮件才会发出'}
                  </small>
                </div>
              </div>
              <div className="admin-queue-mini">
                <span>
                  待发送 <b>{valueOf(queue.pending, 0)}</b>
                </span>
                <span>
                  发送中 <b>{valueOf(queue.sending, 0)}</b>
                </span>
                <span>
                  失败{' '}
                  <b className={queue.failed ? 'admin-danger-text' : ''}>
                    {valueOf(queue.failed, 0)}
                  </b>
                </span>
              </div>
            </Card>
            <Card
              title="后台任务"
              icon={Activity}
              action={<span className={`admin-pill ${workerTone}`}>{workerLabel}</span>}
            >
              <div className="admin-status-row">
                <span className="admin-status-icon admin-status-mint">
                  <Activity size={19} />
                </span>
                <div>
                  <strong>{worker.healthy ? '邮件 worker 正在运行' : '还没有收到最新心跳'}</strong>
                  <small>上次心跳：{dateText(worker.lastSeenAt)}</small>
                </div>
              </div>
              {worker.lastError && (
                <p className="admin-inline-error">
                  <CircleAlert size={14} />
                  {worker.lastError}
                </p>
              )}
            </Card>
          </div>
          <div className="admin-grid admin-grid-main">
            <Card
              title="后台账号"
              icon={KeyRound}
              className="admin-settings-card"
              action={<span className="admin-card-caption">登录后可修改</span>}
            >
              <p className="admin-card-lead">
                首次部署默认账号为 <strong>admin</strong>，密码为 <strong>admin123456</strong>
                。登录后建议立即修改。
              </p>
              <Field label="管理员账号">
                <input
                  value={account.username}
                  onChange={(event) => setAccount({ ...account, username: event.target.value })}
                  autoComplete="username"
                  minLength={3}
                  maxLength={64}
                />
              </Field>
              <Field label="当前密码">
                <input
                  type="password"
                  value={account.currentPassword}
                  onChange={(event) =>
                    setAccount({ ...account, currentPassword: event.target.value })
                  }
                  autoComplete="current-password"
                  minLength={8}
                  required
                />
              </Field>
              <Field label="新密码" hint="至少 8 位；留空表示只修改账号。">
                <input
                  type="password"
                  value={account.password}
                  onChange={(event) => setAccount({ ...account, password: event.target.value })}
                  autoComplete="new-password"
                  minLength={8}
                />
              </Field>
              <Field label="确认新密码">
                <input
                  type="password"
                  value={account.confirm}
                  onChange={(event) => setAccount({ ...account, confirm: event.target.value })}
                  autoComplete="new-password"
                  minLength={8}
                />
              </Field>
              <div className="admin-form-actions">
                <Button
                  variant="primary"
                  busy={sectionBusy === 'account'}
                  disabled={!account.currentPassword || !account.username.trim()}
                  onClick={() => void saveAccount()}
                >
                  <Save size={16} />
                  保存账号设置
                </Button>
              </div>
            </Card>
            <Card
              title="邮件设置"
              icon={Settings}
              className="admin-settings-card"
              action={<span className="admin-card-caption">保存后立即生效</span>}
            >
              <div className="admin-form-grid">
                <Field label="SMTP 服务器">
                  <input
                    value={smtp.host}
                    onChange={(event) => setSmtp({ ...smtp, host: event.target.value })}
                    placeholder="smtp.example.com"
                    autoComplete="off"
                  />
                </Field>
                <Field label="端口">
                  <input
                    inputMode="numeric"
                    value={smtp.port}
                    onChange={(event) =>
                      setSmtp({ ...smtp, port: event.target.value.replace(/[^0-9]/g, '') })
                    }
                    placeholder="587"
                  />
                </Field>
                <Field label="账号">
                  <input
                    value={smtp.user}
                    onChange={(event) => setSmtp({ ...smtp, user: event.target.value })}
                    placeholder="发件账号"
                    autoComplete="off"
                  />
                </Field>
                <Field label="发件地址">
                  <input
                    type="email"
                    value={smtp.from}
                    onChange={(event) => setSmtp({ ...smtp, from: event.target.value })}
                    placeholder="hello@example.com"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <Field label="SMTP 密码" hint="留空表示保持当前密码不变。已保存的密码永远不会回显。">
                <input
                  type="password"
                  value={smtp.pass}
                  onChange={(event) => setSmtp({ ...smtp, pass: event.target.value })}
                  placeholder={
                    snapshot.smtp?.configured ? '已保存，输入新密码可替换' : '输入 SMTP 密码'
                  }
                  autoComplete="new-password"
                />
              </Field>
              <div className="admin-toggles">
                <Toggle
                  checked={smtp.secure}
                  onChange={(value) => setSmtp({ ...smtp, secure: value })}
                  label="使用 SSL"
                />
                <Toggle
                  checked={smtp.requireTLS}
                  onChange={(value) => setSmtp({ ...smtp, requireTLS: value })}
                  label="要求 TLS"
                />
              </div>
              <div className="admin-form-actions">
                <Button
                  variant="primary"
                  busy={sectionBusy === 'smtp'}
                  onClick={() => void saveSettings('smtp')}
                >
                  <Save size={16} />
                  保存邮件设置
                </Button>
                {queue.failed ? (
                  <Button
                    variant="ghost"
                    busy={sectionBusy === 'queue'}
                    onClick={() => void retryQueue()}
                  >
                    <Inbox size={16} />
                    重新发送失败邮件
                  </Button>
                ) : null}
              </div>
            </Card>
            <Card
              title="微信登录"
              icon={MessageCircle}
              className="admin-settings-card"
              action={
                <span
                  className={`admin-pill ${wechatConfigured && wechat.enabled ? 'good' : 'idle'}`}
                >
                  {wechatConfigured && wechat.enabled ? '已启用' : '未启用'}
                </span>
              }
            >
              <p className="admin-card-lead">把第三方登录放在这里管理，用户端只会看到是否可用。</p>
              <Toggle
                checked={wechat.enabled}
                onChange={(value) => setWechat({ ...wechat, enabled: value })}
                label="允许微信登录"
              />
              <Field label="微信 AppID">
                <input
                  value={wechat.appId}
                  onChange={(event) => setWechat({ ...wechat, appId: event.target.value })}
                  placeholder="填写微信开放平台 AppID"
                  autoComplete="off"
                />
              </Field>
              <Field
                label="微信 AppSecret"
                hint="留空表示保持当前密钥不变。已保存的密钥永远不会回显。"
              >
                <input
                  type="password"
                  value={wechat.appKey}
                  onChange={(event) => setWechat({ ...wechat, appKey: event.target.value })}
                  placeholder={
                    snapshot.wechat?.appKeyConfigured
                      ? '已保存，输入新密钥可替换'
                      : '填写微信 AppSecret'
                  }
                  autoComplete="new-password"
                />
              </Field>
              <div className="admin-form-actions">
                <Button
                  variant="primary"
                  busy={sectionBusy === 'wechat'}
                  onClick={() => void saveSettings('wechat')}
                >
                  <Save size={16} />
                  保存微信设置
                </Button>
              </div>
            </Card>
          </div>
          <div className="admin-grid admin-grid-lists">
            <Card
              title="最近加入的用户"
              icon={Users}
              action={
                <span className="admin-card-caption">共 {valueOf(overview.users, 0)} 位</span>
              }
            >
              <div className="admin-list">
                {snapshot.users?.length ? (
                  snapshot.users.slice(0, 6).map((user) => (
                    <div className="admin-list-row" key={user.id}>
                      <span className="admin-avatar">{(user.name || '?').slice(0, 1)}</span>
                      <div>
                        <strong>{user.name}</strong>
                        <small>
                          {user.email || '微信用户'}
                          {user.spaceName ? ` · ${user.spaceName}` : ''}
                        </small>
                      </div>
                      <time>{dateText(user.createdAt)}</time>
                    </div>
                  ))
                ) : (
                  <p className="admin-empty">还没有用户资料</p>
                )}
              </div>
            </Card>
            <Card
              title="空间概览"
              icon={Database}
              action={
                <span className="admin-card-caption">共 {valueOf(overview.spaces, 0)} 个</span>
              }
            >
              <div className="admin-list">
                {snapshot.spaces?.length ? (
                  snapshot.spaces.slice(0, 6).map((space) => (
                    <div className="admin-list-row" key={space.id}>
                      <span className="admin-avatar admin-avatar-peach">
                        <Heart size={15} fill="currentColor" />
                      </span>
                      <div>
                        <strong>{space.name}</strong>
                        <small>
                          {space.archivedAt ? '已关闭' : `${valueOf(space.members, 0)} 位成员`}
                        </small>
                      </div>
                      <time>{dateText(space.createdAt)}</time>
                    </div>
                  ))
                ) : (
                  <p className="admin-empty">还没有空间资料</p>
                )}
              </div>
            </Card>
          </div>
          <footer className="admin-footer">
            <span>
              <Server size={14} />
              后台服务{status.version ? ` · ${status.version}` : ''}
            </span>
            <span>更新于 {dateText(lastUpdated)}</span>
          </footer>
        </div>
      </main>
    );
  }, [
    authError,
    busy,
    lastUpdated,
    message,
    mode,
    notify,
    overview,
    queue,
    refreshData,
    sectionBusy,
    smtp,
    smtpConfigured,
    snapshot,
    status,
    submitAuth,
    wechat,
    wechatConfigured,
    worker,
    workerLabel,
    workerTone,
  ]);

  return page;
}
