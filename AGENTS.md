# 两个人 · 项目协作入口

为情侣提供双人约定、积分与心愿兑换空间，采用手机优先网页；主导航为「约定、心愿、我们」。

## 技术与权威文档

- Node.js 22+、TypeScript、React/Vite、Fastify、PostgreSQL 17。
- `web/` 为前端，`server/` 为 API/调度/邮件，`scripts/` 与 `ops/` 为工具，`tests/` 为测试。
- 使用入口见 [README](README.md)，业务见 [设计文档](docs/设计文档.md)，协议见 [API 契约](docs/API契约.md)。
- 生产部署、配置、备份恢复以 [部署与运营](docs/部署运营.md) 为准；最新证据见 [验收记录](docs/验收记录.md)。

## 启动与验证

- 开发：`npm ci`，复制 `.env.example`，`npm run local:db` 保持运行，再执行 `npm run migrate`。
- `npm run build` 后分别运行 `npm start`、`npm run worker`，默认地址为 `http://localhost:33442`。
- 热更新用 `npm run dev` 与 `npm run dev:worker`；先把 `APP_URL` 改为 `http://localhost:5173`。
- 根目录 `docker compose up -d --build` 仅供本地体验（development）；生产使用 `scripts/deploy.sh` 与 `ops/compose.production.yaml`。
- 代码门禁为 `npm test`、`npm run build`；运行检查为 `npm run check:worker`、`npm run check:ledger`。
- 运维验证为 `bash ops/test-deploy.sh`、`bash ops/test-production.sh`；后者使用独立 Docker 项目及本地 SMTP/CA。
- 集成测试使用独立随机数据库，不能清空开发库或用真实邮箱测试外发。

## 修改约定

- 空间访问、抢单、审核、扣分、退款、空间关闭与注销的权限及幂等以服务端事务和数据库约束为准。
- 抢单允许发布者领取；完成说明选填，仍由另一人验收发积分。自己的心愿可兑换，始终由另一人兑现。
- 配对后双方必须分别确认相处契约；任一方未确认时，服务端拒绝任务、计划、心愿和积分业务。
- 生产默认要求条款确认和邮箱验证；账号恢复不能把只有微信身份的账号变成密码账号。
- 关闭空间保留账号和共同历史，待兑现订单退款；离开已关闭空间需结算清零。注销匿名化本人资料，不删除共同账本。
- 邮件异步入队；业务提醒遵守收件人验证状态和偏好，账号安全邮件不受业务通知开关限制。
- 列表使用绑定用户/空间/筛选的游标；深链读取单条接口，不靠截断列表查找历史记录。
- 新建约定、计划和心愿保持表单级 `requestKey`；同键重试不能重复创建或通知，不能用新键掩盖失败后重试。
- `server/schema.sql` 是幂等基线；新变更新增 `server/migrations/` 文件，已执行迁移不可修改。破坏性变更须有备份和恢复方案。
- `.env`、`.local/`、数据库、备份、日志与凭据不得提交；只提交无真实密钥的配置样例。
- 不把本地 CA、模拟微信、测试 SMTP 或容器通过写成真实公网与真实邮件上线；不擅改宿主生成记忆。

## 当前边界

已有账号安全、数据导出/注销、空间关闭与重新配对、分页和单机生产部署能力。真实域名、SMTP、支持邮箱以及可选微信凭据由部署环境提供；实际投递、平台授权、目标服务器和适用运营要求仍需在那里验证。
