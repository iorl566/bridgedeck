// 发布清单 Ed25519 公钥（由 tools/release-key-mode.mjs / release.mjs --write-public-key 写入）。
// 生产签名私钥只存 CI Secret RELEASE_SIGNING_PRIVATE_KEY；签名轮换时同步更新本文件。
export const RELEASE_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAiCeI9gdSwC4QhbJStSFADYyeZk7+VVgv9UBvnndcXb0=\n-----END PUBLIC KEY-----";

export const RELEASE_PUBLIC_KEY_ID = "c7b5e21301f91a2d";
