import { useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { Button } from './components';
import type { Bootstrap } from './types';

type Action = (path: string, body: unknown, message: string, method?: string) => Promise<boolean>;
export function PrivacyPolicy({ bootstrap }: { bootstrap: Bootstrap }) {
  return (
    <div className="policy-copy">
      <h3>只属于两个人的日常</h3>
      <p>
        我们使用昵称、邮箱或微信身份来提供登录与账号恢复。你在空间里创建的约定、心愿和兑换记录会与伴侣共享；邮箱、密码和个人通知不会展示给伴侣。
      </p>
      <h3>你的数据由你管理</h3>
      <p>
        在账号设置可以导出完整数据、修改密码或注销。注销会删除登录凭据、邮箱、微信绑定与个人通知，并关闭当前空间。为保留另一方的共同记录与积分核对依据，共有任务和交易记录会以“已注销用户”保留；这些记录不是公开内容。
      </p>
      <p>
        未兑现的兑换会取消并退回积分；已经兑现的记录保留当时结果。备份在配置的保留周期（默认 14
        天）内滚动到期，恢复备份后运营方须重新执行已生效的注销要求。
      </p>
      <h3>使用约定</h3>
      <p>
        本站面向成年人使用。积分仅用于两个人之间的心愿约定，不可充值、提现、转账，不代表真实货币；兑现由双方自行协商。请勿上传敏感证件、金融信息或侵犯他人权益的内容，也不要利用本站骚扰他人。
      </p>
      <p>
        邮件仅用于验证、账号恢复与主动开启的业务提醒。我们使用必要的登录
        Cookie，不设置第三方广告追踪。网站会记录必要的安全及故障日志，访问和通知由服务端权限限制。
      </p>
      <h3>联系与处理</h3>
      <p>
        运营方：{bootstrap.operatorName || '本站运营方'}。如需处理隐私、账号或不当内容问题，
        {bootstrap.supportEmail ? (
          <a href={`mailto:${bootstrap.supportEmail}`}>联系 {bootstrap.supportEmail}</a>
        ) : (
          '请联系向你提供本站地址的运营者'
        )}
        。
      </p>
      <p className="muted">
        使用说明更新于 2026-09-22。服务可能因维护暂时中断，请妥善导出重要记录。
      </p>
    </div>
  );
}
export function PrivacyCenter({
  bootstrap,
  busy,
  onAction,
}: {
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: Action;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [spaceConfirmation, setSpaceConfirmation] = useState('');
  return (
    <section className="account-security">
      <div className="section-heading">
        <h2>
          <ShieldCheck size={19} />
          数据与隐私
        </h2>
      </div>
      <a
        className="button subtle wide"
        href="/api/account/export"
        download="liang-ge-ren-data.json"
      >
        <Download size={17} />
        导出我的数据
      </a>
      <details className="form-options">
        <summary>隐私与使用说明</summary>
        <PrivacyPolicy bootstrap={bootstrap} />
      </details>
      {bootstrap.space && !bootstrap.space.archivedAt && (
        <details className="form-options danger-options">
          <summary>关闭空间，解除配对</summary>
          <form
            className="form-stack form-options-body"
            onSubmit={async (event) => {
              event.preventDefault();
              await onAction(
                '/spaces/archive',
                {
                  confirmation: spaceConfirmation,
                  ...(bootstrap.user?.hasPassword ? { password } : {}),
                },
                '空间已关闭，请导出需要保留的记录',
              );
            }}
          >
            <p className="account-hint">
              这会关闭双方的共同空间，保留各自账号。未完成约定取消、定时计划停止，待兑现兑换自动退款，已兑现记录保留结果。关闭无法撤销，建议先导出数据。之后双方可分别离开旧空间，清零旧积分后重新配对。
            </p>
            {bootstrap.user?.hasPassword ? (
              <label>
                登录密码
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  maxLength={128}
                />
              </label>
            ) : (
              <p className="account-hint">请在最近 10 分钟内重新通过微信登录后操作。</p>
            )}
            <label>
              输入“关闭空间”确认
              <input
                value={spaceConfirmation}
                onChange={(event) => setSpaceConfirmation(event.target.value)}
                required
                pattern="关闭空间"
                autoComplete="off"
              />
            </label>
            <Button type="submit" className="subtle wide" busy={busy}>
              确认关闭空间
            </Button>
          </form>
        </details>
      )}
      <details className="form-options danger-options">
        <summary>注销账号</summary>
        <form
          className="form-stack form-options-body"
          onSubmit={async (event) => {
            event.preventDefault();
            await onAction(
              '/account/delete',
              { confirmation, ...(bootstrap.user?.hasPassword ? { password } : {}) },
              '账号已注销',
            );
          }}
        >
          <p className="account-hint">
            注销无法撤销，会退出所有设备并关闭当前空间。未兑现的兑换自动退款，已兑现的记录保留结果。共同历史以匿名身份保留给另一方，邮箱和登录身份会删除。建议先导出数据。
          </p>
          {bootstrap.user?.hasPassword ? (
            <label>
              登录密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
          ) : (
            <p className="account-hint">微信账号需要最近 10 分钟内重新登录后才能注销。</p>
          )}
          <label>
            输入“注销账号”确认
            <input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              required
              pattern="注销账号"
            />
          </label>
          <Button busy={busy} className="subtle wide" type="submit">
            确认注销账号
          </Button>
        </form>
      </details>
    </section>
  );
}
