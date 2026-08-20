// ID3v2 标签解析（纯函数，app 侧——store 零内容格式知识是家规）。
// 消费场景唯一：正在播的曲子把 title/artist/封面喂 MediaSession（车上/锁屏显示正确，2026-08-20 user 拍板）。
// 不做派生缓存：头部字节播放时本来就进 staging，就地解、内存只留当前曲（user 翻案：对 404/延迟不敏感，零额外流量）。
// 覆盖 v2.2（TT2/TP1/PIC）、v2.3（TIT2/TPE1/APIC，帧长 plain BE）、v2.4（同 v2.3 帧名，帧长 syncsafe）。
// 整 tag unsynchronisation 旧标志（现代打标器不用）不解——遇到直接放弃，宁缺毋错。

export interface Id3Picture { mime: string; data: Uint8Array }
export interface Id3Tag { title?: string; artist?: string; picture?: Id3Picture }

const syncsafe = (b: Uint8Array, i: number): number =>
  ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const be32 = (b: Uint8Array, i: number): number => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
const be24 = (b: Uint8Array, i: number): number => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

/** 头 10 字节判 tag 总长（含 10 字节头 + v2.4 footer）。0 = 无 ID3v2 tag。 */
export function id3TagFullSize(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== "ID3") return 0;
  const major = head[3];
  if (major < 2 || major > 4) return 0;
  return 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);   // 0x10 = v2.4 footer present
}

/** 解码 ID3 文字（首字节=encoding）：0 latin1 / 1 UTF-16(BOM) / 2 UTF-16BE / 3 UTF-8。去尾部 NUL。 */
function decodeText(enc: number, b: Uint8Array): string {
  let s: string;
  if (enc === 0) s = new TextDecoder("latin1").decode(b);
  else if (enc === 3) s = new TextDecoder("utf-8").decode(b);
  else {
    let label = enc === 2 ? "utf-16be" : "utf-16le";
    if (enc === 1 && b.length >= 2) {
      if (b[0] === 0xfe && b[1] === 0xff) { label = "utf-16be"; b = b.subarray(2); }
      else if (b[0] === 0xff && b[1] === 0xfe) { label = "utf-16le"; b = b.subarray(2); }
    }
    s = new TextDecoder(label).decode(b);
  }
  return s.replace(/\0+$/, "").trim();
}

/** encoding 相关的 NUL 终结符扫过去，返回终结符之后的下标（找不到返回 -1）。 */
function skipTerminated(b: Uint8Array, i: number, enc: number): number {
  if (enc === 1 || enc === 2) {   // UTF-16：2 字节对齐找 00 00
    for (; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
    return -1;
  }
  for (; i < b.length; i++) if (b[i] === 0) return i + 1;
  return -1;
}

function parsePicture(body: Uint8Array, v22: boolean): Id3Picture | undefined {
  if (body.length < 4) return undefined;
  const enc = body[0];
  let mime: string, i: number;
  if (v22) {   // PIC：3 字节图格式（JPG/PNG）
    const fmt = ascii(body, 1, 3).toUpperCase();
    mime = fmt === "PNG" ? "image/png" : "image/jpeg";
    i = 4;
  } else {     // APIC：latin1 MIME 到 NUL
    const end = body.indexOf(0, 1);
    if (end < 0) return undefined;
    mime = ascii(body, 1, end - 1) || "image/jpeg";
    i = end + 1;
  }
  i += 1;                                    // picture type 字节
  i = skipTerminated(body, i, enc);          // description
  if (i < 0 || i >= body.length) return undefined;
  return { mime, data: body.subarray(i) };
}

/** 解析整 tag（传入至少覆盖 tag 长度的头部字节；不足则解析到哪算哪）。无 tag / 不认识返回 null。 */
export function parseId3(buf: Uint8Array): Id3Tag | null {
  const full = id3TagFullSize(buf);
  if (!full) return null;
  const major = buf[3];
  if (buf[5] & 0x80) return null;            // 整 tag unsynchronisation：放弃（现代打标器不用）
  const end = Math.min(buf.length, 10 + syncsafe(buf, 6));
  let i = 10;
  if (buf[5] & 0x40 && major >= 3) {         // extended header：跳过
    const ext = major === 4 ? syncsafe(buf, i) : be32(buf, i) + 4;
    i += ext;
  }
  const tag: Id3Tag = {};
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  while (i + headLen <= end) {
    if (buf[i] === 0) break;                 // padding 区
    const id = ascii(buf, i, idLen);
    const size = major === 2 ? be24(buf, i + 3) : major === 3 ? be32(buf, i + 4) : syncsafe(buf, i + 4);
    const flags2 = major === 2 ? 0 : buf[i + 9];
    const body = buf.subarray(i + headLen, Math.min(i + headLen + size, end));
    i += headLen + size;
    if (size <= 0 || body.length === 0) continue;
    if (major === 4 && flags2 & 0x0f) continue;   // 帧级压缩/加密/unsync：不解这帧
    if (id === "TIT2" || id === "TT2") tag.title ||= decodeText(body[0], body.subarray(1));
    else if (id === "TPE1" || id === "TP1") tag.artist ||= decodeText(body[0], body.subarray(1));
    else if ((id === "APIC" || id === "PIC") && !tag.picture) tag.picture = parsePicture(body, major === 2);
  }
  return tag.title || tag.artist || tag.picture ? tag : null;
}
