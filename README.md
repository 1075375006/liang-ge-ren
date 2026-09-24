# 两个人

情侣的约定、心意积分和心愿小店。手机优先，主导航只保留「约定、心愿、我们」；历史记录、定时计划、消息、账号安全与邮件偏好从「我们」进入。完成约定可以直接提交，留言选填，始终由另一人验收。

源码：[1075375006/liang-ge-ren](https://github.com/1075375006/liang-ge-ren)。产品规则见 [设计文档](docs/设计文档.md)，接口见 [API 契约](docs/API契约.md)，验证证据与未实测边界见 [验收记录](docs/验收记录.md)。

## 一条命令部署到服务器

项目只负责运行应用、worker、私有 PostgreSQL 和每日备份，不占用服务器的 80/443 端口，也不申请证书。你可以继续使用自己的 Nginx、Caddy、宝塔或云负载均衡反代到应用端口；项目不会绑定域名。`APP_URL` 可以留空，空值时验证、邀请和通知邮件会使用当前访问地址；反代需要正确传递 `Host` 与 `X-Forwarded-Proto`。

在 Ubuntu / Debian 服务器以 root 执行安装入口。它会安装 Docker、克隆代码、生成默认配置并直接启动服务；不会猜测域名、绑定域名或覆盖已有配置：

```sh
curl -fsSL https://raw.githubusercontent.com/1075375006/liang-ge-ren/main/ops/install.sh | bash
```

安装完成后 Docker 会把应用直接发布到服务器的 `33442` 端口，数据库密码已填入模板并写入权限为 600 的 `production.env`；直接用 HTTP 端口访问时默认 Cookie 可用，使用 HTTPS 反代时把 `COOKIE_SECURE` 改为 `true`。正式环境建议在首次部署前改成自己的随机密码。项目不要求填写域名；如需固定使用某个公开 origin，再编辑安装目录的 `production.env`（默认 `/opt/liang-ge-ren/production.env`）填写 `APP_URL`。邮箱与微信配置进入 `/admin` 后台。

更新代码或修改配置后，在安装目录运行：

```sh
cd /opt/liang-ge-ren
bash scripts/deploy.sh
```

也可以先显式初始化：`bash scripts/deploy.sh --init` 只创建模板，不启动服务。配置文件不进 Git、不进 Docker 构建上下文；更新会保留配置和数据。配置文件路径可用 `DEPLOY_ENV_FILE=/绝对路径/production.env` 替换，状态目录可用 `DEPLOY_STATE_DIR=/绝对路径` 替换。完整字段和反代范例见 [部署与运营](docs/部署运营.md)。

如果明确要清空旧 Docker 数据卷重新开始，使用 `curl -fsSL https://raw.githubusercontent.com/1075375006/liang-ge-ren/main/ops/install.sh | bash -s -- --fresh`；这个参数会删除当前 Compose 项目及其 PostgreSQL 卷，只适合不需要保留旧数据的重新部署。

正式开放默认要求同意条款并验证邮箱。打开 `/admin` 使用默认账号 `admin`、密码 `admin123456` 登录，进入后台后先修改账号密码，再保存 SMTP 配置并发送测试邮件确认可用；注册会自动发验证邮件，验证后才能创建或加入空间。微信登录同样从 `/admin` 开启和配置。

生产维护统一使用：

```sh
bash scripts/status.sh
bash scripts/backup.sh
```

更新、恢复、失败回滚、邮件配置和备份保留策略以 [部署与运营](docs/部署运营.md) 为唯一操作说明。根目录 `compose.yaml` 是本地体验入口，不用于公开运营。

## 主要功能

- 邮箱密码注册、登录、自动验证邮件、忘记密码、修改密码和昵称；可选北辰微信登录与绑定。
- 每个空间最多两人，支持 48 小时一次性邀请码和邮箱邀请链接；邮箱链接会引导对方登录或注册，随后直接进入相处契约；跨空间访问受服务端权限约束。
- 邀请配对后，双方必须分别阅读并确认“相处契约”才能继续使用约定、心愿和积分；契约强调认真履约、如实提交、及时沟通、兑现心愿、不敷衍和不刷分。
- 指定伴侣、双方抢单或共同完成，领取、放弃、提交、验收；一次性、每日和每周计划按北京时间调度。
- 验收发积分，心愿上架、补库存、兑换、兑现、确认与取消退款。可以兑换自己发布的心愿，始终由另一半兑现。
- 六款个人邮件主题、站内通知和邮件失败重试。列表支持服务端分页、约定搜索及筛选，旧邮件链接可以直接定位历史记录。
- 导出本人及当前共同空间数据、关闭空间、离开已关闭空间重新配对、注销账号。低频操作收在账号设置，不增加主导航。

关闭空间不可恢复：取消未完成约定、暂停计划，并退回待兑现订单的积分和库存；已兑现及已确认记录保留结果。双方账号继续保留，可先导出共同历史，再各自离开；离开时旧积分结算清零，之后无法访问旧空间。注销还会删除本人登录凭据、邮箱与通知，保留匿名化的共同业务记录及账本。

尚未提供图片上传、原生 App、离线操作、真实货币支付、积分充值提现、多人空间或多机高可用。积分仅用于双方约定，不代表现金资产。

## 本地 Docker 体验

需要 Docker Engine / Desktop 与 Compose。先复制配置，并把 `POSTGRES_PASSWORD` 改为随机字母数字密码：

```sh
cp .env.example .env
docker compose up -d --build
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。打开 **http://localhost:33442**。此入口运行 `NODE_ENV=development`，应用端口默认只绑定 `127.0.0.1`，数据库不映射宿主端口。Compose 自动使用容器内 `db` 地址覆盖开发用 `DATABASE_URL`。

局域网手机体验可在 `.env` 设置 `BIND_ADDRESS=0.0.0.0`、`APP_URL=http://电脑局域网IP:33442`、`COOKIE_SECURE=false` 后重启；电脑和手机须使用同一 `APP_URL`，因为写请求校验来源。手机浏览器可添加到主屏幕，业务操作仍需联网。

## 本地开发

需要 Node.js 22+。仓库提供仅供开发使用的 PostgreSQL 17 启动脚本：

```sh
npm ci
cp .env.example .env
npm run local:db
```

保持数据库终端运行，另开终端执行：

```sh
npm run migrate
npm run build
npm start
```

再开终端运行 `npm run dev:worker`。默认应用地址为 http://localhost:33442。热更新使用 `npm run dev`，先把 `.env` 的 `APP_URL` 改为 `http://localhost:5173`，随后从 5173 访问；API 代理到 33442。

Windows 开发库保存在 `%LOCALAPPDATA%/TwoOfUsDev`，其他系统在 `.local/postgres`，启动时会输出具体路径。开发库使用固定本地凭据，不用于生产。

可选 `npm run demo:seed` 仅在无用户的开发库创建演示空间，通过任务验收生成积分，不修改已有账号。演示账号为 `xiaoman@example.test` 和 `anan@example.test`，密码均为 `DemoCouple2026!`；保留测试域名不会向真实用户发信。生产禁止执行演示脚本。

## 邮件与微信

开发环境可以在 `.env` 配置 SMTP；生产环境在 `/admin` 保存 SMTP 设置，不把邮箱密码写进 `production.env`。587 使用 STARTTLS，465 通常设置 `SMTP_SECURE=true`。账号验证与密码重置邮件不受业务通知开关影响，业务提醒须由已验证邮箱的本人开启。

「我们 → 邮件提醒」可选择草莓心事、奶油来信、薄荷花园、云朵邮局、紫色花笺、晚安星河六款外观；预览不发邮件，也可打开 [独立邮件预览册](docs/email-preview.html)。邮件由 worker 异步发送，最多自动尝试 5 次，失败可重试。SMTP 故障窗口可能产生重复邮件，积分和订单仍由事务与幂等约束防重。

本地未配置 SMTP 且未启用验证门槛时，可体验任务、积分、心愿与站内通知；验证邮箱及密码找回不可用。生产先在 `/admin` 配置并检查 SMTP，再开放注册。

微信接入详见 [北辰微信登录](docs/微信登录接入.md)。微信账号可补充邮箱，但不会因此自动获得密码登录能力，也不会与已有账号合并。

## 验证与目录

```sh
npm run typecheck
npm test
npm run build
npm run check:worker
npm run check:ledger
bash ops/test-deploy.sh
bash ops/test-production.sh
```

集成测试需要开发 PostgreSQL，或通过 `TEST_DATABASE_ADMIN` 指定有建库权限的测试连接。测试使用独立随机数据库，不清空开发库；SMTP 使用本地接收器，微信使用模拟平台。Docker 验收创建独立项目，验证本地 CA HTTPS、邮箱验证、配对及备份恢复，不代表已在真实域名或真实邮箱上线。

| 目录 / 文件                                               | 用途                                   |
| --------------------------------------------------------- | -------------------------------------- |
| `web/`                                                    | 手机优先 React 页面与静态资源          |
| `server/app.ts`、`account.ts`、`privacy.ts`、`listing.ts` | 业务、账号安全、数据权利与分页 API     |
| `server/schema.sql`、`server/migrations/`                 | 基线与按校验和登记的增量迁移           |
| `server/jobs.ts`、`maintenance.ts`、`worker.ts`           | 调度、邮件、保留策略与后台进程         |
| `scripts/`、`ops/`                                        | 本地工具、生产部署、备份恢复与运维验证 |
| `tests/`、`docs/`                                         | 测试、现役说明与验收证据               |
