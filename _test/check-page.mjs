// 页面结构体检：内联脚本语法、HTML 的 id 与 JS 引用是否对得上、关键文案在不在
// 用法：node _test/check-page.mjs [--base http://127.0.0.1:8791]
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (() => {
	const index = process.argv.indexOf("--base");
	return (index >= 0 ? process.argv[index + 1] : "http://127.0.0.1:8791").replace(/\/+$/, "");
})();

let failures = 0;
const check = (name, condition, extra) => {
	if (condition) console.log(`  ✓ ${name}`);
	else {
		failures += 1;
		console.log(`  ✗ ${name}${extra === undefined ? "" : `  → ${extra}`}`);
	}
};

const response = await fetch(base + "/");
const html = await response.text();
console.log(`页面 ${base}/ → ${response.status}  ${html.length} 字符`);
check("首页 200", response.status === 200, response.status);

const markers = ["肥鱼喂饭站", "生成付款码", "/img/whalechan.png", "累计被投喂", "只显示真的付过钱的流水"];
for (const marker of markers) check(`文案包含「${marker}」`, html.includes(marker), null);
check("没有残留大站的榜单结构", !html.includes("喂饭榜"), null);
check("没有残留 apiKey 输入", !/id="s?[Aa]piKey/.test(html), null);
check("没有残留 mock 支付", !html.includes("先假装付了"), null);

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const refs = new Set([
	...[...html.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
	...[...html.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1])
]);
const missing = [...refs].filter((id) => !ids.has(id));
check(`HTML 有 ${ids.size} 个 id、JS 引用 ${refs.size} 个，全都存在`, missing.length === 0, missing.join(", "));

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
check("页面里有内联脚本", scripts.length > 0, scripts.length);

const dir = mkdtempSync(join(tmpdir(), "solo-page-"));
try {
	scripts.forEach((code, index) => {
		const file = join(dir, `inline-${index}.mjs`);
		writeFileSync(file, code, "utf8");
		const result = spawnSync(process.execPath, ["--check", file], { stdio: "ignore" });
		check(`内联脚本 #${index + 1} 语法正确（${code.length} 字符）`, result.status === 0, `status=${result.status} signal=${result.signal} error=${result.error?.code}`);
	});
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n页面体检通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
