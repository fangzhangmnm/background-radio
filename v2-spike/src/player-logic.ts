// 纯决策层（spike-10，user 要求「逻辑层先自己 mock 过」）：零 DOM、零 store import、零平台依赖——
// 全部输入显式传参，node 直接 mock 测（test/player-logic.test.mjs，两轮真机战例都回放成断言）。
// 真机要验的只剩平台事实：SW 答 206、audio 元素行为、online/visibility 事件时序。

/** staging 覆盖快照的窄投影（对齐 store StagingCoverage，测试不用拖 store）。 */
export interface CovLike { totalBytes: number; bytes: number; headBytes: number; complete: boolean }

/** 一首曲子的字节可用性三态。 */
export type Avail =
  | { kind: "local" }                          // 正式本地副本（已钉）
  | { kind: "staged"; cov: CovLike }           // 只有 staging 残片
  | { kind: "none" };                          // 一个字节都不在机上

/** 从 file 面解析可用性（mock isKeptOffline/stagingCoverage 两个方法即可测）。 */
export async function resolveAvail(f: { isKeptOffline(): Promise<boolean>; stagingCoverage(): Promise<CovLike | null> }): Promise<Avail> {
  if (await f.isKeptOffline()) return { kind: "local" };
  const cov = await f.stagingCoverage();
  return cov ? { kind: "staged", cov } : { kind: "none" };
}

/** 列表序下一曲（循环取模）。不在列表/空列表 → null。 */
export function nextOf(tracks: string[], name: string): string | null {
  const i = tracks.indexOf(name);
  return i >= 0 && tracks.length > 0 ? tracks[(i + 1) % tracks.length] : null;
}

/** 备战判级：ready-full=离线也可接；ready-head=仅在线可接（头部够声音接力）；need-fetch=得现拉。 */
export function classifyNextReady(avail: Avail, headReadyBytes: number): "ready-full" | "ready-head" | "need-fetch" {
  if (avail.kind === "local") return "ready-full";
  if (avail.kind === "staged") {
    if (avail.cov.complete) return "ready-full";
    if (avail.cov.headBytes >= headReadyBytes) return "ready-head";
  }
  return "need-fetch";
}

/** 边界备战 flag（ended 里零异步可判）：full=离线也可接（本地/缓存完整）。 */
export type NextReady = { name: string; full: boolean } | null;

/** ★边界决策（ended 同步调）：advance 条件 = flag 对上当前列表的下一曲 && （在线 || 全量可播）。
 *  仅头部 + 离线 = 接了必在洞上卡死（spike-9 真机战例：陈 flag 盲步进 → 播放挂死）→ 宁可降级循环。
 *  flag 名对不上（列表变了/被移除离线后重备战没跟上）→ 同样降级，绝不盲跳。 */
export function decideBoundary(i: { mode: string; current: string | null; tracks: string[]; nextReady: NextReady; online: boolean }):
  | { action: "advance"; to: string }
  | { action: "loop"; reason: string }
  | { action: "none" } {
  if (i.mode !== "folder" || !i.current) return { action: "none" };
  const next = nextOf(i.tracks, i.current);
  if (!next) return { action: "loop", reason: "无下一曲" };
  if (i.nextReady?.name !== next) return { action: "loop", reason: `下一曲 ${next} 未备战/flag 陈旧` };
  if (!i.online && !i.nextReady.full) return { action: "loop", reason: "仅头部备好且离线——接了必卡死" };
  return { action: "advance", to: next };
}

/** 离线起播护栏（user 拍板「能播=能播完」+ spike-10 收窄）：只拦「有洞的部分缓存」。
 *  无缓存不拦（没缓存不存在先响后卡死——直接试，真离线秒败明说；iOS onLine 有说谎前科，拦=误伤真在线）。 */
export function decideStartPlayback(i: { online: boolean; avail: Avail }):
  | { allow: true; note?: string }
  | { allow: false; why: string } {
  if (i.online) return { allow: true };
  if (i.avail.kind === "local") return { allow: true };
  if (i.avail.kind === "none") return { allow: true, note: "无缓存直接试（onLine 可能不可信；真离线会立刻明说）" };
  if (i.avail.cov.complete) return { allow: true, note: "缓存完整" };
  return { allow: false, why: `缓存不完整 ${Math.round((i.avail.cov.bytes / i.avail.cov.totalBytes) * 100)}%（有洞——防先响后卡死）` };
}

/** 自愈决策（online 事件 / 回前台 / 8s 看门狗共用；幂等）。
 *  rebuild=重建播放（错误态且在线）；unloop=解除降级循环（下一曲已就绪且接得动——ended 会重新裁决，安全）；
 *  re-arm=重新边界备战（降级中或 flag 空，且在线才打网络）。 */
export function decideHeal(i: { online: boolean; current: string | null; mode: string; hasError: boolean; loopEngaged: boolean; nextReady: NextReady }): ("rebuild" | "unloop" | "re-arm")[] {
  const out: ("rebuild" | "unloop" | "re-arm")[] = [];
  if (!i.current || i.mode === "stop") return out;
  if (i.hasError && i.online) out.push("rebuild");
  if (i.mode !== "folder") return out;
  if (i.loopEngaged && i.nextReady && (i.online || i.nextReady.full)) out.push("unloop");
  if ((i.loopEngaged || !i.nextReady) && i.online) out.push("re-arm");
  return out;
}
