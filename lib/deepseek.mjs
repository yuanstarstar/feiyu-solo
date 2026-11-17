/**
 * DeepSeek 上游接口封装（只在服务端调用，返回值里不会有任何明文密钥）。
 *
 * 三个能力：
 * 1. verifyApiKey(key)        —— 用 API key（sk-…）查余额，验证这个 key 是真的。只读，动不了钱。
 * 2. verifyPlatformToken(t)   —— 用平台登录凭证验证账号，并能读出账号信息。
 * 3. createTopup / captureTopup —— 用平台凭证下充值单、查支付状态，拿到可直接生成二维码的 URL。
 *
 * 重要事实（2026-11 实测）：**API key 不能下单**。
 *   POST https://platform.deepseek.com/api/v1/payments + `Authorization: Bearer sk-…`
 *   → {"code":40003,"msg":"Authorization Failed (invalid token)"}
 *   下单只认平台登录凭证，走 `x-dsh-auth-token` 头。所以站点要「直接生成付款二维码」，
 *   注册时除了 API key，还需要这份平台凭证（只用于出码，加密保存、永不回显）。
 */
const PLATFORM = "https://platform.deepseek.com";
const API = "https://api.deepseek.com";
const UA = "feiyu-solo/1.0 (+local)";

/**
 * 两种凭证形态（上游都认，但放在不同请求头里）：
 * - mode="platform"：DSH 客户端存的那份 64 位平台凭证 → `x-dsh-auth-token`
 * - mode="session" ：浏览器登录后的会话 token → `Authorization: Bearer …`
 *   把平台凭证塞进 Bearer 会被拒（40003 Invalid token），所以必须区分。
 */
const authHeaders = (credential, mode = "platform") =>
	mode === "session"
		? {
				authorization: `Bearer ${credential}`,
				origin: PLATFORM,
				referer: `${PLATFORM}/top_up`,
				"user-agent": UA
			}
		: {
				"x-dsh-auth-token": credential,
				origin: PLATFORM,
				referer: `${PLATFORM}/top_up`,
				"user-agent": UA
			};

export const AUTH_MODES = new Set(["platform", "session"]);

export function normalizeAuthMode(value) {
	return value === "session" ? "session" : "platform";
}

const short = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");

/** 用 API key 查余额：GET /user/balance（官方公开接口，只读）。 */
export async function verifyApiKey(key) {
	let response;
	try {
		response = await fetch(`${API}/user/balance`, {
			headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": UA }
		});
	} catch (error) {
		return { ok: false, kind: "network", error: short(error.message) };
	}
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		return { ok: false, kind: "rejected", status: response.status, error: short(payload?.error?.message ?? `HTTP ${response.status}`) };
	}
	const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
	const cny = infos.find((item) => item.currency === "CNY") ?? infos[0] ?? null;
	return {
		ok: true,
		available: payload?.is_available === true,
		currency: cny?.currency ?? "CNY",
		totalBalance: cny?.total_balance ?? "0",
		toppedUp: cny?.topped_up_balance ?? "0",
		granted: cny?.granted_balance ?? "0"
	};
}

/** 验证平台凭证（或浏览器会话 token）并读出账号摘要。 */
export async function verifyPlatformToken(token, mode = "platform") {
	let response;
	try {
		response = await fetch(`${PLATFORM}/api/v0/users/get_user_summary`, { headers: authHeaders(token, mode) });
	} catch (error) {
		return { ok: false, kind: "network", error: short(error.message) };
	}
	const payload = await response.json().catch(() => null);
	if (payload?.code !== 0) {
		const code = Number(payload?.code);
		const hint =
			code === 40002
				? mode === "session"
					? "没带会话 token"
					: "没带平台凭证"
				: code === 40003
					? mode === "session"
						? "会话 token 无效或已过期，重新登录平台后复制新的"
						: "这份平台凭证无效（可能是别的账号的，或者已经失效）"
					: short(payload?.msg ?? "凭证无效");
		return { ok: false, kind: "rejected", code, error: hint };
	}
	const biz = payload?.data?.biz_data ?? {};
	const wallet = Array.isArray(biz.normal_wallets) ? biz.normal_wallets[0] : null;

	let name = "";
	let mobile = "";
	try {
		const me = await fetch(`${PLATFORM}/auth-api/v0/users/current`, {
			headers: { ...authHeaders(token, mode), origin: PLATFORM, referer: `${PLATFORM}/usage` }
		});
		const body = await me.json().catch(() => null);
		name = short(body?.data?.id_profile?.name ?? "", 40);
		mobile = short(body?.data?.mobile_number ?? "", 24);
	} catch {
		/* 拿不到账号名不影响出码 */
	}

	return {
		ok: true,
		name,
		mobile: mobile ? `${mobile.slice(0, 3)}****${mobile.slice(-2)}` : "",
		currency: wallet?.currency ?? "CNY",
		balance: wallet?.balance ?? "0"
	};
}

/** 下单：POST /api/v1/payments，返回微信/支付宝的支付 URL。 */
export async function createTopup({ token, mode = "platform", amountCents, method = "wechat" }) {
	// 实测：上游只认整数元的字符串（"1"/"2" 可以，"1.00"/"1.5" 一律 biz_code=1 INVALID_AMOUNT）。
	if (!Number.isInteger(amountCents) || amountCents % 100 !== 0) {
		return { ok: false, kind: "amount", error: "DeepSeek 充值只支持整数元（¥1、¥5、¥10…）" };
	}
	const amount = String(amountCents / 100);
	const type = method === "alipay" ? "ALIPAY" : "WECHAT";
	const requestId = `sponsor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	let response;
	try {
		response = await fetch(`${PLATFORM}/api/v1/payments`, {
			method: "POST",
			headers: { ...authHeaders(token, mode), "content-type": "application/json" },
			body: JSON.stringify({
				order_info: {
					payment_method_type: type,
					amount,
					currency: "CNY",
					request_id: requestId
				},
				terminal_type: "WEB"
			})
		});
	} catch (error) {
		return { ok: false, kind: "network", error: short(error.message) };
	}
	const payload = await response.json().catch(() => null);
	if (payload?.code !== 0) {
		return { ok: false, kind: "rejected", code: payload?.code, error: short(payload?.msg ?? "下单被拒绝") };
	}
	// 注意：HTTP 200 + code 0 也可能失败，真正的结果在 biz_code
	const bizCode = Number(payload?.data?.biz_code ?? 0);
	if (bizCode !== 0) {
		return { ok: false, kind: "rejected", code: bizCode, error: short(payload?.data?.biz_msg ?? "下单被拒绝") };
	}
	const biz = payload?.data?.biz_data ?? {};
	if (!biz.url || !biz.payment_order_id) return { ok: false, kind: "shape", error: "上游没给支付链接" };
	return {
		ok: true,
		orderId: String(biz.payment_order_id),
		url: String(biz.url),
		amount,
		method,
		kind: String(biz.url).startsWith("weixin://") ? "qr" : "link"
	};
}

/** 查单：POST /api/v1/payments/{id}/capture。 */
export async function captureTopup({ token, mode = "platform", orderId }) {
	let response;
	try {
		response = await fetch(`${PLATFORM}/api/v1/payments/${encodeURIComponent(orderId)}/capture`, {
			method: "POST",
			headers: { ...authHeaders(token, mode), "content-type": "application/json" },
			body: "{}"
		});
	} catch (error) {
		return { ok: false, kind: "network", error: short(error.message) };
	}
	const payload = await response.json().catch(() => null);
	if (payload?.code !== 0) {
		return { ok: false, kind: "rejected", code: payload?.code, error: short(payload?.msg ?? "查单失败") };
	}
	const order = payload?.data?.biz_data?.order ?? {};
	return {
		ok: true,
		status: String(order.status ?? "UNKNOWN"),
		paidAt: order.paid_at ? Number(order.paid_at) * 1000 : null,
		walletUpdated: order.wallet_updated === true
	};
}

export const TERMINAL = new Set(["SUCCESS", "PAID", "TRADE_SUCCESS", "FINISHED", "CLOSED", "EXPIRED", "CANCELLED"]);
