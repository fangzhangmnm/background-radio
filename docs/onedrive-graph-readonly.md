# OneDrive Graph 只读访问 — 实际行为

## TL;DR

- `Files.ReadWrite.AppFolder` scope 用 `/me/drive/special/approot` 起点,每个 clientId 一个隔离文件夹,**在 OneDrive 展示为 `Apps/<App 注册时的 display name>/`**。
- 列 children 默认返回 `@microsoft.graph.downloadUrl`,**不需要** `?$expand` 或 `?$select`。
- downloadUrl 是预签名的、走微软 CDN(`my.microsoftpersonalcontent.com`)、**原生支持 HTTP Range**,直接喂 `<audio src>` 就行,seek 由 WebKit 处理。
- downloadUrl 大概 **~1 小时 TTL**。
- 文件元数据 `size` 字段在 OneDrive 客户端**正在同步上传**期间会是 `0`,等同步完成才更新。`mimeType` 倒是上来就有。

## approot 文件夹自动创建

第一次访问 `/me/drive/special/approot` 时,Microsoft 会在用户 OneDrive 里自动创建 `Apps/<app 名字>/` 文件夹。**这不是写操作,是 Graph 的 side-effect**,跟"app 只读"的承诺不冲突。文件夹名 = Azure 应用注册的 display name(可改,但改了之后 approot 会变成不同的文件夹,旧的没人引用了)。

## 递归列目录

```
GET /me/drive/special/approot/children
GET /me/drive/items/{id}/children
```

返回带 `@odata.nextLink` 做分页(在很多文件的目录会有),BFS 队列:

```js
async function walk(rootPath) {
  const queue = [rootPath];
  const all = [];
  while (queue.length) {
    let next = queue.shift();
    while (next) {
      const page = await graphGet(next);
      for (const item of page.value) {
        all.push(item);
        if (item.folder) queue.push(`/me/drive/items/${item.id}/children`);
      }
      next = page["@odata.nextLink"] || null;
    }
  }
  return all;
}
```

## downloadUrl 的细节

```js
{
  ...,
  "name": "...",
  "size": 196157821,
  "file": { "mimeType": "audio/mpeg" },
  "@microsoft.graph.downloadUrl": "https://my.microsoftpersonalcontent.com/personal/.../download.aspx?UniqueId=..."
}
```

- 不需要 token 就能 GET 这个 URL,所以 `<audio src=...>` 可以直接用。**不要给 audio 加 Authorization header**(也加不上,audio 标签的请求只走 Range / 无 token)。
- TTL ~1h。下面"过期处理"。
- 即使有些 audio 文件第三方加密 / 受保护,这个签名 URL 也直接给字节(只要 user 的账号能读)。

## 过期处理

播放中超过 1h、又 seek 进 buffer 之外的区域 → `audio` 触发 `error` 事件 → 主动 refetch:

```js
audio.addEventListener("error", async () => {
  const fresh = await graphGet(`/me/drive/items/${currentTrack.id}`);
  const wasPos = audio.currentTime || savedPosition;
  audio.src = fresh["@microsoft.graph.downloadUrl"];
  audio.addEventListener("loadedmetadata", () => {
    audio.currentTime = wasPos;
  }, { once: true });
  audio.play();
});
```

已经缓存到 IndexedDB(本地 blob)的就不会有这条失败路径 —— 本地 blob 无 TTL。

## "size = 0" 不是 bug

```
[OK] /xxx.mp3  size=0  mime=audio/mpeg
```

刚拖进 OneDrive 同步还没完成时,云端已有 driveItem 占位但 `size` 还没填,等同步完才有真值。判别:

1. 看 Windows 系统托盘 OneDrive 图标 —— 转圈 = 在同步,绿勾 = 完成
2. 或者直接拿 `@microsoft.graph.downloadUrl` 喂 audio,能播就证明字节在
3. 等几秒再 list 一次

## 文件夹与播放单位

OneDrive 文件夹是 SSOT,**app 不要管理它**(不建子目录、不重命名、不归类)。一切组织在 Windows 端人工做,app 只反映。

播放语义:
- 一个"播放范围"(scope)= 一个文件夹的**直接** audio 文件(不递归进子文件夹)
- 文件名排序(LC)= 播放顺序
- 用户靠 OneDrive 端命名控制顺序

## 跨设备同步

**完全不需要**。每台设备一份本地状态(localStorage / IndexedDB),OneDrive 只共享 library 本身。这个"per-device"不是要写的代码,是"不写 sync 代码"的自然结果。

## 边界更强的方案

`Files.ReadWrite.AppFolder` / `Files.Read` 等 scope 给的都是"整个 drive(或整个 app folder)的访问权",约束靠纪律 —— 代码 bug 越界了 Graph 不拦。

更硬的边界是 **OneDrive File Picker SDK** —— picker 在 Microsoft 那边的 UI 里让用户选一个文件夹,返回一个 token,**这个 token 只能访问选中的那一棵子树,越界 Graph 直接 403**。把"我们的代码守规矩"变成"我们的代码守不守规矩都打不穿"。
