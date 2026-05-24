# 音频播放器状态机 — 三模式、位置 map、边界

## TL;DR

- 三种 loop 模式:**单曲 / 文件夹 / 放完停**。决定 `ended` 时的行为,**不**决定 prev/next 是否可见。
- 位置存成 `{ trackId → 秒 }` 的 map,不是单一指针。同一首歌从任何地方来都能恢复;别的歌不丢。
- 不同入口走不同的 startAt 语义,这块要刻意设计,否则 UX 一团乱。
- `ended` 之后 currentTrack 的位置要**显式清掉**,否则下次再播这首会从末尾恢复立刻再 `ended`,死循环。
- 切歌前要 persist 一次外出曲目的位置,但**`audio.ended === true` 时跳过**,否则会把刚清掉的"末尾位置"写回 map。

## 状态模型

```js
state = {
  browseStack: [{ id, name }, ...],   // 当前浏览路径(支持 ..)
  currentTrack: { id, name, parentFolderId } | null,
  mode: "single" | "folder" | "stop",
  positions: { [trackId]: secs },     // 每首的上次位置
  position: 0,                         // 当前曲位置的冗余镜像(便利字段)
  volume: 0..1,
};
```

`position` 字段冗余,但保留 —— 便于"app 打开恢复"路径直接读,不用先查 map。`positions[currentTrack.id]` 是权威值,持久化时两个一起写。

## 三模式行为

| 模式 | `ended` 时 | prev/next 按钮 | Media Session 锁屏 prev/next |
|---|---|---|---|
| 单曲 | `currentTime = 0; play()` | 显示且可点 | 注册且可点 |
| 文件夹 | 进同文件夹下一首,环绕 | 显示且可点 | 注册且可点 |
| 放完停 | `pause()`、位置归 0 | 显示且可点 | 注册且可点 |

注意:**prev/next 在所有模式下都常驻**。早期版本"单曲模式藏 prev/next"是个误判,因为用户在单曲模式下也可能想跳曲。

## 入口与 startAt 语义

`playTrack(item, startAt)` 是核心入口。**`startAt = null` 是"按模式决定"哨兵**,不是"忽略"。

| 入口 | startAt 传什么 | 解释 |
|---|---|---|
| 浏览器点击文件 | `null` | 从 per-track map 恢复 |
| Prev/next 按钮 | `null` | 同上,跨模式一致 |
| Media Session prev/next | `null` | 同上 |
| 文件夹 loop 自动 advance(ended → next) | `0` | 显式新开;`handleEnded` 已先 delete map 项,跟 `null` 等价但语义更清 |
| App-open resume(点 ▶ 后重建 src) | `具体秒数`(读 state.position) | 跳到上次位置 |

实现:

```js
async function playTrack(item, startAt = null) {
  // 0) 同首正在播 = 忽略(避免点了重新开始)
  if (state.currentTrack?.id === item.id && audio.src) return;
  // 1) persist 外出曲目位置(但 ended 时跳过)
  if (state.currentTrack && state.currentTrack.id !== item.id && !audio.ended) {
    persistPosition();
  }
  // 2) 解释 startAt:任何用户显式动作都从 map 恢复
  if (startAt === null) {
    startAt = state.positions[item.id] ?? 0;
  }
  // 3) 切到 item,设 src,等 loadedmetadata 跳 startAt
  ...
}
```

## resume 语义的迭代史

中间版本曾经做过 **mode-gated resume**:单曲模式恢复 map、其它模式从 0。理由是"文件夹模式更像 album 顺播,点某首 = 跳过去从头"。

**用户最后明确否决,要求全模式统一从 map 恢复**:
> 循环文件夹和只播放一次的模式里面,也都不要从头开始,而是按照上一次的进度。就是统一,都统一

教训:
- "听觉记忆" 的核心是**用户最后听到哪里**,而不是"用户从哪种模式进入这首"
- 模式决定**ended 时怎么转**(下一首 / 重头 / 停),不决定**开始位置**
- 简单规则 > 模式细分。把"开始位置"这件事抽出来只看 per-track map,所有 UI 入口路径一致

实际放上去之后:从任何地方点同一首 = 接着听。"统一"比"语义优雅"更值钱。

## `ended` 的边界

```js
function handleEnded() {
  // 这首播完了,清掉 map 里的位置 + state.position 归 0
  if (state.currentTrack) {
    delete state.positions[state.currentTrack.id];
    state.position = 0;
    saveState();
  }
  if (state.mode === "single") {
    audio.currentTime = 0;
    audio.play();
  } else if (state.mode === "folder") {
    advance("next", 0);  // 显式 0,跟 mode-gated 无关
  } else {
    audio.pause();
  }
}
```

**为什么 state.position 归 0**:不归 0 的话,5s 自动保存最后一拍存的可能是 4:55,reload 后从 4:55 恢复 → 立刻 `ended` → 再恢复 4:55 → 死循环。

**为什么 advance 用 `0` 不用 `null`**:folder loop 自动进下一首应该是"从头放",而不是"恢复下一首的上次位置"。null 在文件夹模式下也是 0,但显式写出来更清楚意图。

## 切歌时的"persist outgoing"

```js
if (state.currentTrack && state.currentTrack.id !== item.id && !audio.ended) {
  persistPosition();  // 保存外出曲目最新位置
}
```

**`!audio.ended` 这条很关键**。否则:

1. 文件夹 loop 中 A 自然 ended
2. handleEnded delete positions[A]、state.position = 0、advance("next", 0)
3. advance 调 playTrack(B, 0)
4. playTrack 顶部 persistPosition,把 audio.currentTime(= A 的 duration!)又写回 positions[A]
5. 结果:A 的 map 项被恢复到末尾位置,下次再播 A 又从末尾 → 立刻 ended → ...

`audio.ended` 在自然 ended 后为 `true`,用它跳过 persist。

## 自动保存策略

```js
setInterval(() => {
  if (!state.currentTrack || audio.paused) return;
  persistPosition();
}, 5000);

audio.addEventListener("pause", persistPosition);
window.addEventListener("beforeunload", persistPosition);
```

- 5s 间隔够细(误差最多 5s)、又不太频繁
- pause 时立刻存,防"暂停-关 tab-五秒内"丢
- beforeunload 兜底,虽然不保证一定执行

## 浏览器导航的 ".." 

不要每次重新查 parent。**用栈**:

```js
state.browseStack = [{ id: "root", name: "" }];
// 进文件夹:push
state.browseStack.push({ id: folder.id, name: folder.name });
// ..:pop
state.browseStack.pop();
// 当前文件夹:stack.at(-1).id
// 路径显示:stack.map(s => s.name).filter(Boolean).join("/")
```

栈跟 state 一起持久化,reload 后停在用户最后浏览的文件夹。
