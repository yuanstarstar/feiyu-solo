# 安全说明（单鱼版）

一句话：站里唯一值钱的东西是**能向上游申请收款码的平台凭证**。所有设计都围着它转——只在服务端内存里出现一次，加密落盘，任何接口都不回原文。

## 1. 和大站的加密为什么不通用

| | 大站 `ai-sponsor` | 单鱼版 `feiyu-solo` |
| --- | --- | --- |
| 密钥文件 | `data/.vault-key` | `data/solo-vault.key` |
| 子密钥 | 直接主密钥 | HKDF-SHA256（salt/info 带 solo 域） |
| AAD | `…` | `feiyu-solo\|v1\|<字段名>` |
| 密文前缀 | 无 | `solo1.` |
| 库格式 | `version:4` | `feiyu-solo/v1` + `keyId` |

结果：把大站的 `db.json` 拷过来会直接拒绝启动（`format` 不对）；就算两边主密钥一样、把 `keyId` 也改了，密文仍然解不开（AAD 不同）。**想互通只能重新绑定**，这是故意的。

## 2. 凭证怎么进、怎么存

三条路，随便选一条：

1. **环境变量**：`SPONSOR_CREDENTIAL=` 首次启动自动绑定，绑完建议立刻删掉这一行并重启（不然它一直躺在 `.env` 里）。
2. **CLI**：`node setup.mjs`，凭证从 stdin 粘，不进 shell 历史。
3. **网页**：`POST /api/setup`，必须带与服务端一致的 `x-setup-token`；没设 `SPONSOR_SETUP_TOKEN` 时网页绑定直接关闭。

无论哪条路：先向上游 `verify` 一次（只读），成功才 `seal()` 落盘。响应用的是 `maskSecret()`（`abcd****wxyz`），库里没有明文。

## 3. 部署时必须做的

- `HOST=127.0.0.1`，前面用 Caddy/nginx 终结 TLS
- 反代后面**才**开 `SPONSOR_TRUST_PROXY=1`；没有反代却开 = 任何人伪造 `X-Forwarded-For` 绕过封禁
- `SPONSOR_TEST` 生产环境**不要开**（`/api/_test/settle` 能把单子直接标成已付款）
- `chmod 700 data`、`chmod 600 data/db.json data/solo-vault.key .env`
- **别把 `data/` 提交进 git**（`.gitignore` 已经挡了）

备份：`data/db.json` 和 `data/solo-vault.key` **必须成对**。只恢复其中一个 = 凭证全解不开。

## 4. 已经做了的

- 请求体递归扫描，命中 `api[-_]?key|secret|access[-_]?token|bearer\s|sk-[A-Za-z0-9]{12,}` 一律 400（绑定接口先摘掉 `credential` 再扫，避免误伤）
- 金额服务端校验（整数元、1~1000、不超过上限），前端改不动
- `paid` 只认上游 `capture` 返回的状态，未付款不计入任何统计
- 每类接口独立限流（setup 5 / 开单 10 / 查单 120 / 收款码 120，按 IP+scope 分桶）
- 开码未付按网络指纹记账：连续 2 次封 1 小时，再犯 24 小时；库里只存 `sha256("feiyu-solo-ip|" + ip)` 前 16 位
- 响应头：`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、CSP（因为脚本内联才带 `'unsafe-inline'`；想更严就把脚本拆成外部文件）
- 静态文件只从 `public/` 出，路径穿越会被挡；`/data/*` 一律 404
- 请求体上限 64KB；JSON 解析失败给 400 而不是崩

## 5. 还没做的

- 支付异步回调 + 对账（现在靠前端轮询 `/api/recharges/:id` 触发上游 `capture`）
- 设备指纹/行为风控、退款流程
- 多语言
- 站点本身不存钱、不收钱、不提现——钱直接从支付平台进 DeepSeek 账户，所以也没有「余额」可被黑

## 6. 出事了怎么办

| 情况 | 处理 |
| --- | --- |
| 凭证泄露 | 到 DeepSeek 平台退出该会话/换凭证，删 `data/db.json` 重新 setup |
| 被刷单 | `GET /api/health` 看 `banned`/`pending`/`expired`；临时调小 `SPONSOR_MIN_CENTS` 没用时直接停服 |
| 误封某人 | 停服务 → 删 `data/db.json` 里 `abuse.bans` 的对应指纹 → 起服务 |
| 换了机器解不开 | 找回原来的 `data/solo-vault.key`；找不回就只能重新绑定 |
