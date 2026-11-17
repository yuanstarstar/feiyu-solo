// 单鱼版（feiyu-solo）的加密层。
//
// 与「大站」(ai-sponsor) 刻意不共用：
//   1. 主密钥文件不同：data/solo-vault.key（大站是 data/.vault-key）
//   2. 子密钥不同：用 HKDF 从主密钥派生出专用子密钥，salt/info 都带 solo 域
//   3. AAD 不同：每条密文绑定字段名与域标记 feiyu-solo|v1|
//   4. 密文前缀不同：solo1. 开头，拿到大站的密文在这里解不开，反之亦然
// 所以就算两边主密钥恰好一样，密文也不能互解；想共用得先换库。
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOMAIN = "feiyu-solo";
const FORMAT = "v1";
const PREFIX = "solo1.";
const KEY_FILE = "solo-vault.key";
const HKDF_SALT = Buffer.from("feiyu-solo:hkdf:salt:v1", "utf8");
const HKDF_INFO = Buffer.from("feiyu-solo:vault-key:v1", "utf8");

let cached = null;

function decodeMaster(value, source) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`vault: ${source} 是空的`);
	const text = value.trim();
	if (/^[A-Za-z0-9+/=_-]{32,}$/.test(text) && !text.includes(" ")) {
		const buffer = Buffer.from(text, /[-_]/.test(text) ? "base64url" : "base64");
		if (buffer.length >= 32) return buffer.subarray(0, 32);
	}
	// 允许直接给 32 字节以上的原始字符串（方便 openssl rand -hex 之类）
	const raw = Buffer.from(text, "utf8");
	if (raw.length < 32) throw new Error(`vault: ${source} 太短，至少要 32 字节（推荐 openssl rand -base64 32）`);
	return raw.subarray(0, 32);
}

/**
 * 初始化加密层。
 * @param {string} dataDir 数据目录（密钥文件会写在这里）
 * @param {object} [options] { key: 环境变量里给的主密钥; allowGenerate: 没有密钥时是否自动生成 }
 */
export function initVault(dataDir, options = {}) {
	const allowGenerate = options.allowGenerate !== false;
	mkdirSync(dataDir, { recursive: true });
	const keyPath = join(dataDir, KEY_FILE);
	let master;
	let source;

	if (options.key) {
		master = decodeMaster(options.key, "SPONSOR_VAULT_KEY");
		source = "env";
	} else if (existsSync(keyPath)) {
		master = decodeMaster(readFileSync(keyPath, "utf8"), keyPath);
		source = "file";
	} else if (allowGenerate) {
		master = randomBytes(32);
		writeFileSync(keyPath, master.toString("base64") + "\n", { mode: 0o600 });
		try { chmodSync(keyPath, 0o600); } catch { /* Windows 上忽略 */ }
		source = "generated";
	} else {
		throw new Error(`vault: 找不到密钥，也没有给 SPONSOR_VAULT_KEY（应该在 ${keyPath}）`);
	}

	const subkey = Buffer.from(hkdfSync("sha256", master, HKDF_SALT, HKDF_INFO, 32));
	const keyId = createHash("sha256").update(subkey).digest("hex").slice(0, 12);
	cached = { subkey, keyId, source, keyPath };
	return { keyId, source, keyPath };
}

function state() {
	if (!cached) throw new Error("vault: 还没 initVault()");
	return cached;
}

function aad(field) {
	return Buffer.from(`${DOMAIN}|${FORMAT}|${field}`, "utf8");
}

/** 加密一个字段，得到 solo1. 开头的字符串 */
export function seal(plain, field = "credential") {
	if (typeof plain !== "string" || plain === "") throw new Error("vault: 不给空值加密");
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", state().subkey, iv);
	cipher.setAAD(aad(field));
	const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

/** 解密；换过密钥或字段名对不上都会抛错 */
export function open(sealed, field = "credential") {
	if (typeof sealed !== "string" || !sealed.startsWith(PREFIX)) {
		throw new Error("vault: 这不是本版本的密文（缺少 solo1. 前缀），可能是大站的数据或未加密的旧值");
	}
	const buffer = Buffer.from(sealed.slice(PREFIX.length), "base64");
	const iv = buffer.subarray(0, 12);
	const tag = buffer.subarray(12, 28);
	const body = buffer.subarray(28);
	const decipher = createDecipheriv("aes-256-gcm", state().subkey, iv);
	decipher.setAAD(aad(field));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** 掩码：sk-abcd****wxyz / abcd****wxyz */
export function maskSecret(value) {
	if (typeof value !== "string" || value.length < 8) return "****";
	return value.slice(0, 6) + "****" + value.slice(-4);
}

export const vaultInfo = {
	domain: DOMAIN,
	format: FORMAT,
	prefix: PREFIX,
	keyFile: KEY_FILE,
	keyId: () => state().keyId
};
