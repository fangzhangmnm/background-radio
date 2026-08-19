// player-logic 纯决策层 mock 测（node test/player-logic.test.mjs；node≥22 直接吃 .ts import）。
// 含两轮 iPad 真机战例的回放断言——逻辑层的坑先在这死，不转嫁真机。
import assert from "node:assert/strict";
import { resolveAvail, nextOf, classifyNextReady, decideBoundary, decideStartPlayback, decideHeal } from "../src/player-logic.ts";

let n = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

// ── 夹具 ────────────────────────────────────────────────────────────────
const cov = (bytes, headBytes, totalBytes) => ({ bytes, headBytes, totalBytes, complete: bytes === totalBytes && headBytes === totalBytes });
const mockFile = ({ local = false, c = null } = {}) => ({ isKeptOffline: async () => local, stagingCoverage: async () => c });
const HEAD = 512 * 1024;
// spike 真机列表序（Unicode：丙<乙<甲——「丙→乙」本来就是顺序接曲，两轮战报的地基事实）
const TRACKS = ["丙", "乙", "甲"];

// ── resolveAvail ────────────────────────────────────────────────────────
eq(await resolveAvail(mockFile({ local: true })), { kind: "local" });
eq(await resolveAvail(mockFile({ c: cov(4, 4, 10) })), { kind: "staged", cov: cov(4, 4, 10) });
eq(await resolveAvail(mockFile()), { kind: "none" });

// ── nextOf：循环取模 + 不在列表 ─────────────────────────────────────────
eq(nextOf(TRACKS, "丙"), "乙", "丙的下一曲=乙（列表序，非 bug）");
eq(nextOf(TRACKS, "甲"), "丙", "尾接头");
eq(nextOf(TRACKS, "不存在"), null);
eq(nextOf([], "丙"), null);
eq(nextOf(["独"], "独"), "独", "单曲夹自环");

// ── classifyNextReady ───────────────────────────────────────────────────
eq(classifyNextReady({ kind: "local" }, HEAD), "ready-full");
eq(classifyNextReady({ kind: "staged", cov: cov(10, 10, 10) }, HEAD), "ready-full", "缓存完整=离线也可接");
eq(classifyNextReady({ kind: "staged", cov: cov(HEAD, HEAD, HEAD * 4) }, HEAD), "ready-head", "头部够=仅在线可接");
eq(classifyNextReady({ kind: "staged", cov: cov(HEAD, HEAD - 1, HEAD * 4) }, HEAD), "need-fetch", "头部不够（哪怕总量够）");
eq(classifyNextReady({ kind: "none" }, HEAD), "need-fetch");

// ── decideBoundary ──────────────────────────────────────────────────────
const B = (over) => decideBoundary({ mode: "folder", current: "丙", tracks: TRACKS, online: true, nextReady: null, ...over });
eq(B({ nextReady: { name: "乙", full: false } }), { action: "advance", to: "乙" }, "在线+头部备好=接曲（活性接力）");
eq(B({ nextReady: { name: "乙", full: true }, online: false }), { action: "advance", to: "乙" }, "离线+全量=接曲（飞行钉住批全过=①）");
eq(B({ nextReady: { name: "乙", full: false }, online: false }).action, "loop", "★战例：离线+仅头部=降级（接了必卡死，spike-9 盲步进挂死的修复）");
eq(B({}).action, "loop", "★战例「循环乙」：离线预拉甲失败→flag 空→降级（现已被离线备战解掉大半）");
eq(B({ nextReady: { name: "甲", full: true } }).action, "loop", "★战例：flag 陈旧（名对不上）绝不盲跳——移除离线后 flag 失配的挂死修复");
eq(B({ mode: "single" }), { action: "none" }, "单曲模式边界不管（audio.loop 原生管）");
eq(B({ current: null }), { action: "none" });
eq(decideBoundary({ mode: "folder", current: "孤", tracks: [], online: true, nextReady: null }).action, "loop", "列表空=无下一曲降级");

// ── decideStartPlayback（护栏收窄）────────────────────────────────────────
const S = (online, avail) => decideStartPlayback({ online, avail });
eq(S(true, { kind: "none" }), { allow: true }, "在线一律放行（不打 IDB 查询也行）");
eq(S(false, { kind: "local" }), { allow: true }, "离线+已钉=放行");
eq(S(false, { kind: "staged", cov: cov(10, 10, 10) }).allow, true, "离线+缓存完整=放行");
eq(S(false, { kind: "staged", cov: cov(5, 0, 10) }).allow, false, "★离线+有洞=拦（user 拍板「能播=能播完」）");
assert.match(S(false, { kind: "staged", cov: cov(5, 0, 10) }).why, /50%/, "拦的时候说清有多少");
eq(S(false, { kind: "none" }).allow, true, "★战例二轮：无缓存不拦直接试（iOS onLine 说谎误伤 + 无先响后卡死风险）");

// ── decideHeal ──────────────────────────────────────────────────────────
const H = (over) => decideHeal({ online: true, current: "乙", mode: "folder", hasError: false, loopEngaged: false, nextReady: { name: "丙", full: false }, ...over });
eq(H({ hasError: true, nextReady: null }), ["rebuild", "re-arm"], "★战例二轮：回线+错误态=重建（watchdog 兜没来的 online 事件）");
eq(H({ hasError: true, online: false, nextReady: null }), [], "离线错误态不动（重建必败）");
eq(H({ loopEngaged: true }), ["unloop", "re-arm"], "降级中+在线=解环+重备战");
eq(H({ loopEngaged: true, online: false, nextReady: { name: "丙", full: true } }), ["unloop"], "离线但下一曲全量=解环（ended 会重裁决）");
eq(H({ loopEngaged: true, online: false }), [], "★离线+仅头部=不解环（解了 ended 也只会再降级空转）");
eq(H({ nextReady: null }), ["re-arm"], "flag 空+在线=重备战");
eq(H({}), [], "稳态（在线播着、flag 齐）什么都不做——幂等");
eq(H({ current: null, hasError: true }), [], "没在播不自愈");
eq(H({ mode: "single", loopEngaged: true, hasError: true }), ["rebuild"], "单曲模式只管重建，不碰 loop（原生语义）");
eq(H({ mode: "stop", hasError: true }), []);

console.log(`player-logic mock 测：${n} 断言全过`);
