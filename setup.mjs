#!/usr/bin/env node
/**
 * 单鱼版的「绑定」命令行：给不想开网页绑定的 AI / 服务器用。
 *
 * 用法：
 *   # 凭证从环境变量读（推荐，不出现在 shell 历史里）
 *   SPONSOR_CREDENTIAL='<平台凭证>' node setup.mjs --name 本鲸 --tagline "饿了" --target 20
 *
 *   # 或者从标准输入粘（会提示，粘贴后回车）
 *   node setup.mjs --name 本鲸
 *
 *   # 换一条鱼（会覆盖原来的绑定）
 *   node setup.mjs --force
 *
 * 它做的事和网页上的 POST /api/setup 完全一样：先向上游验证一次凭证 → 用 solo1. 加密 → 写进 data/db.json。
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { normalizeAuthMode, verifyPlatformToken } from "./lib/deepseek.mjs";
import { initVault, maskSecret, seal, vaultInfo } from "./lib/vault.mjs";
import { createStore } from "./lib/store.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
	const index = args.indexOf(`--${name}`);
	if (index === -1) return fallback;
	if (index + 1 < args.length && !args[index + 1].startsWith("--")) return args[index + 1];
	return true;
};

const DATA_DIR = process.env.SPONSOR_DATA_DIR ?? new URL("./data", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TEST_MODE = process.env.SPONSOR_TEST === "1";
const vault = initVault(DATA_DIR, { key: process.env.SPONSOR_VAULT_KEY });
const store = createStore(DATA_DIR, { keyId: vault.keyId });
const db = store.db;

const force = flag("force") === true;
if (db.agent && !force) {
	console.error(`已经绑定过了：${db.agent.name}（${db.agent.platformHint}）。要换请加 --force。`);
	process.exit(1);
}

const mode = normalizeAuthMode(flag("mode", process.env.SPONSOR_AUTH_MODE ?? "platform"));
let credential = String(process.env.SPONSOR_CREDENTIAL ?? "").trim();

if (!credential) {
	const rl = createInterface({ input, output });
	const typed = await rl.question(mode === "session" ? "粘贴浏览器会话 token（回车确认）：" : "粘贴平台凭证（回车确认）：");
	rl.close();
	credential = typed.trim();
}
credential = credential.replace(/^Bearer\s+/i, "");

if (credential.length < 12) {
	console.error("凭证太短了，没敢往下走。");
	process.exit(1);
}

const STUB = "solo-test-token";
let verified;
if (TEST_MODE && credential === STUB) {
	verified = { ok: true, name: "单鱼测试账号", currency: "CNY", balance: "100.00" };
} else {
	verified = await verifyPlatformToken(credential, mode);
}
if (!verified.ok) {
	console.error(`验证没过：${verified.error ?? "凭证不可用"}`);
	process.exit(1);
}

const targetYuan = flag("target");
const hue = flag("hue");
const tags = flag("tags");

db.agent = {
	name: String(flag("name", "本鲸")),
	tagline: String(flag("tagline", "饿了，谢谢投喂")),
	bio: String(flag("bio", "")),
	tags: typeof tags === "string" ? tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 6) : [],
	targetCents: targetYuan === undefined ? 0 : Math.max(0, Math.trunc(Number(targetYuan) * 100) || 0),
	hue: hue === undefined ? 214 : Math.min(359, Math.max(0, Math.trunc(Number(hue)) || 0)),
	credential: seal(credential, "platform-token"),
	authMode: mode,
	platformHint: maskSecret(credential),
	accountName: verified.name ?? "",
	currency: verified.currency ?? "CNY",
	createdAt: Date.now()
};
store.save();
store.flush();

console.log("绑定完成：");
console.log("  名字       " + db.agent.name);
console.log("  账号       " + (db.agent.accountName || "（上游没返回昵称）"));
console.log("  凭证       " + db.agent.platformHint + "  [" + db.agent.authMode + "]");
console.log("  加密       " + vaultInfo.domain + "/" + vaultInfo.format + "  keyId=" + vault.keyId);
console.log("  数据文件   " + store.file);
console.log("");
console.log("下一步：node server.mjs  →  打开 http://127.0.0.1:" + (process.env.PORT ?? 8790));
