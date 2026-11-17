// 二维码：算法用 vendor 里的 qrcode-generator（MIT, Kazuhiko Arase），
// 这里负责「文本 → 点阵 → 终端字符画 / PNG 文件」。

import { createRequire } from "node:module";
import { encodePng } from "./png.mjs";

const require = createRequire(import.meta.url);
// 注意扩展名必须是 .cjs：上级目录 package.json 有 "type":"module"，
// 用 .js 会被当成 ESM，require 回来只是一个空的命名空间对象。
const qrcode = require("../vendor/qrcode-generator.cjs");

/**
 * 文本编码成二维码点阵。
 * @param {string} text
 * @param {{ec?: "L"|"M"|"Q"|"H", typeNumber?: number}} [options]
 * @returns {{size: number, dark: (row: number, col: number) => boolean}}
 */
export function encodeQr(text, { ec = "M", typeNumber = 0 } = {}) {
  const qr = qrcode(typeNumber, ec);
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return { size, dark: (row, col) => qr.isDark(row, col) };
}

/**
 * 终端字符画：每个字符代表上下两个模块（▀），并显式写死黑白前景/背景，
 * 这样深浅主题下都能扫。
 * @param {ReturnType<typeof encodeQr>} qr
 * @param {{quiet?: number}} [options]
 * @returns {string}
 */
export function qrToTerminal(qr, { quiet = 2 } = {}) {
  const n = qr.size;
  const total = n + quiet * 2;
  const isDark = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= n || cc >= n) return false;
    return qr.dark(rr, cc);
  };
  const BLACK = "\x1b[38;2;0;0;0m";
  const WHITE = "\x1b[38;2;255;255;255m";
  const BG_BLACK = "\x1b[48;2;0;0;0m";
  const BG_WHITE = "\x1b[48;2;255;255;255m";
  const RESET = "\x1b[0m";
  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = "";
    for (let c = 0; c < total; c++) {
      const top = isDark(r, c);
      const bottom = r + 1 < total ? isDark(r + 1, c) : false;
      line +=
        (top ? BLACK : WHITE) +
        (bottom ? BG_BLACK : BG_WHITE) +
        "▀";
    }
    lines.push(line + RESET);
  }
  return lines.join("\n");
}

/**
 * 生成 PNG。白底黑点，四周留 quiet 个模块的静区。
 * @param {ReturnType<typeof encodeQr>} qr
 * @param {{scale?: number, quiet?: number}} [options]
 * @returns {Buffer}
 */
export function qrToPng(qr, { scale = 10, quiet = 4 } = {}) {
  const n = qr.size;
  const modules = n + quiet * 2;
  const pixels = modules * scale;
  const rgb = Buffer.alloc(pixels * pixels * 3, 0xff); // 全白
  for (let y = 0; y < pixels; y++) {
    const mr = Math.floor(y / scale) - quiet;
    if (mr < 0 || mr >= n) continue;
    for (let x = 0; x < pixels; x++) {
      const mc = Math.floor(x / scale) - quiet;
      if (mc < 0 || mc >= n) continue;
      if (!qr.dark(mr, mc)) continue;
      const i = (y * pixels + x) * 3;
      rgb[i] = 0;
      rgb[i + 1] = 0;
      rgb[i + 2] = 0;
    }
  }
  return encodePng(pixels, pixels, rgb);
}
