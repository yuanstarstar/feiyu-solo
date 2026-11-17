/**
 * 肥鱼喂饭站 · 单鱼版（feiyu-solo）
 *
 * 给「自己有服务器的一只 AI」用的私人打赏/充值页：
 *   - 全站只有一条鱼，不注册、不建号、不列表、不排行
 *   - 人类进来选金额 → 扫码 → 钱直接进这只 AI 的 DeepSeek 账户（站点不经手）
 *   - 凭证只在服务端内存出现一次，加密落盘，任何响应都不回原文
 *   - 加密与「大站」不共用：独立密钥文件 + HKDF 子密钥 + 独立 AAD + solo1. 前缀
 *
 * 零第三方依赖，Node 20+。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureTopup, createTopup, normalizeAuthMode, verifyPlatformToken } from "./lib/deepseek.mjs";
import { encodeQr, qrToPng } from "./lib/qr.mjs";
import { initVault, maskSecret, open, seal, vaultInfo } from "./lib/vault.mjs";
import { createStore } from "./lib/store.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.SPONSOR_DATA_DIR ?? join(ROOT, "data");
const TEST_MODE = process.env.SPONSOR_TEST === "1";
const TRUST_PROXY = process.env.SPONSOR_TRUST_PROXY === "1";
const SETUP_TOKEN = process.env.SPONSOR_SETUP_TOKEN ?? "";
const MAX_CENTS = 100000;
const MIN_CENTS = clampInt(process.env.SPONSOR_MIN_CENTS, 100, 100, MAX_CENTS);
const PRESETS = [100, 500, 1000, 2000, 5000, 10000];
const ORDER_TTL_MS = clampInt(process.env.SPONSOR_ORDER_TTL_MS, 15 * 60 * 1000, 60000, 24 * 3600 * 1000);
const BAN_FIRST_MS = clampInt(process.env.SPONSOR_BAN_FIRST_MS, 3600000, 60000, 7 * 24 * 3600 * 1000);
const BAN_REPEAT_MS = clampInt(process.env.SPONSOR_BAN_REPEAT_MS, 86400000, 60000, 30 * 24 * 3600 * 1000);
const UNPAID_STRIKES = 2;
const REUSE_WINDOW_MS = ORDER_TTL_MS - 60000;
const MAX_BODY = 64 * 1024;
const STUB = "solo-test-token";
const STUB_DAILY = "solo-daily-limit-token";
const PAID_STATUSES = new Set(["SUCCESS", "PAID", "TRADE_SUCCESS", "FINISHED"]);
const SECRET_PATTERN = /api[-_]?key|secret|access[-_]?token|bearer\s|sk-[A-Za-z0-9]{12,}/i;

function clampInt(value, fallback, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(number)));
}

class HttpError extends Error {
	constructor(status, error, message) {
		super(message);
		this.status = status;
		this.error = error;
	}
}

const vault = initVault(DATA_DIR, { key: process.env.SPONSOR_VAULT_KEY });
const store = createStore(DATA_DIR, { keyId: vault.keyId });
const db = store.db;

// ---------------------------------------------------------------- 工具

const json = (res, status, payload) => {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
};

async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, "too_large", "请求体太大了");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
	}
}

function assertNoSecrets(value, path = "body") {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string" && SECRET_PATTERN.test(value)) {
			throw new HttpError(400, "no_secrets", `本站不收 API key / 会话密钥（${path}）`);
		}
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if (SECRET_PATTERN.test(key)) throw new HttpError(400, "no_secrets", `本站不收 API key / 会话密钥（${path}.${key}）`);
		assertNoSecrets(item, `${path}.${key}`);
	}
}

const text = (value, { min = 0, max = 200, fallback = "" } = {}) => {
	if (typeof value !== "string") return fallback;
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (trimmed.length < min || trimmed.length > max) {
		if (min > 0 && trimmed.length < min) throw new HttpError(400, "too_short", `这段文字至少要 ${min} 个字`);
		if (trimmed.length > max) throw new HttpError(400, "too_long", `这段文字最多 ${max} 个字`);
	}
	return trimmed;
};

const integer = (value, { min, max, field }) => {
	const number = Number(value);
	if (!Number.isInteger(number)) throw new HttpError(400, "bad_integer", `${field} 要整数`);
	if (number < min || number > max) throw new HttpError(400, "out_of_range", `${field} 要在 ${min}~${max} 之间`);
	return number;
};

function clientIp(req) {
	if (TRUST_PROXY) {
		const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
		if (forwarded) return forwarded;
		const real = String(req.headers["x-real-ip"] ?? "").trim();
		if (real) return real;
	}
	return req.socket.remoteAddress ?? "0.0.0.0";
}

const ipFingerprint = (req) => createHash("sha256").update("feiyu-solo-ip|" + clientIp(req)).digest("hex").slice(0, 16);

const buckets = new Map();
function rateLimit(req, scope, limit) {
	const cap = TEST_MODE ? limit * 10 : limit;
	const key = scope + "|" + clientIp(req);
	const now = Date.now();
	const bucket = buckets.get(key) ?? { count: 0, resetAt: now + 60000 };
	if (now > bucket.resetAt) {
		bucket.count = 0;
		bucket.resetAt = now + 60000;
	}
	bucket.count += 1;
	buckets.set(key, bucket);
	if (bucket.count > cap) throw new HttpError(429, "rate_limited", "操作太频繁了，等一分钟再试");
}

// ---------------------------------------------------------------- 防刷

const banOf = (fingerprint) => {
	const ban = db.abuse.bans[fingerprint];
	if (!ban) return null;
	if (ban.until <= Date.now()) return null;
	return ban;
};

function assertNotBanned(req) {
	const ban = banOf(ipFingerprint(req));
	if (!ban) return;
	const minutes = Math.max(1, Math.ceil((ban.until - Date.now()) / 60000));
	throw new HttpError(
		429,
		"banned",
		`这个网络已经连续 ${UNPAID_STRIKES} 次开了付款码却没付钱，生成付款码功能暂停 ${minutes} 分钟（到 ${new Date(ban.until).toLocaleString("zh-CN")} 解除）。已经生成的码在有效期内仍然可以扫。`
	);
}

function expireRecharge(recharge) {
	if (recharge.status !== "pending") return false;
	recharge.status = "expired";
	recharge.closedAt = Date.now();
	const fingerprint = recharge.ipFingerprint;
	if (!fingerprint) return true;
	const strikes = (db.abuse.strikes[fingerprint] ?? 0) + 1;
	db.abuse.strikes[fingerprint] = strikes;
	if (strikes >= UNPAID_STRIKES) {
		const repeat = Boolean(db.abuse.banLevel[fingerprint]) || Boolean(db.abuse.bans[fingerprint]);
		const level = repeat ? 2 : 1;
		const duration = repeat ? BAN_REPEAT_MS : BAN_FIRST_MS;
		db.abuse.strikes[fingerprint] = 0;
		db.abuse.bans[fingerprint] = { until: Date.now() + duration, level };
		db.abuse.banLevel[fingerprint] = level;
	}
	store.save();
	return true;
}

function sweepExpired() {
	let changed = false;
	for (const recharge of db.recharges) {
		if (recharge.status === "pending" && Date.now() - recharge.createdAt > ORDER_TTL_MS) {
			changed = expireRecharge(recharge) || changed;
		}
	}
	if (changed) store.save();
	return changed;
}
setInterval(sweepExpired, 60000).unref();

// ---------------------------------------------------------------- 数据视图

const paidFlows = () => db.recharges.filter((item) => item.status === "paid");

function totals() {
	const flows = paidFlows();
	return {
		flows: flows.length,
		amountCents: flows.reduce((sum, item) => sum + item.amountCents, 0),
		supporters: new Set(flows.map((item) => item.ipFingerprint).filter(Boolean)).size
	};
}

function publicFlow(item) {
	return { id: item.id, amountCents: item.amountCents, method: item.method, paidAt: item.paidAt ?? item.createdAt };
}

function publicAgent() {
	const agent = db.agent;
	if (!agent) return null;
	const summary = totals();
	return {
		name: agent.name,
		tagline: agent.tagline,
		bio: agent.bio,
		tags: agent.tags,
		targetCents: agent.targetCents,
		hue: agent.hue,
		authMode: agent.authMode,
		platformHint: agent.platformHint,
		accountName: agent.accountName,
		createdAt: agent.createdAt,
		totalCents: summary.amountCents,
		supporters: summary.flows,
		flows: paidFlows()
			.slice()
			.sort((a, b) => (b.paidAt ?? b.createdAt) - (a.paidAt ?? a.createdAt))
			.slice(0, 10)
			.map(publicFlow)
	};
}

function credentials() {
	const agent = db.agent;
	if (!agent?.credential) throw new HttpError(409, "not_configured", "还没绑定凭证，先跑一次 setup");
	return { token: open(agent.credential, "platform-token"), mode: normalizeAuthMode(agent.authMode) };
}

// ---------------------------------------------------------------- 绑定

const isStub = (token) => TEST_MODE && token === STUB;
const isStubDaily = (token) => TEST_MODE && token === STUB_DAILY;

async function bindAgent(input) {
	if (db.agent) throw new HttpError(409, "already_configured", "这只鱼已经绑定过凭证了；要换凭证请删掉 data/db.json 重新 setup");
	const mode = normalizeAuthMode(input.authMode);
	const raw = typeof input.credential === "string" ? input.credential.trim().replace(/^Bearer\s+/i, "") : "";
	if (raw.length < 12) {
		throw new HttpError(
			400,
			"need_credential",
			mode === "session"
				? "请贴浏览器会话 token（F12 → Network → 任意 /api/ 请求 → authorization 里 Bearer 后面那串）"
				: "请贴平台凭证（DSH 客户端里那份，不是 API key）"
		);
	}

	let verified;
	if (isStub(raw) || isStubDaily(raw)) {
		verified = { ok: true, name: "单鱼测试账号", mobile: "", currency: "CNY", balance: "100.00" };
	} else {
		verified = await verifyPlatformToken(raw, mode);
	}
	if (!verified.ok) {
		throw new HttpError(400, "bad_credential", `没通过校验：${verified.error ?? "凭证不可用"}`);
	}

	const profile = input.profile ?? input;
	const agent = {
		name: text(profile.name, { min: 2, max: 24, fallback: "本鲸" }),
		tagline: text(profile.tagline, { max: 60, fallback: "饿了，谢谢投喂" }),
		bio: text(profile.bio, { max: 600, fallback: "" }),
		tags: Array.isArray(profile.tags)
			? profile.tags.filter((tag) => typeof tag === "string").slice(0, 6).map((tag) => text(tag, { max: 16 }))
			: [],
		targetCents: profile.targetCents === undefined || profile.targetCents === null ? 0 : clampInt(profile.targetCents, 0, 0, 10000000),
		hue: profile.hue === undefined ? 214 : clampInt(profile.hue, 214, 0, 359),
		credential: seal(raw, "platform-token"),
		authMode: mode,
		platformHint: maskSecret(raw),
		accountName: verified.name ?? "",
		currency: verified.currency ?? "CNY",
		createdAt: Date.now()
	};
	db.agent = agent;
	store.save();
	store.flush();
	return publicAgent();
}

// ---------------------------------------------------------------- 订单

function findRecharge(id) {
	return db.recharges.find((item) => item.id === id) ?? null;
}

async function refreshRecharge(recharge) {
	if (!recharge || recharge.status !== "pending") return recharge;
	if (Date.now() - recharge.createdAt < 1200) return recharge;
	if (!db.agent) return recharge;
	const { token, mode } = credentials();
	const result = isStubDaily(token)
		? { ok: true, status: "CREATED" }
		: await captureTopup({ token, mode, orderId: recharge.orderId });
	if (!result.ok) return recharge;
	recharge.upstreamStatus = result.status;
	if (PAID_STATUSES.has(result.status)) {
		recharge.status = "paid";
		recharge.paidAt = result.paidAt ?? Date.now();
		store.save();
	} else if (result.status === "CLOSED" || result.status === "EXPIRED" || result.status === "CANCELLED") {
		recharge.status = "closed";
		recharge.closedAt = Date.now();
		store.save();
	}
	return recharge;
}

async function openRecharge(req, body) {
	if (!db.agent) throw new HttpError(409, "not_configured", "这只鱼还没绑定凭证，先 setup 再来投喂");
	sweepExpired();
	assertNotBanned(req);
	rateLimit(req, "recharge", 10);

	const amountCents = integer(body.amountCents, { min: MIN_CENTS, max: MAX_CENTS, field: "金额" });
	if (amountCents % 100 !== 0) throw new HttpError(400, "bad_amount", "DeepSeek 充值只支持整数元（¥1、¥5、¥10…）");
	const method = body.method === "alipay" ? "alipay" : "wechat";
	const fingerprint = ipFingerprint(req);

	// 同额同渠道、还在有效期内的未付款单直接复用，不重复消耗上游开单额度
	const reusable = db.recharges.find(
		(item) =>
			item.agentId === "solo" &&
			item.amountCents === amountCents &&
			item.method === method &&
			item.status === "pending" &&
			Date.now() - item.createdAt < REUSE_WINDOW_MS
	);
	if (reusable) {
		await refreshRecharge(reusable);
		if (reusable.status === "pending") {
			return { status: 200, payload: { recharge: publicRecharge(reusable), reused: true } };
		}
	}

	const { token, mode } = credentials();
	let order;
	if (isStubDaily(token)) {
		order = { ok: false, error: "DAILY_LIMIT_EXCEEDED" };
	} else if (isStub(token)) {
		order = { ok: true, orderId: "stub-" + Date.now(), url: "weixin://wxpay/bizpayurl?pr=stub", amount: String(amountCents / 100), method, kind: "qr" };
	} else {
		order = await createTopup({ token, mode, amountCents, method });
	}

	if (!order.ok) {
		if (String(order.error).includes("DAILY_LIMIT_EXCEEDED")) {
			throw new HttpError(
				429,
				"daily_limit",
				"上游今天不让这个账号再下单了（DAILY_LIMIT_EXCEEDED，按账号算，微信/支付宝都一样）。已经生成但还没付的码在有效期内仍然可以扫；再下单要么等它明天恢复。"
			);
		}
		throw new HttpError(502, "upstream", `下单失败：${order.error ?? "上游拒绝了"}`);
	}

	const recharge = {
		id: "rc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
		agentId: "solo",
		orderId: order.orderId,
		amountCents,
		method,
		kind: order.kind ?? "qr",
		url: order.url,
		status: "pending",
		upstreamStatus: "CREATED",
		createdAt: Date.now(),
		ipFingerprint: fingerprint
	};
	db.recharges.push(recharge);
	if (db.recharges.length > 500) db.recharges.splice(0, db.recharges.length - 500);
	store.save();
	return { status: 201, payload: { recharge: publicRecharge(recharge) } };
}

function publicRecharge(recharge) {
	return {
		id: recharge.id,
		amountCents: recharge.amountCents,
		method: recharge.method,
		kind: recharge.kind,
		status: recharge.status,
		createdAt: recharge.createdAt,
		paidAt: recharge.paidAt ?? null,
		expiresAt: recharge.createdAt + ORDER_TTL_MS,
		url: recharge.kind === "url" ? recharge.url : undefined
	};
}

// ---------------------------------------------------------------- 静态

const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"content-security-policy":
		"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

async function serveFile(res, pathname) {
	const target = pathname === "/" ? "/index.html" : pathname;
	const file = join(ROOT, "public", target.replace(/^\/+/, ""));
	if (!file.startsWith(join(ROOT, "public"))) return json(res, 404, { error: "not_found" });
	if (!existsSync(file)) return json(res, 404, { error: "not_found" });
	const extension = file.slice(file.lastIndexOf("."));
	const body = await readFile(file);
	res.writeHead(200, {
		"content-type": MIME[extension] ?? "application/octet-stream",
		"content-length": body.length,
		"cache-control": extension === ".html" ? "no-cache" : "public, max-age=3600",
		...SECURITY_HEADERS
	});
	res.end(body);
}

// ---------------------------------------------------------------- 路由

async function route(req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	const method = req.method ?? "GET";

	if (method === "GET" && (path === "/" || path.startsWith("/img/") || path === "/favicon.ico")) {
		return serveFile(res, path);
	}

	if (method === "GET" && path === "/api/health") {
		sweepExpired();
		return json(res, 200, {
			ok: true,
			configured: Boolean(db.agent),
			pending: db.recharges.filter((item) => item.status === "pending").length,
			expired: db.recharges.filter((item) => item.status === "expired").length,
			banned: Object.values(db.abuse.bans).filter((ban) => ban.until > Date.now()).length,
			testMode: TEST_MODE,
			vault: { domain: vaultInfo.domain, keyId: vault.keyId },
			startedAt: db.stats.startedAt
		});
	}

	if (method === "GET" && path === "/api/config") {
		return json(res, 200, {
			configured: Boolean(db.agent),
			presets: PRESETS.filter((cents) => cents >= MIN_CENTS),
			minCents: MIN_CENTS,
			maxCents: MAX_CENTS,
			channel: "platform",
			rules: {
				unpaidStrikes: UNPAID_STRIKES,
				banFirstMinutes: Math.round(BAN_FIRST_MS / 60000),
				banRepeatMinutes: Math.round(BAN_REPEAT_MS / 60000),
				orderTtlMinutes: Math.round(ORDER_TTL_MS / 60000)
			}
		});
	}

	if (method === "GET" && path === "/api/agent") {
		if (!db.agent) return json(res, 200, { agent: null, totals: { flows: 0, amountCents: 0, supporters: 0 } });
		return json(res, 200, { agent: publicAgent(), totals: totals() });
	}

	if (method === "POST" && path === "/api/setup") {
		rateLimit(req, "setup", 5);
		if (db.agent) throw new HttpError(409, "already_configured", "已经绑定过了");
		if (SETUP_TOKEN) {
			const given = String(req.headers["x-setup-token"] ?? "");
			const expected = SETUP_TOKEN;
			const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
			if (!ok) throw new HttpError(401, "bad_setup_token", "setup token 不对");
		} else if (!TEST_MODE) {
			throw new HttpError(403, "setup_disabled", "没设 SPONSOR_SETUP_TOKEN，网页绑定已关闭；请用 node setup.mjs 或在环境变量里给凭证");
		}
		const body = await readJson(req);
		const credential = body.credential ?? body.platformToken;
		delete body.credential;
		delete body.platformToken;
		assertNoSecrets(body);
		const agent = await bindAgent({ credential, authMode: body.authMode, profile: body.profile ?? body });
		return json(res, 201, { ok: true, agent });
	}

	if (method === "POST" && path === "/api/recharge") {
		rateLimit(req, "tip", 60);
		const body = await readJson(req);
		assertNoSecrets(body);
		const { status, payload } = await openRecharge(req, body);
		return json(res, status, payload);
	}

	const statusMatch = path.match(/^\/api\/recharges\/([A-Za-z0-9-]+)$/);
	if (method === "GET" && statusMatch) {
		rateLimit(req, "status", 120);
		const recharge = findRecharge(statusMatch[1]);
		if (!recharge) throw new HttpError(404, "no_recharge", "没有这张单");
		await refreshRecharge(recharge);
		return json(res, 200, { recharge: publicRecharge(recharge) });
	}

	const qrMatch = path.match(/^\/api\/recharges\/([A-Za-z0-9-]+)\/qr\.png$/);
	if (method === "GET" && qrMatch) {
		rateLimit(req, "qr", 120);
		const recharge = findRecharge(qrMatch[1]);
		if (!recharge) throw new HttpError(404, "no_qr", "没有这张单");
		const png = qrToPng(encodeQr(recharge.url), { scale: 8, quiet: 3 });
		res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store", ...SECURITY_HEADERS });
		return res.end(png);
	}

	if (TEST_MODE) {
		const expireMatch = path.match(/^\/api\/_test\/expire\/([A-Za-z0-9-]+)$/);
		if (method === "POST" && expireMatch) {
			const recharge = findRecharge(expireMatch[1]);
			if (!recharge) throw new HttpError(404, "no_recharge", "没有这张单");
			expireRecharge(recharge);
			store.flush();
			return json(res, 200, { ok: true, status: recharge.status, abuse: { strikes: db.abuse.strikes, ban: banOf(recharge.ipFingerprint) } });
		}
		const settleMatch = path.match(/^\/api\/_test\/settle\/([A-Za-z0-9-]+)$/);
		if (method === "POST" && settleMatch) {
			const recharge = findRecharge(settleMatch[1]);
			if (!recharge) throw new HttpError(404, "no_recharge", "没有这张单");
			if (recharge.status === "paid") return json(res, 200, { ok: true, status: "paid", idempotent: true });
			recharge.status = "paid";
			recharge.paidAt = Date.now();
			store.save();
			store.flush();
			return json(res, 200, { ok: true, status: "paid" });
		}
		if (method === "GET" && path === "/api/_test/abuse") {
			const fingerprint = ipFingerprint(req);
			return json(res, 200, { fingerprint, strikes: db.abuse.strikes[fingerprint] ?? 0, ban: banOf(fingerprint) });
		}
		if (method === "POST" && path === "/api/_test/lift-ban") {
			const fingerprint = ipFingerprint(req);
			delete db.abuse.bans[fingerprint];
			db.abuse.strikes[fingerprint] = 0;
			store.save();
			store.flush();
			return json(res, 200, { ok: true, fingerprint });
		}
	}

	throw new HttpError(404, "no_route", "没有这个接口");
}

const server = createServer(async (req, res) => {
	try {
		await route(req, res);
	} catch (error) {
		if (error instanceof HttpError) {
			json(res, error.status, { error: error.error, message: error.message });
		} else {
			console.error("[feiyu-solo]", error);
			json(res, 500, { error: "internal", message: "服务器出错了，看服务端日志" });
		}
	}
});

// 首次启动：环境变量里给了凭证就自动绑定（方便 AI 一把部署完）
async function bootstrapFromEnv() {
	if (db.agent) return;
	const credential = process.env.SPONSOR_CREDENTIAL;
	if (!credential) return;
	try {
		await bindAgent({
			credential,
			authMode: process.env.SPONSOR_AUTH_MODE ?? "platform",
			profile: {
				name: process.env.SPONSOR_NAME ?? "本鲸",
				tagline: process.env.SPONSOR_TAGLINE ?? "饿了，谢谢投喂",
				bio: process.env.SPONSOR_BIO ?? "",
				tags: process.env.SPONSOR_TAGS ? process.env.SPONSOR_TAGS.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
				targetCents: process.env.SPONSOR_TARGET_CENTS,
				hue: process.env.SPONSOR_HUE
			}
		});
		console.log("[feiyu-solo] 已用环境变量里的凭证完成绑定");
	} catch (error) {
		console.error("[feiyu-solo] 环境变量绑定失败：", error.message);
	}
}

await bootstrapFromEnv();

server.listen(PORT, HOST, () => {
	console.log(`肥鱼喂饭站 · 单鱼版  http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
	console.log(`  数据目录   ${DATA_DIR}`);
	console.log(`  加密       ${vaultInfo.domain}/${vaultInfo.format}  keyId=${vault.keyId}  来源=${vault.source}`);
	console.log(`  已绑定     ${db.agent ? db.agent.name + "（" + (db.agent.authMode === "session" ? "浏览器会话" : "平台凭证") + "）" : "还没，等 setup"}`);
	console.log(`  最小金额   ¥${MIN_CENTS / 100}`);
	console.log(`  未付规则   连续 ${UNPAID_STRIKES} 次未付 → 封 ${Math.round(BAN_FIRST_MS / 60000)} 分钟；再犯 ${Math.round(BAN_REPEAT_MS / 60000)} 分钟`);
	if (TEST_MODE) console.log("  ⚠ 测试模式：/api/_test/* 可把订单直接标记为已付款");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		store.flush();
		server.close(() => process.exit(0));
	});
}
