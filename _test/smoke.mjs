// 单鱼版全链路自检
// 用法：
//   1) 起一个隔离实例（别用生产数据）
//      PORT=8791 SPONSOR_TEST=1 SPONSOR_DATA_DIR=/tmp/solo-selftest node server.mjs
//   2) node _test/smoke.mjs --base http://127.0.0.1:8791
// 注意：必须在测试模式（SPONSOR_TEST=1）下跑，会用桩凭证与 /api/_test/*。

const base = (() => {
	const index = process.argv.indexOf("--base");
	return (index >= 0 ? process.argv[index + 1] : "http://127.0.0.1:8791").replace(/\/+$/, "");
})();

const STUB = "solo-test-token";
let passed = 0;
const failures = [];

function check(name, condition, extra) {
	if (condition) {
		passed += 1;
		console.log(`  ✓ ${name}`);
	} else {
		failures.push(name);
		console.log(`  ✗ ${name}${extra === undefined ? "" : `  → ${typeof extra === "string" ? extra : JSON.stringify(extra)}`}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

async function api(method, path, body, headers = {}) {
	const response = await fetch(base + path, {
		method,
		headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { status: response.status, data, text, headers: response.headers };
}

const isPng = (buffer) => {
	const bytes = new Uint8Array(buffer);
	return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
};

const containsSecretish = (text) => /solo1\.[A-Za-z0-9+/=]{8,}/.test(text) || text.includes(STUB);

console.log(`单鱼版自检 → ${base}`);

// ------------------------------------------------------------------ A
section("A 未绑定状态");
{
	const health = await api("GET", "/api/health");
	check("health 200 且 ok", health.status === 200 && health.data.ok === true, health.data);
	check("health 报告未绑定", health.data.configured === false, health.data);
	check("health 报告测试模式", health.data.testMode === true, health.data);
	check("vault 域是 feiyu-solo（与大站不共用）", health.data.vault?.domain === "feiyu-solo", health.data.vault);
	check("vault 带 keyId", typeof health.data.vault?.keyId === "string" && health.data.vault.keyId.length >= 8, health.data.vault);

	const config = await api("GET", "/api/config");
	check("config 最小金额 ¥1", config.data.minCents === 100, config.data);
	check("config 快捷档位不低于最小值", Array.isArray(config.data.presets) && config.data.presets.every((cents) => cents >= config.data.minCents), config.data.presets);
	check("config 公开未付规则", config.data.rules?.unpaidStrikes === 2 && config.data.rules?.banFirstMinutes === 60, config.data.rules);

	const agent = await api("GET", "/api/agent");
	check("未绑定时 agent 为空", agent.data.agent === null, agent.data);
	check("未绑定时统计全 0", agent.data.totals?.flows === 0 && agent.data.totals?.amountCents === 0, agent.data.totals);

	const recharge = await api("POST", "/api/recharge", { amountCents: 200 });
	check("未绑定不能下单（409 not_configured）", recharge.status === 409 && recharge.data.error === "not_configured", recharge.data);
}

// ------------------------------------------------------------------ B
section("B 页面与静态边界");
{
	const page = await api("GET", "/");
	check("首页 200", page.status === 200, page.status);
	check("首页标题是肥鱼喂饭站", page.text.includes("肥鱼喂饭站"), page.text.length);
	check("首页有投喂主按钮", page.text.includes("生成付款码"), null);
	check("首页引用站娘图", page.text.includes("/img/whalechan.png"), null);
	check("首页不含大站的榜单结构", !page.text.includes("喂饭榜"), null);
	check("首页响应头有安全头", page.headers.get("x-content-type-options") === "nosniff" && page.headers.get("x-frame-options") === "DENY", null);
	check("首页 CSP 存在", (page.headers.get("content-security-policy") ?? "").includes("default-src 'self'"), null);

	const image = await fetch(base + "/img/whalechan.png");
	const buffer = await image.arrayBuffer();
	check("站娘图 200 image/png", image.status === 200 && image.headers.get("content-type") === "image/png", image.status);
	check("站娘图是真 PNG", isPng(buffer) && buffer.byteLength > 100000, buffer.byteLength);

	for (const path of ["/data/db.json", "/data/solo-vault.key", "/.env", "/server.mjs", "/setup.mjs", "/lib/vault.mjs"]) {
		const result = await api("GET", path);
		check(`敏感路径 404：${path}`, result.status === 404, result.status);
	}
	check("未知接口 404 no_route", (await api("GET", "/api/nope")).data.error === "no_route", null);
	check("路径穿越被挡", (await api("GET", "/img/%2e%2e/server.mjs")).status === 404, null);
}

// ------------------------------------------------------------------ C
section("C 绑定");
{
	const empty = await api("POST", "/api/setup", {});
	check("空凭证被拒（need_credential）", empty.status === 400 && empty.data.error === "need_credential", empty.data);

	const withKey = await api("POST", "/api/setup", { credential: STUB, apiKey: "sk-abcdefghijklmnop" });
	check("带 apiKey 字段被拒（no_secrets）", withKey.status === 400 && withKey.data.error === "no_secrets", withKey.data);

	const short = await api("POST", "/api/setup", { credential: "abc" });
	check("凭证太短被拒", short.status === 400 && short.data.error === "need_credential", short.data);

	const created = await api("POST", "/api/setup", {
		credential: STUB,
		authMode: "platform",
		name: "自检的鲸",
		tagline: "饿了，谢谢投喂",
		bio: "一条用于自检的鲸",
		tags: ["自检", "鲸"],
		targetCents: 50000
	});
	check("绑定成功 201", created.status === 201 && created.data.ok === true, created.data);
	check("绑定回显名字", created.data.agent?.name === "自检的鲸", created.data.agent?.name);
	check("凭证只回掩码", (created.data.agent?.platformHint ?? "").includes("****"), created.data.agent?.platformHint);
	check("响应里没有密文", !containsSecretish(created.text), created.text.slice(0, 120));

	const again = await api("POST", "/api/setup", { credential: STUB });
	check("重复绑定被拒（already_configured）", again.status === 409 && again.data.error === "already_configured", again.data);

	const agent = await api("GET", "/api/agent");
	check("绑定后 agent 有资料", agent.data.agent?.name === "自检的鲸" && agent.data.agent?.authMode === "platform", agent.data.agent);
	check("绑定后访问模式是 platform", agent.data.agent?.authMode === "platform", null);
	check("新绑定还没有流水", agent.data.totals.flows === 0 && agent.data.totals.amountCents === 0, agent.data.totals);
}

// ------------------------------------------------------------------ D
section("D 下单与二维码");
let firstRecharge = null;
{
	const tooSmall = await api("POST", "/api/recharge", { amountCents: 50 });
	check("低于最小金额被拒", tooSmall.status === 400 && tooSmall.data.error === "out_of_range", tooSmall.data);

	const notIntegerYuan = await api("POST", "/api/recharge", { amountCents: 150 });
	check("非整数元被拒（bad_amount）", notIntegerYuan.status === 400 && notIntegerYuan.data.error === "bad_amount", notIntegerYuan.data);

	const tooBig = await api("POST", "/api/recharge", { amountCents: 200001 });
	check("超过上限被拒", tooBig.status === 400 && tooBig.data.error === "out_of_range", tooBig.data);

	const fractional = await api("POST", "/api/recharge", { amountCents: 200.5 });
	check("小数分被拒（bad_integer）", fractional.status === 400 && fractional.data.error === "bad_integer", fractional.data);

	const secret = await api("POST", "/api/recharge", { amountCents: 200, apiKey: "sk-abcdefghijklmnop" });
	check("下单带 apiKey 被拒（no_secrets）", secret.status === 400 && secret.data.error === "no_secrets", secret.data);

	const created = await api("POST", "/api/recharge", { amountCents: 200, method: "wechat" });
	check("下单成功 201", created.status === 201 && created.data.recharge?.status === "pending", created.data);
	check("下单是二维码形态", created.data.recharge?.kind === "qr", created.data.recharge?.kind);
	check("下单带过期时间", typeof created.data.recharge?.expiresAt === "number" && created.data.recharge.expiresAt > created.data.recharge.createdAt, created.data.recharge);
	firstRecharge = created.data.recharge;

	const reused = await api("POST", "/api/recharge", { amountCents: 200, method: "wechat" });
	check("同额同渠道复用同一张码", reused.status === 200 && reused.data.reused === true && reused.data.recharge?.id === firstRecharge.id, reused.data);

	const other = await api("POST", "/api/recharge", { amountCents: 500, method: "alipay" });
	check("换金额/渠道会开新单", other.status === 201 && other.data.recharge?.id !== firstRecharge.id, other.data.recharge?.id);

	const status = await api("GET", `/api/recharges/${firstRecharge.id}`);
	check("查单返回 pending", status.status === 200 && status.data.recharge?.status === "pending", status.data);

	const qr = await fetch(`${base}/api/recharges/${firstRecharge.id}/qr.png`);
	const png = await qr.arrayBuffer();
	check("二维码 200 image/png", qr.status === 200 && qr.headers.get("content-type") === "image/png", qr.status);
	check("二维码是合法 PNG", isPng(png), png.byteLength);

	const missing = await api("GET", "/api/recharges/rc-nope");
	check("不存在的单 404", missing.status === 404 && missing.data.error === "no_recharge", missing.data);
	check("不存在的码 404", (await api("GET", "/api/recharges/rc-nope/qr.png")).status === 404, null);
}

// ------------------------------------------------------------------ E
section("E 结算与统计");
{
	const before = await api("GET", "/api/agent");
	check("未付款不计入流水", before.data.totals.flows === 0, before.data.totals);

	const settled = await api("POST", `/api/_test/settle/${firstRecharge.id}`);
	check("结算成功", settled.status === 200 && settled.data.status === "paid", settled.data);

	const after = await api("GET", "/api/agent");
	check("到账后流水 +1", after.data.totals.flows === 1, after.data.totals);
	check("到账后金额累加", after.data.totals.amountCents === 200, after.data.totals);
	check("到账后支持人数 +1", after.data.totals.supporters === 1, after.data.totals);
	check("流水里能看到这一笔", after.data.agent?.flows?.[0]?.amountCents === 200, after.data.agent?.flows?.[0]);
	check("流水带付款时间", typeof after.data.agent?.flows?.[0]?.paidAt === "number", after.data.agent?.flows?.[0]);

	const detail = await api("GET", `/api/recharges/${firstRecharge.id}`);
	check("查单显示 paid", detail.data.recharge?.status === "paid", detail.data.recharge);

	const again = await api("POST", `/api/_test/settle/${firstRecharge.id}`);
	check("重复结算幂等", again.status === 200 && again.data.idempotent === true, again.data);
}

// ------------------------------------------------------------------ F
section("F 防刷：连续两次未付");
{
	const first = await api("POST", "/api/recharge", { amountCents: 300, method: "wechat" });
	check("开第一张码", first.status === 201, first.status);
	const expired1 = await api("POST", `/api/_test/expire/${first.data.recharge.id}`);
	check("第一张记 1 次不封", expired1.data.status === "expired" && expired1.data.abuse?.ban === null, expired1.data);

	// 过期单不能再复用：同额再开就是新的一张
	const second = await api("POST", "/api/recharge", { amountCents: 300, method: "wechat" });
	check("码过期后同额再开是新单", second.status === 201 && second.data.recharge?.id !== first.data.recharge.id, second.data);

	// 换金额再开一张，攒第二笔未付
	const secondReal = await api("POST", "/api/recharge", { amountCents: 400, method: "wechat" });
	check("开第二张码", secondReal.status === 201, secondReal.status);
	const expired2 = await api("POST", `/api/_test/expire/${secondReal.data.recharge.id}`);
	const ban = expired2.data.abuse?.ban;
	check("第二次未付触发封禁", ban !== null && ban !== undefined && ban.level === 1, expired2.data.abuse);
	check("第一次封的是 1 小时", ban && Math.abs((ban.until - Date.now()) / 60000 - 60) < 2, ban && Math.round((ban.until - Date.now()) / 60000));

	const blocked = await api("POST", "/api/recharge", { amountCents: 600, method: "wechat" });
	check("封禁期内不能开码（429 banned）", blocked.status === 429 && blocked.data.error === "banned", blocked.data);
	check("封禁提示给了原因与时长", (blocked.data.message ?? "").includes("暂停") && (blocked.data.message ?? "").includes("分钟"), blocked.data.message);

	const lifted = await api("POST", "/api/_test/lift-ban");
	check("解禁成功", lifted.status === 200, lifted.data);
	const allowed = await api("POST", "/api/recharge", { amountCents: 700, method: "wechat" });
	check("解禁后能继续开码", allowed.status === 201, allowed.status);

	const again1 = await api("POST", `/api/_test/expire/${allowed.data.recharge.id}`);
	const abuseState = await api("GET", "/api/_test/abuse");
	check("再犯第一次不封（进度 1/2）", (abuseState.data.ban ?? null) === null && abuseState.data.strikes === 1, abuseState.data);
	const last = await api("POST", "/api/recharge", { amountCents: 800, method: "wechat" });
	const again2 = await api("POST", `/api/_test/expire/${last.data.recharge.id}`);
	const repeatBan = again2.data.abuse?.ban;
	check("再犯升级到 24 小时", repeatBan && repeatBan.level === 2 && Math.abs((repeatBan.until - Date.now()) / 3600000 - 24) < 0.2, repeatBan && Math.round((repeatBan.until - Date.now()) / 3600000));
	await api("POST", "/api/_test/lift-ban");
}

// ------------------------------------------------------------------ G
section("G 密钥不外泄");
{
	const health = await api("GET", "/api/health");
	const agent = await api("GET", "/api/agent");
	const page = await api("GET", "/");
	check("health 里没有凭证原文", !containsSecretish(health.text), health.text.slice(0, 120));
	check("agent 里没有凭证原文", !containsSecretish(agent.text), agent.text.slice(0, 120));
	check("页面里没有凭证原文", !containsSecretish(page.text), null);
}

console.log(`\n${passed} 通过 / ${failures.length} 失败`);
if (failures.length) {
	for (const name of failures) console.log(`  - ${name}`);
	process.exit(1);
}
