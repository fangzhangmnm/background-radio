# Background Radio（家族总规则见上级 CLAUDE.md）

点开就放的游戏 OST 背景电台，开车/干活用——超大播放键，一切交互为"一下点中"服务。UI 中文。

- 数据：只读 mp3 镜像（OneDrive），双层缓存 = 用户 pin 锁定 + LRU 自动缓存；缓存上限用**输入数字**不用 slider。播放进度 per-device。
- 云姿态：只读镜像，无冲突解决需求；OneDrive 是 SSoT，cache invalidation 从来都是坑。
- **最高价值未实施项**：File Picker v8 scoped-token 重设计——token 必须焊死在用户选的单一文件夹上（`Files.Read` 全盘只读不可接受），且必须做 403 越界负测试。完整 handoff 在聊天考古里（见 vibe-workflow postmortem 报告）。
