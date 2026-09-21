export type Page =
  | 'tasks'
  | 'shop'
  | 'settings'
  | 'points'
  | 'orders'
  | 'history'
  | 'schedules'
  | 'notifications'
  | 'account'
  | 'mail';
export type User = {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  notifyEmail: boolean;
  emailTheme: string;
  wechatBound: boolean;
};
export type Bootstrap = {
  user: User | null;
  space: {
    id: string;
    name: string;
    inviteCode: string | null;
    inviteExpiresAt: string | null;
  } | null;
  partner: { id: string; name: string } | null;
  balance: number;
  stats: { open: number; claimed: number; review: number; completed: number };
  smtpConfigured: boolean;
  wechatEnabled: boolean;
};
export type Task = {
  id: string;
  title: string;
  description: string;
  reward: number;
  mode: 'ASSIGNED' | 'RACE';
  status: 'OPEN' | 'CLAIMED' | 'SUBMITTED' | 'APPROVED' | 'CANCELLED' | 'EXPIRED';
  creatorId: string;
  assignedTo: string | null;
  claimantId: string | null;
  submission: string | null;
  reviewNote: string | null;
  dueAt: string | null;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  scheduleId: string | null;
};
export type Schedule = {
  id: string;
  title: string;
  description: string;
  reward: number;
  mode: 'ASSIGNED' | 'RACE';
  kind: 'ONCE' | 'DAILY' | 'WEEKLY';
  time?: string;
  weekday?: number;
  runAt?: string;
  durationHours: number;
  creatorId: string;
  active: boolean;
  nextRunAt: string | null;
  createdAt: string;
};
export type Product = {
  id: string;
  title: string;
  description: string;
  emoji: string;
  price: number;
  stock: number;
  active: boolean;
  creatorId: string;
  createdAt: string;
};
export type Order = {
  id: string;
  buyerId: string;
  sellerId: string;
  productId: string;
  title: string;
  description: string;
  price: number;
  status: 'PENDING' | 'FULFILLED' | 'COMPLETED' | 'CANCELLED';
  createdAt: string;
};
export type Entry = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
};
export type Notice = {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};
export type MailStatus = {
  configured: boolean;
  counts: { pending: number; sent: number; failed: number };
};
export type Data = {
  tasks: Task[];
  schedules: Schedule[];
  products: Product[];
  orders: Order[];
  entries: Entry[];
  notifications: Notice[];
  mail: MailStatus | null;
};

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '暂时没能完成，请稍后再试');
  return payload as T;
}
export const emptyData: Data = {
  tasks: [],
  schedules: [],
  products: [],
  orders: [],
  entries: [],
  notifications: [],
  mail: null,
};
export const taskStatus: Record<Task['status'], string> = {
  OPEN: '待领取',
  CLAIMED: '进行中',
  SUBMITTED: '待验收',
  APPROVED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已过期',
};
export const orderStatus: Record<Order['status'], string> = {
  PENDING: '待兑现',
  FULFILLED: '待确认',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};
export function dateText(value: string | null | undefined, full = false) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        ...(full ? { year: 'numeric' as const } : {}),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '不限时间';
}
export function beijingIso(value: string) {
  return new Date(`${value}:00+08:00`).toISOString();
}
export function personName(id: string | null, bootstrap: Bootstrap) {
  return id === bootstrap.user?.id
    ? '我'
    : id === bootstrap.partner?.id
      ? bootstrap.partner.name
      : '伴侣';
}
export function requestKey() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
}
