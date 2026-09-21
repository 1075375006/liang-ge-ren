# 两个人 · 项目协作入口

为情侣提供双人任务、积分与心愿兑换空间，采用手机优先网页。

## 技术与目录

- Node.js 22+、TypeScript、React/Vite、Fastify、PostgreSQL 17。
- `web/` 为前端，`server/` 为 API、任务调度与邮件，`scripts/` 为运行工具，`tests/` 为测试。
- 产品规则见 [设计文档](docs/设计文档.md)，接口见 [API 契约](docs/API契约.md)，使用与部署以 [README](README.md) 为准。

## 启动与验证

- 初次执行 `npm ci`，复制 `.env.example` 为 `.env`，按 README 配置。
- `npm run local:db` 启动本地开发库并保持运行；随后 `npm run migrate`。
- `npm run build` 后分别运行 `npm start`、`npm run worker`，访问 `http://localhost:33442`。
- 热更新使用 `npm run dev`、`npm run dev:worker`；先将 `APP_URL` 改为 `http://localhost:5173`，从 5173 访问，API 代理到 33442。
- Docker 使用 `docker compose up -d --build`；容器内应用端口 33442，外部由 `APP_PORT` 配置。
- 验证使用 `npm test`、`npm run build`；运行时检查 `npm run check:worker`、`npm run check:ledger`。
- 集成测试需要 PostgreSQL 可用，使用独立随机测试库；不能清空开发库或用真实邮箱测试外发。

## 修改约定

- 空间访问、抢单、审核、扣分、退款的权限与幂等以服务端事务和数据库约束为准。
- 抢单允许发布者领取，必须另一人审核；自己的心愿可兑换，始终由另一人兑现。
- 邮件通过事务队列异步发送，尊重收件人验证状态、开关和模板偏好。
- `server/schema.sql` 是首版幂等迁移；破坏性变更需另行制定迁移及备份方案。
- `.env`、`.local/`、数据库、备份、日志与凭据不得提交；仅提交无真实密钥的 `.env.example`。
- 文档中的行为、端口和接口与实际实现同步，验收结果不得把模拟联调写成真实上线。

## 当前状态

已实现账号配对、任务与周期计划、积分和心愿兑换、六款邮件主题、可选北辰微信登录。
当前验证与未实测边界见 [验收记录](docs/验收记录.md)。后续部署仍需配置 SMTP、北辰凭据与实际域名，并在目标环境验证 Docker 和备份恢复。
