import { useState, type FormEvent } from 'react';
import { ArrowLeft, Check, KeyRound, Mail, Pencil } from 'lucide-react';
import { Button } from './components';
import { api, type Bootstrap } from './types';

type Action = (path: string, body: unknown, message: string, method?: string) => Promise<boolean>;

export function AccountSecurity({
  bootstrap,
  busy,
  onAction,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: Action;
}) {
  const user = bootstrap.user!;
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');

  async function saveName(event: FormEvent) {
    event.preventDefault();
    await onAction('/account/profile', { name }, '昵称已更新', 'PATCH');
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirmation) {
      setError('两次新密码不一致，再检查一下吧');
      return;
    }
    if (
      await onAction(
        '/account/password',
        { currentPassword, password },
        '密码已更新，其他设备已退出登录',
      )
    ) {
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
    }
  }

  return (
    <div className="wechat-account-card account-security">
      <div className="section-heading">
        <h2>
          <KeyRound size={19} /> 账号与安全
        </h2>
      </div>
      <details className="form-options">
        <summary>
          <Pencil size={16} /> 修改昵称
        </summary>
        <form className="wechat-email-form" onSubmit={saveName}>
          <label>
            怎么称呼你
            <input
              autoComplete="nickname"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={40}
            />
          </label>
          <Button
            className="subtle wide"
            busy={busy}
            disabled={name.trim() === user.name}
            type="submit"
          >
            保存昵称
          </Button>
        </form>
      </details>
      {user.hasPassword ? (
        <details className="form-options">
          <summary>
            <KeyRound size={16} /> 修改登录密码
          </summary>
          <form className="wechat-email-form" onSubmit={savePassword}>
            <input
              hidden
              type="text"
              value={user.email ?? ''}
              autoComplete="username"
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
                maxLength={128}
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
                maxLength={128}
                placeholder="至少 8 位，建议包含字母和数字"
              />
            </label>
            <label>
              再输入一次新密码
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                minLength={8}
                maxLength={128}
              />
            </label>
            {error && (
              <p role="alert" className="account-hint">
                {error}
              </p>
            )}
            <p className="account-hint">修改后，其他设备需要重新登录。</p>
            <Button className="subtle wide" busy={busy} type="submit">
              更新密码
            </Button>
          </form>
        </details>
      ) : (
        <p className="account-hint">你使用微信登录，账号无需额外设置密码。</p>
      )}
    </div>
  );
}

/** Render before authentication/onboarding so emailed links work in every session state. */
export function PasswordRecovery({
  token,
  smtpConfigured = true,
  onBack,
}: {
  token?: string | null;
  smtpConfigured?: boolean;
  onBack: () => void | Promise<void>;
}) {
  const resetting = Boolean(token);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (resetting && password !== confirmation) {
      setError('两次新密码不一致，再检查一下吧');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ message: string }>(
        resetting ? '/auth/password/reset' : '/auth/password/forgot',
        'POST',
        resetting ? { token, password } : { email },
      );
      setMessage(result.message);
      setDone(true);
      setPassword('');
      setConfirmation('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时没能完成，请稍后再试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="onboard-shell password-recovery">
      <div className="onboard-card">
        <div className="section-heading">
          <h2>
            {done ? <Check size={22} /> : <KeyRound size={22} />}
            {resetting ? '设置新密码' : '找回密码'}
          </h2>
        </div>
        {done ? (
          <div className="wechat-email-form">
            <p role="status">{message}</p>
            <Button className="primary wide" onClick={() => void onBack()}>
              {resetting ? '去登录' : '返回登录'}
            </Button>
          </div>
        ) : (
          <form className="wechat-email-form" onSubmit={submit}>
            <p className="account-hint">
              {resetting
                ? '换一个安心的新密码，继续记录两个人的日常。'
                : '填写注册邮箱，我们会把重置链接寄给你。'}
            </p>
            {resetting ? (
              <>
                <label>
                  新密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={8}
                    maxLength={128}
                    placeholder="至少 8 位，建议包含字母和数字"
                    autoFocus
                  />
                </label>
                <label>
                  再输入一次新密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    required
                    minLength={8}
                    maxLength={128}
                  />
                </label>
                <p className="account-hint">重置后，所有设备都需要重新登录。</p>
              </>
            ) : (
              <>
                <label>
                  <Mail size={15} /> 注册邮箱
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    maxLength={254}
                    placeholder="your@email.com"
                    autoFocus
                  />
                </label>
                <p className="account-hint">使用微信注册的账号，请返回并选择微信登录。</p>
                {!smtpConfigured && (
                  <p className="account-hint" role="status">
                    邮件服务暂未启用，请稍后再试。
                  </p>
                )}
              </>
            )}
            {error && (
              <p className="account-hint" role="alert">
                {error}
              </p>
            )}
            <Button
              className="primary wide"
              type="submit"
              busy={busy}
              disabled={!resetting && !smtpConfigured}
            >
              {resetting ? '保存新密码' : '发送重置链接'}
            </Button>
            <Button
              className="subtle wide"
              type="button"
              disabled={busy}
              onClick={() => void onBack()}
            >
              <ArrowLeft size={16} /> 返回
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
