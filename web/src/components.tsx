import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  Clock3,
  Gift,
  Heart,
  LoaderCircle,
  Plus,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import {
  beijingIso,
  dateText,
  personName,
  taskStatus,
  type Bootstrap,
  type Product,
  type Task,
} from './types';

export function Button({
  children,
  busy,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || busy} className={`button ${className}`}>
      {busy && <LoaderCircle className="spin" size={17} />}
      {children}
    </button>
  );
}
export function Empty({
  icon = <Heart />,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        }
        if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === ref.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">A LITTLE PROMISE</span>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={21} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function TaskCard({
  task,
  bootstrap,
  onOpen,
}: {
  task: Task;
  bootstrap: Bootstrap;
  onOpen: () => void;
}) {
  return (
    <button className="task-card" onClick={onOpen}>
      <span className={`task-symbol ${task.mode === 'RACE' ? 'peach' : 'pink'}`}>
        {task.status === 'APPROVED' ? (
          <CheckCheck size={22} />
        ) : task.mode === 'RACE' ? (
          <Zap size={22} />
        ) : (
          <Heart size={22} />
        )}
      </span>
      <span className="task-copy">
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {task.mode === 'RACE' ? '双人抢单' : `给${personName(task.assignedTo, bootstrap)}`}
          <i />
          {task.dueAt ? `${dateText(task.dueAt)} 截止` : '慢慢来，不限时间'}
        </span>
      </span>
      <span className="task-card-end">
        <span className="points-pill">
          +{task.reward} <Sparkles size={12} />
        </span>
        <span className={`status status-${task.status.toLowerCase()}`}>
          {taskStatus[task.status]}
        </span>
      </span>
      <ArrowRight className="task-arrow" size={16} />
    </button>
  );
}

type Save = (body: Record<string, unknown>, scheduled?: boolean) => Promise<void>;
export function TaskForm({
  busy,
  onSave,
  partner,
}: {
  busy: boolean;
  onSave: Save;
  partner: string;
}) {
  const [mode, setMode] = useState('ASSIGNED');
  const [kind, setKind] = useState('NOW');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      title: String(form.get('title')).trim(),
      description: String(form.get('description') || '').trim(),
      reward: Number(form.get('reward')),
      mode,
    };
    if (kind !== 'NOW') {
      Object.assign(body, { kind, durationHours: Number(form.get('durationHours')) });
      if (kind === 'ONCE') body.runAt = beijingIso(String(form.get('runAt')));
      else {
        body.time = String(form.get('time'));
        if (kind === 'WEEKLY') body.weekday = Number(form.get('weekday'));
      }
    } else if (form.get('dueAt')) body.dueAt = beijingIso(String(form.get('dueAt')));
    await onSave(body, kind !== 'NOW');
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        小小约定的名字
        <input
          name="title"
          maxLength={100}
          required
          placeholder="比如，今晚一起做一顿晚饭"
          autoComplete="off"
        />
      </label>
      <label>
        说说你的期待
        <textarea
          name="description"
          rows={3}
          maxLength={2000}
          placeholder="想怎么完成，有什么小要求，都可以写在这里…"
        />
      </label>
      <label>
        完成后奖励多少积分
        <div className="input-icon">
          <Sparkles size={18} />
          <input
            name="reward"
            type="number"
            min={1}
            max={10000}
            step={1}
            required
            defaultValue={20}
          />
        </div>
      </label>
      <fieldset>
        <legend>谁来完成</legend>
        <div className="choice-grid">
          <button
            type="button"
            className={`choice ${mode === 'ASSIGNED' ? 'selected' : ''}`}
            onClick={() => setMode('ASSIGNED')}
          >
            <Heart size={20} />
            <strong>交给{partner}</strong>
            <span>专属给对方的小约定</span>
          </button>
          <button
            type="button"
            className={`choice ${mode === 'RACE' ? 'selected' : ''}`}
            onClick={() => setMode('RACE')}
          >
            <Zap size={20} />
            <strong>两个人抢单</strong>
            <span>先领取的人来完成</span>
          </button>
        </div>
      </fieldset>
      <div className="form-row">
        <label>
          什么时候发布
          <select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="NOW">立即发布</option>
            <option value="ONCE">定时发布一次</option>
            <option value="DAILY">每天重复</option>
            <option value="WEEKLY">每周重复</option>
          </select>
        </label>
        {kind === 'NOW' ? (
          <label>
            截止时间（可选）
            <input type="datetime-local" name="dueAt" />
          </label>
        ) : (
          <label>
            发布后几小时截止
            <input
              type="number"
              name="durationHours"
              defaultValue={24}
              min={1}
              max={168}
              required
            />
          </label>
        )}
      </div>
      {kind === 'ONCE' && (
        <label>
          计划发布时间
          <input type="datetime-local" name="runAt" required />
        </label>
      )}
      {(kind === 'DAILY' || kind === 'WEEKLY') && (
        <div className="form-row">
          {kind === 'WEEKLY' && (
            <label>
              每周
              <select name="weekday" defaultValue={1}>
                {['一', '二', '三', '四', '五', '六', '日'].map((day, index) => (
                  <option key={day} value={index + 1}>
                    星期{day}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            发布时间
            <input type="time" name="time" defaultValue="09:00" required />
          </label>
        </div>
      )}
      <div className="form-hint">
        <Clock3 size={15} />
        <span>所有时间均为北京时间。完成后由另一人验收，积分才会到账。</span>
      </div>
      <Button type="submit" busy={busy} className="primary wide">
        <Plus size={18} />
        {kind === 'NOW' ? '发布这个约定' : '创建定时约定'}
      </Button>
    </form>
  );
}

export function ProductForm({
  busy,
  product,
  onSave,
}: {
  busy: boolean;
  product?: Product;
  onSave: Save;
}) {
  const [emoji, setEmoji] = useState(product?.emoji || '🎁');
  const initial = useRef(product).current;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      title: String(form.get('title')).trim(),
      description: String(form.get('description') || '').trim(),
      price: Number(form.get('price')),
      stock: Number(form.get('stock')),
      emoji,
    };
    if (initial) {
      for (const key of Object.keys(body) as (keyof Product)[])
        if (body[key] === initial[key]) delete body[key];
      if (!Object.keys(body).length) body.title = initial.title;
    }
    await onSave(body);
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <fieldset>
        <legend>选一个心愿图标</legend>
        <div className="emoji-picker">
          {['🎁', '🍳', '☕', '🎬', '💐', '🧋', '💆', '🏕️', '🧸', '🍰', '💌', '✨'].map((item) => (
            <button
              type="button"
              key={item}
              className={emoji === item ? 'selected' : ''}
              aria-label={`使用 ${item} 图标`}
              aria-pressed={emoji === item}
              onClick={() => setEmoji(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        心愿名称
        <input
          name="title"
          defaultValue={product?.title}
          maxLength={100}
          placeholder="比如，一次不用做攻略的约会"
          required
        />
      </label>
      <label>
        这份心意包含什么
        <textarea
          name="description"
          defaultValue={product?.description}
          rows={3}
          maxLength={2000}
          placeholder="写清楚兑换后会收到什么，还有兑现的小约定…"
        />
      </label>
      <div className="form-row">
        <label>
          兑换积分
          <input
            type="number"
            name="price"
            defaultValue={product?.price ?? 100}
            min={1}
            max={100000}
            step={1}
            required
          />
        </label>
        <label>
          可兑换份数
          <input
            type="number"
            name="stock"
            defaultValue={product?.stock ?? 1}
            min={0}
            max={Math.max(100000, product?.stock ?? 0)}
            step={1}
            required
          />
        </label>
      </div>
      <div className="form-hint">
        <Gift size={16} />
        <span>两个人都能兑换，包括自己上架的心愿。兑换时扣除兑换人的积分，由另一半兑现。</span>
      </div>
      <Button type="submit" className="primary wide" busy={busy}>
        {product ? <Check size={18} /> : <Plus size={18} />}
        {product ? '保存这份心意' : '上架心愿'}
      </Button>
    </form>
  );
}

export function TaskDetail({
  task,
  bootstrap,
  busy,
  onAction,
}: {
  task: Task;
  bootstrap: Bootstrap;
  busy: boolean;
  onAction: (action: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [submission, setSubmission] = useState('');
  const [reject, setReject] = useState(false);
  const [note, setNote] = useState('');
  const own = task.claimantId === bootstrap.user?.id;
  const canClaim =
    task.status === 'OPEN' && (task.mode === 'RACE' || task.assignedTo === bootstrap.user?.id);
  return (
    <div className="task-detail">
      <div className="detail-badges">
        <span className={`status status-${task.status.toLowerCase()}`}>
          {taskStatus[task.status]}
        </span>
        <span className="points-pill">
          <Sparkles size={14} /> {task.reward} 积分
        </span>
        <span className="muted">{task.mode === 'RACE' ? '双人抢单' : '专属任务'}</span>
      </div>
      <p className="detail-description">{task.description || '没有额外要求，用心完成就好。'}</p>
      <div className="detail-info">
        <span>
          <Heart size={16} />
          {personName(task.creatorId, bootstrap)}发起
        </span>
        <span>
          <CalendarDays size={16} />
          {task.dueAt ? `${dateText(task.dueAt)} 截止` : '没有截止时间'}
        </span>
        {task.claimantId && (
          <span>
            <Check size={16} />
            {personName(task.claimantId, bootstrap)}已领取
          </span>
        )}
      </div>
      {task.submission && (
        <div className="note-card">
          <span className="eyebrow">完成记录</span>
          <p>{task.submission}</p>
        </div>
      )}
      {task.reviewNote && (
        <div className="note-card peach">
          <span className="eyebrow">验收反馈</span>
          <p>{task.reviewNote}</p>
        </div>
      )}
      {canClaim && (
        <Button busy={busy} className="primary wide" onClick={() => onAction('claim')}>
          {task.mode === 'RACE' ? <Zap size={18} /> : <Heart size={18} />}
          {task.mode === 'RACE' ? '我要抢下这个任务' : '接下这个小约定'}
        </Button>
      )}
      {task.status === 'OPEN' && task.creatorId === bootstrap.user?.id && (
        <Button busy={busy} className="subtle wide" onClick={() => onAction('cancel')}>
          取消发布
        </Button>
      )}
      {task.status === 'CLAIMED' && own && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void onAction('submit', { submission });
          }}
        >
          <label>
            告诉对方，你是怎么完成的
            <textarea
              value={submission}
              onChange={(event) => setSubmission(event.target.value)}
              rows={3}
              maxLength={2000}
              required
              placeholder="今天的小小成果…"
            />
          </label>
          <Button type="submit" busy={busy} className="primary wide">
            <CheckCheck size={18} />
            完成啦，交给对方验收
          </Button>
          <Button
            type="button"
            busy={busy}
            className="subtle wide"
            onClick={() => onAction('release')}
          >
            暂时做不了，放回任务池
          </Button>
        </form>
      )}
      {task.status === 'SUBMITTED' && !own && (
        <div className="form-stack">
          {reject ? (
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void onAction('review', { approve: false, note });
              }}
            >
              <label>
                还需要完善什么
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  required
                  maxLength={1000}
                  placeholder="温柔地说清楚，让对方知道你的期待…"
                />
              </label>
              <Button busy={busy} className="primary wide" type="submit">
                发送反馈，退回完善
              </Button>
              <Button type="button" className="subtle wide" onClick={() => setReject(false)}>
                再想想
              </Button>
            </form>
          ) : (
            <>
              <Button
                busy={busy}
                className="primary wide"
                onClick={() => onAction('review', { approve: true })}
              >
                <Heart size={18} />
                验收通过，送出 {task.reward} 积分
              </Button>
              <Button busy={busy} className="subtle wide" onClick={() => setReject(true)}>
                还需要完善一下
              </Button>
            </>
          )}
        </div>
      )}
      {task.status === 'SUBMITTED' && own && (
        <div className="inline-message">
          <Clock3 size={18} />
          已经提交啦，等对方验收这份用心。
        </div>
      )}
    </div>
  );
}
