import { useState, type FormEvent } from 'react';
import { Check, Link2, Mail, MessageCircle } from 'lucide-react';
import { Button } from './components';
import type { Bootstrap } from './types';

export function WeChatAccountCard({
  bootstrap,
  busy,
  onAction,
  onWechat,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: (path: string, body: unknown, message: string, method?: string) => Promise<boolean>;
  onWechat: () => Promise<void>;
}) {
  const user = bootstrap.user!;
  const [email, setEmail] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await onAction('/auth/email', { email: email.trim() }, '验证邮件已加入发送队列，请查收邮箱')
    )
      setEmail('');
  }
  return (
    <div className="wechat-account-card">
      <div className="section-heading">
        <h2>
          <MessageCircle size={19} /> 登录方式
        </h2>
      </div>
      <div className="wechat-account-status">
        <span className="wechat-mark">
          <MessageCircle size={19} />
        </span>
        <div>
          <strong>微信账号</strong>
          <small>{user.wechatBound ? '已绑定到当前账号' : '绑定后可用微信快速登录'}</small>
        </div>
        {user.wechatBound ? (
          <span className="status status-approved">
            <Check size={13} />
            已绑定
          </span>
        ) : (
          <Button
            className="subtle small"
            busy={busy}
            disabled={!bootstrap.wechatEnabled}
            onClick={onWechat}
          >
            <Link2 size={14} />
            绑定微信
          </Button>
        )}
      </div>
      {!user.email ? (
        <form className="wechat-email-form" onSubmit={submit}>
          <label>
            <Mail size={15} />
            补充邮箱，验证后接收邮件提醒
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="your@email.com"
              required
              maxLength={254}
              autoComplete="email"
            />
          </label>
          <Button
            className="subtle wide"
            busy={busy}
            disabled={!bootstrap.smtpConfigured}
            type="submit"
          >
            <Mail size={15} />
            发送验证邮件
          </Button>
          <small className="account-hint">邮箱用于验证和接收提醒，补充邮箱不会设置登录密码。</small>
          {!bootstrap.smtpConfigured && (
            <small className="account-hint">邮件服务暂未启用，请稍后再来补充邮箱。</small>
          )}
        </form>
      ) : (
        <div className="wechat-email-status">
          <p className="account-hint">
            当前邮箱
            <span className="wechat-email-address">{user.email}</span>
            {user.emailVerified ? '已验证' : '待验证'}
          </p>
          {!user.emailVerified && (
            <>
              <Button
                className="subtle wide"
                busy={busy}
                disabled={!bootstrap.smtpConfigured}
                onClick={() =>
                  onAction('/auth/verification', {}, '验证邮件已加入发送队列，请查收邮箱')
                }
              >
                <Mail size={15} />
                发送或重发验证链接
              </Button>
              {!bootstrap.smtpConfigured && (
                <p className="account-hint">邮件服务暂未启用，请稍后再验证邮箱。</p>
              )}
            </>
          )}
        </div>
      )}
      {!bootstrap.wechatEnabled && <p className="account-hint">微信登录暂未启用，请稍后再试。</p>}
    </div>
  );
}
