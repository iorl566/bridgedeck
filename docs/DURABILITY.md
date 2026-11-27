# BridgeDeck 录制持久化与 fsync 边界（0.3.0）

目标：把“浏览器里能做到的持久化”和“做不到的 fsync”写清楚，避免把 readback 校验说成内核 fsync。

## 1. 能力与保证

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| OPFS 分块写入 | 支持 | `FileSystemWritableFileStream.close()` 后读回 |
| `navigator.storage.persist()` | 探测并记录 | `storage_persisted`、`storage_quota` |
| 分块连续性校验 | 支持 | `verifyEncodedParts`（position 连续、字节数） |
| 读回校验 | 支持 | `durability:'verified'/'unverified'` |
| 崩溃恢复 | 支持 | OPFS manifest → OPFS 分块 → IDB 编码分块（position）→ IDB 普通分片 |
| **内核 fsync** | **不支持** | 浏览器不暴露 fsync；无法承诺掉电级持久 |
| 文件句柄语义 | 部分 | OPFS 目录/文件句柄，无 BSK 的显式 sync 文件 |

## 2. 录制记录字段

```json
{
  "completeness": "complete",
  "durability": "verified",
  "durability_parts": 3,
  "durability_policy": "browser-readback",
  "fsync_supported": false,
  "storage_persisted": true,
  "storage_quota": 123456789,
  "finish_via": "encoder"
}
```

- `durability:'verified'` 只表示 **close 后读回** 的分块连续/字节数正确；
- 掉电、浏览器崩溃、OPFS 驱动层故障仍可能丢数据；
- 恢复路径会标记 `recovered:true`、`stop_reason:'recovered'`。

## 3. 恢复优先级

1. OPFS `manifest.json` + 编码分块（`encoder-recovered`）；
2. IndexedDB 编码分块，按 `position` 组装（`encoder-idb-recovered`）；
3. IndexedDB 普通 MediaRecorder 分片，按 `index` 组装（`recovered`）。

## 4. 降级策略

- OPFS 不可用 → 编码分块落 IDB；恢复时按 position 组装，不再按 index 拼错。
- `storage.persist()` 被拒 → 记录 `storage_persisted:false`，录制继续，但提示可能被清理。
- 读回校验失败 → 记录 `durability:'unverified'`，保留原分块以便恢复，不静默丢弃。

## 5. 与 BSK 0.5.0 的差距

- BSK 使用显式文件句柄/同步语义（Rust/原生侧更强）；
- BridgeDeck 受浏览器 OPFS API 限制，只能做到“close + 读回 + manifest 恢复”；
- 因此我们不把这一项标为“完全对齐”，只在浏览器能力范围内做到最强。
