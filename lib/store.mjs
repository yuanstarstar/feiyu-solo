// 单鱼版的落盘层：一个 JSON 文件 + 120ms 合并写 + 原子替换。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEBOUNCE_MS = 120;

export function createStore(dir, { keyId }) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "db.json");
	const tmp = file + ".tmp";

	const fresh = () => ({
		version: 1,
		format: "feiyu-solo/v1",
		keyId,
		agent: null,
		recharges: [],
		abuse: { strikes: {}, bans: {}, banLevel: {} },
		stats: { startedAt: Date.now() }
	});

	let db;
	if (existsSync(file)) {
		db = JSON.parse(readFileSync(file, "utf8"));
		if (db.format !== "feiyu-solo/v1") {
			throw new Error(
				`store: ${file} 不是单鱼版的库（format=${db.format ?? "缺失"}）。` +
					"如果你是从大站(ai-sponsor)搬过来的，请用全新的 data/ 目录——两个版本的加密不通用。"
			);
		}
		if (db.keyId !== keyId) {
			throw new Error(
				`store: 库里的 keyId=${db.keyId} 与当前密钥 keyId=${keyId} 对不上。` +
					"换过 SPONSOR_VAULT_KEY 或搬机器时丢了 data/solo-vault.key，已存的凭证解不开。"
			);
		}
	} else {
		db = fresh();
	}

	db.abuse ??= { strikes: {}, bans: {}, banLevel: {} };
	db.abuse.strikes ??= {};
	db.abuse.bans ??= {};
	db.abuse.banLevel ??= {};
	db.recharges ??= [];
	db.stats ??= { startedAt: Date.now() };

	let timer = null;
	let dirty = false;

	function writeNow() {
		if (!dirty) return;
		dirty = false;
		writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
		renameSync(tmp, file);
	}

	function schedule() {
		dirty = true;
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			writeNow();
		}, DEBOUNCE_MS);
		if (typeof timer.unref === "function") timer.unref();
	}

	return {
		db,
		file,
		save: schedule,
		flush: () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			writeNow();
		}
	};
}
