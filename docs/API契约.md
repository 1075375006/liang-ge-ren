# 接口与数据契约

所有地址以 `/api` 开头，使用同源 HttpOnly Cookie 会话。成功响应 JSON，错误格式包含 `{ "error": "可直接显示的中文信息" }`；限流响应还包含 `statusCode:429`。字段使用 camelCase，时间使用 ISO 8601，记录 ID 为 UUID，积分与余额为整数。常见错误：未登录 401、权限不足 403、记录不可访问 404、状态冲突 409、输入不合法 400、操作过频 429、能力未配置或暂时关闭 503。

## 账号与引导

| 接口 | 请求与结果 |
| --- | --- |
| `POST /auth/register` | `{name,email,password,acceptTerms?}` → `{user}` 并设置会话；配置 SMTP 时自动将验证邮件入队。生产启用验证门槛时必须 `acceptTerms:true` |
| `POST /auth/login` | `{email,password}` → `{user}` 并设置会话 |
| `POST /auth/logout` | `{}`，废止当前会话并清 Cookie |
| `POST /auth/verification` | `{}`，给当前账号重新发送验证邮件，旧验证令牌失效 |
| `POST /auth/verify` | `{token}`，64 位十六进制令牌，一小时内有效且只使用一次 |
| `POST /auth/password/forgot` | `{email}` → `{ok:true,message}`；存在、不存在或仅微信账号均返回相同提示，不泄露账号存在性；SMTP 未配置返回 503 |
| `POST /auth/password/reset` | `{token,password}`；64 位十六进制重置令牌，30 分钟有效、一次使用，新申请使旧链接失效；成功后需重新登录 |
| `POST /account/password` | `{currentPassword,password}`；验证旧密码，新旧不能相同；仅微信身份账号返回 409。成功轮换当前 Cookie，撤销其他会话及重置令牌 |
| `PATCH /account/profile` | `{name}` → `{ok:true,name}`；去掉首尾空白后 1–40 字符，拒绝控制和不可见字符 |
| `POST /auth/email` | `{email}`；仅给当前没有邮箱的微信账号补充邮箱，并发送验证邮件；不合并账号、不创建密码登录方式；SMTP 未配置返回 503 |

密码长度为 8–128 字符。重置密码同时将现有邮箱标记为已验证，撤销该账号全部会话、OAuth 状态和其他安全令牌，并清除当前 Cookie。找回入口按 IP 限制每 15 分钟 5 次；同一收件账号至少间隔 1 分钟、每小时最多 3 封。重置链接形如 `/#reset-password=<token>`，令牌不进入 HTTP 查询字符串。

`GET /bootstrap` 允许匿名访问，返回：

```text
{
  user: null | {id,name,email,emailVerified,notifyEmail,emailTheme,wechatBound,hasPassword},
  space: null | {id,name,inviteCode,inviteExpiresAt,archivedAt,...},
  partner: null | {id,name}, balance,
  stats:{open,claimed,review,completed},
  smtpConfigured, wechatEnabled, requireVerifiedEmail, registrationOpen,
  supportEmail, operatorName, version
}
```

配对完成后，双方必须分别确认相处契约：`GET /contract` 返回 `{version,text,myAccepted,partnerAccepted,ready}`，`POST /contract/accept {}` 记录当前成员确认时间。`ready=false` 时任务、计划、心愿、兑换、积分等业务接口返回 409，只有双方确认后才开放。

`REGISTRATION_OPEN=false` 暂停新邮箱注册和新微信账号创建，已有账号可登录。`REQUIRE_VERIFIED_EMAIL=true` 时，未验证账号不能创建、加入空间或访问空间业务；收到邮箱邀请的新账号可以先接受邀请并确认相处契约，双方契约确认后仍需完成邮箱验证才能进入业务；微信新用户也需先补充并验证邮箱。

## 微信登录

- `POST /auth/wechat/start {intent:'login'|'bind',acceptTerms?}` → `{url}`。登录入口仅匿名使用，绑定要求已登录；启用验证门槛时 `intent:'login'` 需 `acceptTerms:true`。未配置微信返回 503。
- `GET /auth/wechat/callback/:state?type=wx&code=...` 消费浏览器绑定的一次性状态并 303 回站点根路径；成功参数为 `wechat=logged_in` 或 `wechat=bound`，失败为固定 `reason` 枚举。
- 平台凭据、回调校验与真实扫码边界见 [微信登录接入](微信登录接入.md)。

## 空间、导出与注销

| 接口 | 请求与行为 |
| --- | --- |
| `POST /spaces` | `{name}` → `{space}`；仅无空间的账号可创建 |
| `POST /spaces/join` | `{code}` → `{space}`；48 小时一次性邀请码，空间最多两人 |
| `POST /spaces/invite` | `{}`；刷新当前未满且未关闭空间的邀请码 |
| `POST /spaces/email-invite` | `{email}`；向邮箱发送 48 小时邀请链接，链接可引导注册或登录并接受空间邀请 |
| `GET /spaces/email-invite/info?token=...` | 返回邀请邮箱和邀请人展示名，用于注册页预填邮箱 |
| `POST /spaces/email-invite/accept` | `{token}`；要求当前登录邮箱与邀请邮箱一致，接受后进入契约确认流程。邀请链接本身已发送到该邮箱，因此未验证的新账号也可以先完成绑定 |
| `POST /spaces/archive` | `{confirmation:'关闭空间',password?}` → `{ok:true,spaceArchived:true}`；关闭当前空间，保留双方账号 |
| `POST /spaces/leave-archived` | `{confirmation:'离开空间'}` → `{ok:true}`；仅可离开已关闭空间，余额结算清零并记录流水，移除本人的空间成员关系 |
| `GET /account/export` | 下载 JSON，完整导出本人和当前空间可见数据，不受列表分页限制 |
| `POST /account/delete` | `{confirmation:'注销账号',password?}` → `{ok:true,spaceArchived:boolean}`；注销本人并关闭其当前空间，清除当前 Cookie |

关闭空间及注销均需要再次确认身份：密码账号提交正确密码；无密码微信账号需持有最近 10 分钟内建立的有效会话。关闭操作不可恢复，并在事务中取消 `OPEN/CLAIMED/SUBMITTED` 约定、停用计划，取消 `PENDING` 订单并按幂等退款来源恢复积分与库存；`FULFILLED/COMPLETED` 等既有结果保留。关闭后停止业务写入，仍在空间的用户可导出共同历史。离开后无法再访问旧空间，可创建或加入新空间，旧积分不能带入新关系。

注销会删除本人的会话、微信绑定、邮箱令牌、重置令牌、邮件队列与个人通知，并将账号昵称改为「已注销用户」、清空邮箱和密码。共同任务、订单、积分流水及匿名账号 ID 保留，以供另一人查看和对账；不是物理删除全部业务历史。

导出字段为 `formatVersion,exportedAt,account,balance,space,partner,tasks,schedules,products,orders,ledger,notifications`。包含当前共同空间的业务记录、本人全部流水和通知；不包含密码散列、会话/安全令牌、微信平台标识、另一人的邮箱或个人通知。响应包含附件下载头。

## 分页、筛选与历史深链

`GET /tasks`、`/schedules`、`/products`、`/orders`、`/ledger`、`/notifications` 统一接受 `limit`（1–200，默认 60）和不透明 `cursor`。响应保留原列表字段，并增加 `nextCursor:string|null`；为 `null` 表示到末页。按 `created_at DESC,id DESC` 排序，游标保留数据库时间的微秒精度，绑定当前用户、空间与筛选条件。修改筛选、搜索或账号后必须从第一页读取；非法或不匹配的游标返回 400。客户端不应解码或构造游标。

| 查询 | 额外条件与返回 |
| --- | --- |
| `GET /tasks` | `view=all`（默认）、`current`、`history`、`mine`、`review`；`q` 为最多 100 字的标题/说明字面包含搜索。返回 `{tasks,schedules,nextCursor,schedulesNextCursor}` |
| `GET /schedules` | `{schedules,nextCursor}`；可接 `/tasks` 的 `schedulesNextCursor` 继续读取计划 |
| `GET /products` | `{products,nextCursor}`；仅返回上架商品或本人创建的商品 |
| `GET /orders` | `view=all`（默认）或 `actionable`；后者为本人待兑现或待确认的订单。返回 `{orders,nextCursor}` |
| `GET /ledger` | `{balance,entries,nextCursor}`；当前空间内本人的积分流水 |
| `GET /notifications` | `{notifications,unreadCount,nextCursor}`；`unreadCount` 是本人所有未读通知数量，不是当前页未读数 |

任务 `current` 包含 `OPEN/CLAIMED/SUBMITTED`，`history` 包含 `APPROVED/CANCELLED/EXPIRED`，`mine` 为当前状态中指定给本人或本人领取的任务，`review` 为另一人提交待验收的任务。`/tasks` 中的 `schedules` 是计划第一页，任务游标不推动计划分页。

`GET /tasks/:id` → `{task}`、`GET /orders/:id` → `{order}` 提供单条历史深链读取，不依赖首页已加载多少记录；记录不存在或不属于当前空间均返回 404。

## 约定与计划

Task 字段包括 `id,title,description,reward,mode,status,creatorId,assignedTo,claimantId,submission,reviewNote,dueAt,createdAt,submittedAt,approvedAt,scheduleId`。

- `POST /tasks {title,description,reward,mode:'ASSIGNED'|'RACE'|'TOGETHER',dueAt?,requestKey?}`；指定任务自动指向伴侣，`TOGETHER` 表示双方都能领取的共同完成约定，当前仍由一位领取人提交、另一人验收并发放一次奖励。
- `POST /tasks/:id/claim {}`、`POST /tasks/:id/release {}`、`POST /tasks/:id/submit {submission?}`、`POST /tasks/:id/review {approve,note?}`、`POST /tasks/:id/cancel {}`。
- 完成说明最多 3000 字符，省略、空字符串或纯空白保存为 `null`；有内容则去掉首尾空白。仅领取人提交，另一人验收，禁止自审；通过后才发积分，退回须填写原因。
- `POST /schedules {title,description,reward,mode,kind:'ONCE'|'DAILY'|'WEEKLY',runAt?:ISO,time?:'HH:mm',weekday?:1..7,durationHours:1..168,requestKey?}`。
- `PATCH /schedules/:id {active:boolean}`；仅发布者可暂停/恢复。Schedule 包含创建字段和 `id,creatorId,active,nextRunAt,createdAt`，日程固定北京时间。

## 心愿、兑换与积分

- Product：`id,title,description,emoji,price,stock,active,creatorId,createdAt`。
- `POST /products {title,description,emoji,price,stock,requestKey?}`；`PATCH /products/:id {title?,description?,emoji?,price?,stock?,active?}` 仅商品创建人可修改。
- `POST /products/:id/redeem {idempotencyKey}` → `{order}`。允许兑换自己的心愿；`buyerId` 是兑换人，`sellerId` 固定为另一位成员，即实际兑现人。
- Order 包含 `id,buyerId,sellerId,productId,title,description,price,status,createdAt` 及兑现/完成/取消时间；状态为 `PENDING/FULFILLED/COMPLETED/CANCELLED`。
- `POST /orders/:id/action {action:'fulfill'|'complete'|'cancel'}`；兑现人标记兑现，兑换人确认完成，待兑现时任一方可取消并退款。重复完成、兑现或取消不重复记账。
- 订单保留兑换时商品信息快照。Entry 包含 `id,delta,balanceAfter,reason,createdAt`；余额、扣库存、订单及账本变动由同一事务处理。

三个创建接口的 `requestKey` 去除首尾空白后为 8–128 字符，按用户、空间和记录种类隔离。同键同归一化内容返回原记录当前状态，不重复建单或通知；同键不同内容返回 409。前端应在一次新建表单生命周期内保持同键，关闭后新建才更换。省略请求键兼容旧客户端，但不具备这项创建防重保护。商品编辑不使用此字段，仅提交 `requestKey` 而没有可编辑字段返回 400。请求身份存入 `creation_requests`，只保存内容摘要和记录 ID，不保存表单原文，日常维护不删除该表记录。

## 通知、偏好与运行状态

- `PATCH /settings {notifyEmail?,emailTheme?}` 至少一项；开启业务邮件须已验证邮箱。主题枚举 `strawberry,cream,mint,sky,lavender,night`。
- `POST /notifications/read {}` 标记本人全部通知已读。
- `GET /mail/status` → `{configured,counts:{pending,sent,failed}}`，统计本人当前保留的邮件队列；`POST /mail/retry {}` → `{ok,retried}`，重试本人失败邮件。
- `GET /mail/templates` → `{templates:[{id,name,description,emoji,accent,background,html}]}`，要求登录；固定示例预览，不发送邮件，前端使用无权限 sandbox iframe。
- `GET /health` 检查进程可响应和数据库连通，正常为 `{ok:true}`。
- `GET /ready` 正常返回 `{ok:true,version}`；数据库可用且 worker 最近两分钟内有无错误心跳才就绪，后台不满足条件时返回 503。
- `GET /status` 要求登录，返回 `{worker,smtpConfigured}`。

## 服务端协作与保留策略

`server/db.ts` 导出 `pool`、`query`、`transaction`、`migrate`。迁移在事务与 PostgreSQL advisory 锁中执行，先执行幂等基线 `server/schema.sql`，再按名称顺序执行 `server/migrations/`，在 `schema_migrations` 保存校验和；已执行的增量迁移不可修改。

`server/app.ts` 的 `buildApp()` 用于 API 与集成测试，`server/index.ts` 在监听前检查生产配置。生产要求安全 Cookie 和强数据库密码；域名与 HTTPS 由外部反向代理负责，`APP_URL` 可选。留空时请求公开 origin 会记录到空间，用于后续通知邮件；受控代理后配置 `TRUST_PROXY`，直接暴露 API 时不能盲目信任转发头。启用 Origin/Sec-Fetch-Site 检查、限流、安全响应头和请求大小限制。

## 管理后台

管理入口为 `/admin`，使用独立管理员会话，不复用普通用户 Cookie。首次启动会自动创建默认管理员 `admin`，默认密码为 `admin123456`；登录后可通过 `PATCH /admin/account {username?,currentPassword,password?}` 修改账号或密码，建议立即修改默认密码。管理员可查看数据库、worker、邮件队列、用户和空间概览，并在后台保存 SMTP 与微信配置。SMTP 密码和微信 AppKey 使用服务端密钥加密后写入 `admin_settings`，接口不会回显密钥。管理员可暂停或恢复普通用户；暂停会撤销该用户的普通会话。

`POST /admin/settings/email/test {to}` 使用已保存的 SMTP 配置发送一封测试邮件；未配置或连接失败时返回可直接显示的错误，不会修改邮件设置。

后台由 `server/jobs.ts` 调度任务与邮件，`server/maintenance.ts` 执行保留策略。维护每 24 小时最多成功一次、每类每次最多 5000 条：清理过期满 1 天的会话、过期满 7 天的 OAuth/验证/重置令牌、终态邮件 90 天前的历史；安全邮件在令牌过期满 7 天后移除令牌引用并清除链接正文。待发送或发送中的邮件及其引用令牌保持不变。维护不删除账号、空间、任务、计划、商品、订单、账本或站内通知；事务失败不记录完成时间，供后续重试。

`notify(client,{userId,spaceId,title,body,kind?,actionPath?})` 在业务事务内创建站内通知，并按收件人验证状态与偏好入邮件队列；链接必须同源。验证与找回密码邮件不受业务通知开关限制。令牌表保存摘要，但待发安全邮件正文包含一次性链接，需遵守保留策略与备份访问限制。
