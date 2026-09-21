# 两个人

两个人的任务、心意积分和心愿小店。手机优先，电脑也能使用。

源码仓库：[1075375006/liang-ge-ren](https://github.com/1075375006/liang-ge-ren)。默认应用端口为 **33442**。

先阅读 [设计文档](docs/设计文档.md) 了解产品规则，[接口契约](docs/API契约.md) 记录实现边界。

## 已实现

- 邮箱密码注册登录、48 小时一次性邀请码、每个空间最多两人。
- 可选北辰聚合微信登录：微信直接登录、已有账号绑定、微信新账号补充邮箱。
- 指定伴侣任务与双方抢单，领取、放弃、提交、通过或退回。
- 定时一次、每日、每周发布，计划暂停/恢复，北京时间调度。
- 审核通过获得积分，独立余额与可追溯流水。
- 双方上架商品、补库存、上下架，支持兑换自己发布的心愿，由另一半兑现，确认及取消退款。
- 发布、领取、提交、验收和兑换的站内及邮件提醒；六款可预览的可爱邮件模板，各人独立选择；邮箱验证、邮件开关、SMTP 后台发送及失败重试。
- Docker Compose 应用、后台 worker、PostgreSQL，健康检查及积分对账。

抢单允许发布者本人领取，但始终由另一人审核。积分由任务产生，兑换后消耗，不转给商品发布者。

## Docker 部署

需要 Docker Engine/Desktop 与 Compose v2。第一次运行：

```sh
cp .env.example .env
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。编辑 `.env` 中的 `POSTGRES_PASSWORD`，替换为足够长的随机字母数字密码。`DATABASE_URL` 是本地开发配置，Compose 会自动用 `db` 服务地址覆盖。

```sh
docker compose up -d --build
docker compose ps
```

浏览器打开 **http://localhost:33442**。数据库就绪后先执行迁移，再启动应用和后台任务。数据库没有宿主端口映射。生产数据库初始为空，两人分别注册，一人创建空间，另一人输入邀请码加入。

默认网页端口只绑定本机。手机在同一 Wi-Fi 下试用时，在 `.env` 设置：

```dotenv
BIND_ADDRESS=0.0.0.0
APP_URL=http://你的电脑局域网IP:33442
COOKIE_SECURE=false
```

重新启动容器后，电脑和手机都应使用 `APP_URL` 中同一个地址访问，因为写请求会检查来源。Windows 防火墙需允许所用端口的专用网络访问。公网部署在反向代理后启用 HTTPS，设置正确的 `APP_URL=https://你的域名` 和 `COOKIE_SECURE=true`；推荐保留应用端口绑定 `127.0.0.1`，由本机反向代理转发。

手机浏览器可使用“添加到主屏幕”。提供 manifest 和图标；首版不提供离线操作，所有数据修改需要联网。

## 邮件设置

在 `.env` 填写 SMTP 服务商给出的配置。例如 587 端口使用 STARTTLS：

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=你的发送邮箱
SMTP_PASS=邮箱授权码或服务商密码
SMTP_FROM=两个人 <你的发送邮箱>
```

465 端口通常设置 `SMTP_SECURE=true`。修改后运行 `docker compose up -d`，然后在网页「我们的空间」发送验证邮件、打开验证链接并开启邮件提醒。两个人各自选择是否接收。

在「我们的空间 → 邮件外观」可以预览并保存六款模板，双方可选择不同款式。模板会用于发给本人的业务通知和邮箱验证邮件。发布任务后通知对方领取，领取后告诉另一人，提交完成后提醒验收，验收结果通知完成人；兑换邮件包含心愿名称、所用积分和进入兑换记录的按钮。即时及定时事件在业务成功时入队，worker 每 15 秒检查投递。更改模板会用于尚未发送的邮件。

六款样式为草莓心事、奶油来信、薄荷花园、云朵邮局、紫色花笺、晚安星河。也可以打开 [独立邮件预览册](docs/email-preview.html) 比较手机与宽屏效果，预览不会发送邮件。

未配置 SMTP 时仍可使用全部任务、积分、商城和站内通知。业务不会等待邮件发送。后台最多自动尝试 5 次，可在设置中重试失败邮件。关闭通知会取消尚未发出的业务邮件；已经交给 SMTP 的邮件无法撤回。SMTP 故障窗口可能造成重复邮件，业务积分和订单始终防重。

## 微信登录设置

微信登录通过北辰聚合平台提供，凭据只由后端读取。Compose 部署时在 `.env` 填写：

```dotenv
WECHAT_LOGIN_ENABLED=true
BEICHEN_APP_ID=平台应用ID
BEICHEN_APP_KEY=平台应用密钥
APP_URL=https://你的实际域名
COOKIE_SECURE=true
```

然后在北辰后台启用微信方式并登记网站域名，运行 `docker compose up -d --build` 使配置生效。回调地址前缀是
`https://你的实际域名/api/auth/wechat/callback/`。平台若要求完整回调白名单，需要允许末尾随机状态路径，具体规则以后台校验结果为准。AppKey 不会返回给浏览器，也不会写入前端资源。

未登录用户可以直接用微信创建账号；已有邮箱账号先用邮箱登录，再在「我们的空间」绑定微信。微信新账号没有邮箱时，可在同一位置补充邮箱并收取验证邮件。系统不会按昵称、头像或邮箱自动合并账号，绑定冲突会明确拒绝。

## 日常维护

```sh
docker compose logs --tail=100 app worker
docker compose exec app node dist/scripts/check-ledger.js
docker compose exec worker node dist/scripts/worker-health.js
```

worker 每 15 秒检查一次。健康检查判断两分钟内是否有心跳；积分对账只查询，不修改数据。`/api/health` 检查数据库连通，登录后 `/api/status` 可查后台心跳。

### 备份

在宿主机创建 `backups` 目录。以下操作兼容 PowerShell 和常见 shell，避免通过 PowerShell 重定向二进制备份：

```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/couple-backup.dump'
docker compose cp db:/tmp/couple-backup.dump ./backups/couple-backup.dump
```

给备份文件加上日期，建议每天备份并复制到另一台设备。备份包含私人任务和账号散列，应妥善保存。首版没有内置自动备份调度，需由部署者配置；数据库持久卷不能代替备份。

### 恢复

恢复会以备份覆盖当前数据库内容。先另行备份当前库，再在维护窗口执行：

```sh
docker compose stop app worker
docker compose cp ./backups/couple-backup.dump db:/tmp/couple-backup.dump
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner /tmp/couple-backup.dump'
docker compose run --rm migrate
docker compose up -d app worker
```

升级同样先备份，再 `docker compose up -d --build`。不要用 `docker compose down -v` 停止日常服务，这会删除数据库卷。

## 本地开发

需要 Node.js 22 或更高版本。数据库可选 Docker PostgreSQL，或仓库提供的仅开发使用的 PostgreSQL 17 启动脚本：

```sh
npm ci
cp .env.example .env
npm run local:db
```

Windows 使用 `Copy-Item` 复制配置。`local:db` 在本机 `127.0.0.1:55432` 启动 PostgreSQL，仅使用固定的本地开发凭据；请保持该终端运行。Windows 为兼容中文项目路径，把运行时和数据放在当前用户 `%LOCALAPPDATA%/TwoOfUsDev`，启动时输出具体路径；其他系统使用 `.local/postgres`。生产部署使用 Compose 的数据库服务。

另开终端：

```sh
npm run migrate
npm run demo:seed
npm run build
npm start
```

再开终端启动后台 `npm run dev:worker`。打开 http://localhost:33442。

可选演示脚本只在无用户的开发库中建立空间，通过正常任务审核生成积分，不修改已有用户。演示账号：

| 昵称 | 邮箱 | 密码 |
| --- | --- | --- |
| 小满 | xiaoman@example.test | DemoCouple2026! |
| 安安 | anan@example.test | DemoCouple2026! |

这两个地址是保留测试域名，无真实邮件收件人。生产环境禁止执行演示脚本。

开发热更新用 `npm run dev`。先把 `.env` 的 `APP_URL` 改为 `http://localhost:5173`，从该地址访问；Vite 会把 API 转发到 33442 端口。

## 检查与测试

```sh
npm run typecheck
npm test
npm run build
npm run check:ledger
```

集成测试需要 `local:db` 正在运行。测试使用 `couple_test_` 或 `couple_wechat_` 前缀的独立随机数据库，结束后只删除该测试库；不会清空开发库。使用自己的测试服务器时设置 `TEST_DATABASE_ADMIN`，该连接账户需有创建数据库权限。邮件测试启动本地临时 SMTP 接收器，不向真实邮箱发送。微信测试使用模拟平台响应，单独执行可用 `npm run test:wechat`；真实扫码需完成平台凭据与域名配置，见 [微信登录接入说明](docs/微信登录接入.md)。

核心测试包括抢单/审核/兑换/退款并发、第三人成员和跨空间保护、幂等、非负余额、计划防重和补发、邮箱验证与失败重试。当前验证证据和限制见 [验收记录](docs/验收记录.md)。

## 文件结构

```text
docs/                 产品设计、API 契约、验收记录
web/                  React 页面、样式、图标和 manifest
server/app.ts         账号、空间、任务、商城与积分 API
server/schema.sql     幂等初始数据库结构与首版兼容迁移
server/jobs.ts        定时任务、邮件队列、心跳
server/worker.ts      后台进程
scripts/              迁移、本地数据库、演示数据、运行检查
tests/                PostgreSQL 集成测试与时间边界测试
Dockerfile            构建和非 root 运行镜像
compose.yaml          app、worker、migrate、db
```

首版列表最多展示最近 200 条任务、商品、订单和流水，以及最近 100 条通知；历史记录仍保存在数据库中。暂未提供分页、忘记密码、图片上传、解除配对和更换伴侣。日程固定北京时间；支持文字完成说明和图标商品。
