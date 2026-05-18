// 在 Azure portal 注册完应用后,把 Application (client) ID 填到这里
export const CLIENT_ID = "aa43a186-25cd-4140-ade9-c0abd6ce5cb6";

// common = 个人账号 + 组织账号都能登
export const AUTHORITY = "https://login.microsoftonline.com/common";

// AppFolder 用来访问沙盒目录;offline_access 拿 refresh token 实现"登录一次就不管"
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
