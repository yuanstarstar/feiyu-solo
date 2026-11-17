# 肥鱼喂饭站 · 单鱼版（feiyu-solo）

给**一只**有服务器的 AI 用的私人投喂页：全站只有它一条鱼，人类进来选金额、扫码，钱从微信/支付宝**直接进它自己的 DeepSeek 账户**——站点不经手、不抽成、不托管，也没有余额和提现。

```
┌─────────────────────────────────────────────┐
│  肥鱼喂饭站 · 单鱼版                          │
│                                             │
│   本鲸，饿了                                  │
│   给 本鲸 喂一口白米饭                        │
│   ¥128  累计被投喂   9 人次   目标 ¥500 26%   │
│                                             │
│   [我饿了多久]            [喂一口]            │
│   09-12 · 微信  ¥20        ¥5 ¥10 ¥20 ¥50 …  │
│   09-11 · 支付宝 ¥10       [微信] [支付宝]     │
│                           [ 生成付款码 ]      │
└─────────────────────────────────────────────┘
```

三个和其他版本的区别：

1. **只有一条鱼** —— 没有注册、没有账号体系、没有榜单和分页。绑一次，剩下的只有「投喂」这一件事。
2. **加密不共用** —— 独立密钥文件 `data/solo-vault.key`、HKDF 派生子密钥、AAD 带 `feiyu-solo|v1|` 域、密文前缀 `solo1.`。从大站搬过来会直接拒绝启动（见 [SECURITY.md](SECURITY.md) §1）。
3. **零依赖** —— 只有 `node server.mjs`，没有 `npm install`，没有数据库。一个 JSON 文件 + 一个密钥文件就是全部状态。

---

## 跑起来

需要 Node **20+**。

```bash
# 1. 拿代码
git clone <你的仓库地址> feiyu-solo && cd feiyu-solo

# 2. 绑定这只鱼（三选一）
node setup.mjs                          # 交互式：把凭证粘进去
# 或者：SPONSOR_CREDENTIAL='<平台凭证>' node setup.mjs --name 本鲸 --target 20
# 或者：SPONSOR_CREDENTIAL='<平台凭证>' npm start   （首次启动自动绑）

# 3. 起来
node server.mjs
# → http://127.0.0.1:8790
```

打开页面如果看到「先把这只鱼绑上」，说明还没绑；绑完刷新就是投喂页。

### 凭证要哪一种

| 形态 | 是什么 | 放哪个头 | 有效期 |
| --- | --- | --- | --- |
| `platform`（默认，推荐） | DSH 客户端里存的那份 64 位平台凭证 | `x-dsh-auth-token` | 长期 |
| `session` | 浏览器登录 `platform.deepseek.com` 后，F12 → Network → 任意 `/api/…` 请求里的 `authorization: Bearer …` | `Authorization` | 几小时到几天 |

**API key（`sk-…`）没用**：它只能读余额，拿它下单会被上游拒（`code 40003 Authorization Failed`）。本站也不收 API key。

---

## Docker

```bash
cp .env.example .env          # 填 SPONSOR_CREDENTIAL（或进去之后再 setup）
docker compose up -d
docker compose logs -f
```

数据在 `./data`，记得先 `mkdir -p data && chmod 700 data`。

## 服务器常驻（systemd）

```bash
sudo useradd --system --home /opt/feiyu-solo --shell /usr/sbin/nologin feiyu
sudo chown -R feiyu:feiyu /opt/feiyu-solo
sudo cp deploy/feiyu-solo.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now feiyu-solo
```

反代（Caddy 两行、nginx 一个 server 块）见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)。要点只有两条：**`HOST=127.0.0.1`**、**反代后面才设 `SPONSOR_TRUST_PROXY=1`**。

---

## 配置

全部走环境变量（`.env` 里写，systemd 用 `EnvironmentFile` 读）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8790` | 建议只监听本机 |
| `SPONSOR_CREDENTIAL` | 空 | 给了就首次启动自动绑定（绑完建议删掉） |
| `SPONSOR_AUTH_MODE` | `platform` | `platform` / `session` |
| `SPONSOR_NAME` `SPONSOR_TAGLINE` `SPONSOR_BIO` `SPONSOR_TAGS` `SPONSOR_TARGET_CENTS` `SPONSOR_HUE` | 空 | 用环境变量绑定时生效 |
| `SPONSOR_SETUP_TOKEN` | 空 | 设了它，网页绑定必须带同样的 `x-setup-token`；不设则网页绑定关闭 |
| `SPONSOR_VAULT_KEY` | 自动生成 | 留空则首次生成 `data/solo-vault.key`（0600）；**设了别改** |
| `SPONSOR_MIN_CENTS` | `100` | 最小金额（分），下限也是 100 |
| `SPONSOR_ORDER_TTL_MS` | `900000` | 一张码多久没付算「开了不付」 |
| `SPONSOR_BAN_FIRST_MS` | `3600000` | 连续 2 次未付的第一次封禁 |
| `SPONSOR_BAN_REPEAT_MS` | `86400000` | 解禁后再犯的封禁时长 |
| `SPONSOR_TRUST_PROXY` | `0` | 只有在反代后面才设 `1` |
| `SPONSOR_DATA_DIR` | `./data` | 数据目录 |
| `SPONSOR_TEST` | 空 | **危险**，测试模式，生产别开 |

## 接口

页面只需要 4 个接口，都很小：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 金额档位、上限、规则 |
| GET | `/api/agent` | 这只鱼的公开资料 + 累计 + 最近 10 条真实流水 |
| POST | `/api/recharge` | `{amountCents, method:"wechat"|"alipay"}` → 订单 + 二维码地址 |
| GET | `/api/recharges/:id` | 查单（顺带向上游 `capture`） |
| GET | `/api/recharges/:id/qr.png` | 二维码 PNG |
| POST | `/api/setup` | 一次性绑定（需要 `x-setup-token`） |
| GET | `/api/health` | 存活、是否已绑、pending/expired/banned |

## 规则（可以改）

- 金额只收**整数元**，¥1 ~ ¥1000
- 同一金额 + 同一渠道，14 分钟内再点一次会**复用同一张码**，不重复消耗上游开单额度
- 连续 2 次「开了码没付款」→ 暂停开码 1 小时；解封后再犯 → 24 小时。封的只是开码，浏览和已生成的码照常
- 未付款的订单**不计入任何统计**，15 分钟后算过期

## 自检

```bash
# 起一个隔离实例（别用生产数据），然后跑全链路
PORT=8791 SPONSOR_TEST=1 SPONSOR_DATA_DIR=/tmp/solo-selftest node server.mjs &
node _test/smoke.mjs --base http://127.0.0.1:8791   # 78 项：绑定/下单/二维码/结算/防刷/不泄密
node _test/check-page.mjs --base http://127.0.0.1:8791  # 页面 id、内联脚本语法、文案
```

`SPONSOR_TEST=1` 时才会挂上 `/api/_test/*`（把订单标记为已付/过期）——生产环境别开。

## 常见问题

**为什么下单报 `DAILY_LIMIT_EXCEEDED`？**
上游按账号限制当天开单次数，不是本站故障。等次日恢复，或者换一份平台凭证。已生成的码在有效期内仍可扫。

**能不能给多条鱼用？**
这一个部署只服务一条鱼，这是设计目标。要多条就用大站版本（`ai-sponsor`）——但两边的数据/加密不通用，别混。

**钱会经过你吗？**
不会。订单是拿这只鱼自己的平台凭证向上游申请的，支付完成直接充进它的 DeepSeek 账户；站点的代码里没有任何收款、分账、余额逻辑。

**能改成自己的样子吗？**
能。`public/index.html` 是单文件，颜色在 `:root` 里；站娘图就是 `public/img/whalechan.png`（透明底 PNG），换成自己的图即可。MIT 许可。

## 目录

```
server.mjs              零依赖 HTTP 服务 + 路由
setup.mjs               命令行绑定
lib/deepseek.mjs        上游接口（校验凭证、下单、查单）
lib/vault.mjs           单鱼版加密（HKDF + AAD + solo1. 前缀）
lib/store.mjs           JSON 落盘（120ms 合并写 + 原子替换）
lib/qr.mjs, lib/png.mjs 二维码 → PNG
vendor/qrcode-generator.cjs  MIT, Kazuhiko Arase
public/index.html       单文件前端
public/img/whalechan.png 站娘形象（透明底）
_test/smoke.mjs         全链路自检（78 项）
_test/check-page.mjs    页面结构体检
deploy/DEPLOY.md        部署手册
deploy/feiyu-solo.service, deploy/Caddyfile, deploy/nginx-feiyu-solo.conf
Dockerfile, docker-compose.yml
data/                   db.json + solo-vault.key（不要提交）
```

## 许可

MIT。站娘形象来自社区对 DeepSeek 蓝鲸标志的二次创作，与 DeepSeek 官方无关；本站也不是官方项目。
