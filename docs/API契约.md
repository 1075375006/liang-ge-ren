# 首版接口与数据契约

所有地址以 `/api` 开头，同源 Cookie 会话认证。成功响应 JSON，错误格式 `{ "error": "可直接显示的中文信息" }`。对象字段 camelCase，时间 ISO 8601。所有 ID 为 UUID；余额与积分整数。未登录业务接口 401、权限不足 403、状态冲突 409、输入不合法 400。

## 账号和引导

- `POST /auth/register {name,email,password}`、`POST /auth/login {email,password}`：登录并返回 `{user}`。
- `POST /auth/logout {}`。
- `GET /bootstrap`：`{user: null | {id,name,email,emailVerified,notifyEmail,emailTheme,wechatBound}, space: null | {id,name,inviteCode,inviteExpiresAt}, partner: null | {id,name}, balance, stats:{open,claimed,review,completed}, smtpConfigured, wechatEnabled}`。未登录也可访问。
- `POST /spaces {name}`；`POST /spaces/join {code}`；`POST /spaces/invite {}` 刷新未满空间邀请。
- `PATCH /settings {notifyEmail?,emailTheme?}`，至少一项；模板枚举 `strawberry,cream,mint,sky,lavender,night`，仅改变当前用户偏好，开启邮件提醒仍需已验证邮箱。`POST /auth/verification {}` 请求验证邮件；`POST /auth/verify {token}`。
- `POST /auth/wechat/start {intent:'login'|'bind'}` 返回北辰微信授权地址；未配置微信时返回 503。`GET /auth/wechat/callback/:state?type=wx&code=...` 完成回调并 303 回首页。`POST /auth/email {email}` 仅允许没有邮箱的微信账号补充邮箱，不会合并账号；需要 SMTP 配置，否则返回 503。

## 任务

- `GET /tasks` → `{tasks, schedules}`。Task：`id,title,description,reward,mode:'ASSIGNED'|'RACE',status,creatorId,assignedTo,claimantId,submission,reviewNote,dueAt,createdAt,submittedAt,approvedAt,scheduleId`。含已结束任务，按创建时间倒序最多 200 条。
- `POST /tasks {title,description,reward,mode,dueAt?}`，指定任务自动指向伴侣。
- `POST /tasks/:id/claim {}`；`POST /tasks/:id/release {}`；`POST /tasks/:id/submit {submission}`；`POST /tasks/:id/review {approve:boolean,note?:string}`；`POST /tasks/:id/cancel {}`。
- `POST /schedules {title,description,reward,mode,kind:'ONCE'|'DAILY'|'WEEKLY',runAt?:ISO,time?:'HH:mm',weekday?:1..7,durationHours:1..168}`。
- `PATCH /schedules/:id {active:boolean}`。Schedule：上述创建字段和 `id,creatorId,active,nextRunAt,createdAt`。

## 商城与积分

- `GET /products` → `{products}`。Product：`id,title,description,emoji,price,stock,active,creatorId,createdAt`。
- `POST /products {title,description,emoji,price,stock}`。
- `PATCH /products/:id {title?,description?,emoji?,price?,stock?,active?}` 仅上架者。
- `POST /products/:id/redeem {idempotencyKey}` → `{order}`。允许兑换自己的商品；`buyerId` 是兑换人，`sellerId` 固定为其另一半（实际兑现人，可与商品创建人不同）。
- `GET /orders` → `{orders}`。Order：`id,buyerId,sellerId,productId,title,description,price,status:'PENDING'|'FULFILLED'|'COMPLETED'|'CANCELLED',createdAt`。
- `POST /orders/:id/action {action:'fulfill'|'complete'|'cancel'}`，分别由兑现人、兑换人、待兑现状态下任一方执行。
- `GET /ledger` → `{balance,entries}`，Entry：`id,delta,balanceAfter,reason,createdAt`，只看自己。

## 通知与运行状态

- `GET /notifications` → `{notifications}`，字段 `id,title,body,readAt,createdAt`。
- `POST /notifications/read {}` 全部已读。
- `GET /mail/status` → `{configured,counts:{pending,sent,failed}}` 仅本人；`POST /mail/retry {}` 重试本人失败邮件。
- `GET /mail/templates` → `{templates:[{id,name,description,emoji,accent,background,html}]}`，要求登录；HTML 是固定示例预览，不发送邮件。前端使用无权限 sandbox iframe 展示。
- `GET /health` 存活和数据库连通性检查；`GET /status` 登录后查看 worker 心跳。

## 后端协作约定

`server/db.ts` 导出 `pool`、`query(text,values?)`、`transaction(async client => ...)`、`migrate()`；transaction client 提供标准 pg `query`。

`server/schema.sql` 为幂等初始建表。`server/app.ts` 导出 `buildApp()` 供集成测试使用；`server/index.ts` 为监听入口。

后台相关函数放 `server/jobs.ts`：`nextOccurrence(schedule,after)`、`runScheduler(now?)`、`runMailBatch(now?)`、`tick(now?)`。`server/worker.ts` 调用 tick 并优雅退出。`server/notify.ts` 提供事务内 `notify(client,{userId,spaceId,title,body,kind?,actionPath?})`，写站内通知并按偏好/验证状态入邮件队列；`actionPath` 可指定任务或订单入口，链接必须与站点同源。邮箱验证邮件可直接入队，不受业务通知开关限制。

SQL 表列 snake_case；接口可统一映射 camelCase。日期字段由 pg 返回 Date，再由 JSON 转为 ISO。worker 与业务 API 共用数据库及通知函数。
