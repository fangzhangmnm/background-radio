// id3.ts 纯函数测试：合成 v2.2/2.3/2.4 tag（文字帧各 encoding + APIC/PIC 封面）+ 边角（无 tag/截断/padding）。
// 跑法：node test/id3.test.mjs（build.sh 里随 player-logic 一起跑）。
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tsc 产物不落仓：现场把 id3.ts 转成 mjs 临时件（esbuild 单文件，秒级）
const tmp = mkdtempSync(join(tmpdir(), "br-id3-"));
execSync(`"../20260524 WeebPaint/tools/esbuild/esbuild" src/id3.ts --format=esm --outfile="${join(tmp, "id3.mjs")}"`, { stdio: "pipe" });
const { id3TagFullSize, parseId3 } = await import(join(tmp, "id3.mjs"));

const enc = new TextEncoder();
const syncsafe4 = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be4 = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const be3 = (n) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const cat = (...parts) => {
  const bufs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(bufs.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
};
const frame3 = (id, body) => cat(enc.encode(id), be4(body.length), [0, 0], body);
const frame4 = (id, body) => cat(enc.encode(id), syncsafe4(body.length), [0, 0], body);
const frame2 = (id, body) => cat(enc.encode(id), be3(body.length), body);
const tag = (major, frames, pad = 0) => {
  const body = cat(...frames, new Uint8Array(pad));
  return cat(enc.encode("ID3"), [major, 0, 0], syncsafe4(body.length), body);
};
const utf16le = (s) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) & 0xff; b[3 + i * 2] = s.charCodeAt(i) >> 8; } return b; };

let n = 0;
const ok = (name, fn) => { fn(); console.log(`✓ ${name}`); n++; };

ok("无 tag → size 0 / parse null", () => {
  const mp3 = cat([0xff, 0xfb, 0x90, 0x00], new Uint8Array(16));
  assert.equal(id3TagFullSize(mp3), 0);
  assert.equal(parseId3(mp3), null);
});

ok("v2.3：TIT2 utf16(BOM LE) + TPE1 latin1 + APIC png", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const t = tag(3, [
    frame3("TIT2", cat([1], utf16le("Rainy Boots"))),
    frame3("TPE1", cat([0], enc.encode("Toromi"))),
    frame3("APIC", cat([0], enc.encode("image/png"), [0], [3], [0], png)),
  ], 32);
  assert.equal(id3TagFullSize(t), t.length - 32 + 32);   // 头 10 + body（含 padding）
  const r = parseId3(t);
  assert.equal(r.title, "Rainy Boots");
  assert.equal(r.artist, "Toromi");
  assert.equal(r.picture.mime, "image/png");
  assert.deepEqual([...r.picture.data], [...png]);
});

ok("v2.4：syncsafe 帧长 + utf-8 + 中文", () => {
  const t = tag(4, [
    frame4("TIT2", cat([3], enc.encode("夏の音"))),
    frame4("TPE1", cat([3], enc.encode("光荣"))),
  ]);
  const r = parseId3(t);
  assert.equal(r.title, "夏の音");
  assert.equal(r.artist, "光荣");
});

ok("v2.2：TT2/TP1/PIC(JPG)", () => {
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 9]);
  const t = tag(2, [
    frame2("TT2", cat([0], enc.encode("Old Song"))),
    frame2("TP1", cat([0], enc.encode("Nobody"))),
    frame2("PIC", cat([0], enc.encode("JPG"), [3], [0], jpg)),
  ]);
  const r = parseId3(t);
  assert.equal(r.title, "Old Song");
  assert.equal(r.artist, "Nobody");
  assert.equal(r.picture.mime, "image/jpeg");
  assert.deepEqual([...r.picture.data], [...jpg]);
});

ok("utf16 description 的 APIC（2 字节终结符对齐）", () => {
  const png = Uint8Array.from([0x89, 0x50, 4, 4]);
  const t = tag(3, [frame3("APIC", cat([1], enc.encode("image/png"), [0], [3], utf16le("封面"), [0, 0], png))]);
  assert.deepEqual([...parseId3(t).picture.data], [...png]);
});

ok("截断 tag（列举帧只到手上字节为止，不炸）", () => {
  const t = tag(3, [frame3("TIT2", cat([0], enc.encode("Full Title")))]);
  const cut = t.subarray(0, t.length - 4);
  const r = parseId3(cut);   // title 帧体被切——解出啥都行，就是不许 throw
  assert.ok(r === null || typeof r === "object");
});

ok("整 tag unsync 标志 → 放弃返回 null", () => {
  const t = tag(3, [frame3("TIT2", cat([0], enc.encode("X")))]);
  t[5] = 0x80;
  assert.equal(parseId3(t), null);
});

ok("空 tag（只有 padding）→ null", () => {
  assert.equal(parseId3(tag(3, [], 64)), null);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`id3 测试：${n} 组全过`);
