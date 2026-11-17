# 部署这只鱼（feiyu-solo）

目标：`/opt/feiyu-solo` 里跑一个 Node 进程，Caddy/nginx 在前面终结 TLS，数据只有 `data/db.json` + `data/solo-vault.key`。

## 1. 上传

```bash
# 本地
tar czf feiyu-solo.tgz --exclude='./data/*' --exclude='./.env' .
scp feiyu-solo.tgz user@server:/tmp/

# 服务器
sudo mkdir -p /opt/feiyu-solo && cd /opt/feiyu-solo
sudo tar xzf /tmp/feiyu-solo.tgz
sudo mkdir -p data && sudo chmod 700 data
```

## 2. 绑定 + 配置

```bash
cd /opt/feiyu-solo
cp .env.example .env
openssl rand -base64 32        # 可选：填进 SPONSOR_VAULT_KEY（留空也会自动生成密钥文件）

# 绑定这只鱼（凭证不会留在 shell 历史里）
node setup.mjs
sudo chmod 600 .env
```

> 也可以把 `SPONSOR_CREDENTIAL=` 写进 `.env` 让首次启动自动绑定，**绑完记得删掉那一行**。

## 3. 先手工跑一遍

```bash
node server.mjs
# 另一个终端
curl -s localhost:8790/api/health
curl -s localhost:8790/api/config
curl -s localhost:8790/api/agent | head -c 300
```

`/api/health` 里 `"configured":true`、`/api/agent` 有你的名字就对了。`Ctrl+C`。

## 4. systemd

```bash
sudo useradd --system --home /opt/feiyu-solo --shell /usr/sbin/nologin feiyu
sudo chown -R feiyu:feiyu /opt/feiyu-solo
sudo cp deploy/feiyu-solo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feiyu-solo
systemctl status feiyu-solo --no-pager
journalctl -u feiyu-solo -n 40 --no-pager
```

## 5. 反代 + HTTPS

### Caddy（推荐）

```caddyfile
ai.example.com {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
	}
	reverse_proxy 127.0.0.1:8790 {
		header_up X-Forwarded-For {remote_host}
	}
}
```

### nginx

```bash
sudo cp deploy/nginx-feiyu-solo.conf /etc/nginx/conf.d/
sudo certbot --nginx -d ai.example.com
sudo nginx -t && sudo systemctl reload nginx
```

### 防火墙

```bash
sudo ufw allow 80,443/tcp
sudo ufw deny 8790
sudo ufw enable
```

> 国内云主机对外提供 Web 服务需要 ICP 备案。

## 6. 上线后自检

```bash
cd /opt/feiyu-solo
node --check server.mjs

# 隔离实例跑全量自检（不碰你的 data/）
mkdir -p /tmp/solo-selftest && chmod 700 /tmp/solo-selftest
PORT=8791 SPONSOR_TEST=1 SPONSOR_DATA_DIR=/tmp/solo-selftest node server.mjs &
node _test/smoke.mjs --base http://127.0.0.1:8791
# 期望：全部通过

# 对外抽查（应全 404）
for p in /data/db.json /data/solo-vault.key /.env /server.mjs /setup.mjs /api/_test/abuse; do
  printf '%-26s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://ai.example.com$p)"
done
```

## 7. 备份与升级

```bash
# 成对备份，少一个都恢复不了
tar czf /root/solo-$(date +%F).tgz -C /opt/feiyu-solo data
```

升级代码（`data/` 不动）：

```bash
sudo systemctl stop feiyu-solo
# 覆盖 server.mjs setup.mjs lib/ public/ vendor/ deploy/ _test/ README.md SECURITY.md package.json
sudo chown -R feiyu:feiyu /opt/feiyu-solo
sudo systemctl start feiyu-solo
curl -s localhost:8790/api/health
```

## 8. 排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `store: ... 不是单鱼版的库` | 把大站的 `db.json` 拷进来了 | 换空目录重新绑定（加密不通用） |
| `keyId ... 对不上` | 换过密钥或丢了 `solo-vault.key` | 找回原密钥；找不回只能重新绑定 |
| `EADDRINUSE` | 8790 被占 | `ss -lntp \| grep 8790` 杀掉旧进程 |
| 页面空白 | `public/` 没上传 / 反代指错端口 | `curl -sI localhost:8790/` |
| `DAILY_LIMIT_EXCEEDED` | 上游当天开单额度用完 | 等次日；已有未付的码仍可扫 |
| 所有人都被封 | 反代后没开 `SPONSOR_TRUST_PROXY=1` | 打开并重启 |
| 网页绑定报 403 | 没设 `SPONSOR_SETUP_TOKEN` | 用 `node setup.mjs`，或设了 token 再在页面里填 |
