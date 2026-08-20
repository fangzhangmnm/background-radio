// BR v2 配置（值与旧 app config.js 同源；旧 app cutover 退役后本文件是唯一份）。
export const CLIENT_ID = "aa43a186-25cd-4140-ade9-c0abd6ce5cb6";
export const AUTHORITY = "https://login.microsoftonline.com/common";
// 硬规则 #6：scope 永久钉死 AppFolder，永不申请全盘读（ADR-0022）。
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
export const APP_VERSION = "0.1.3";
