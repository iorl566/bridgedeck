# 参考镜像测试

这些测试覆盖已物理移到 `reference/extension-mirror/` 的参考/上游镜像模块。它们：

- **不进入发布包**：`tools/build-extension.mjs` 只打包 `extension/` 运行时模块；
- **不属于运行时单测**：`node --test tests/unit/*.test.mjs` 不包含它们；
- 保留是为了将来把某个能力接回运行时之前，先验证参考实现本身。

运行：

```sh
node --test tests/reference/*.test.mjs
```

如果一个参考模块要恢复成产品能力，必须：

1. 从 `reference/extension-mirror/` 移回 `extension/src/`；
2. 接进运行时入口（manifest / import / 动态注入）；
3. 把对应测试移回 `tests/unit/` 或新增真实浏览器 DOM 测试；
4. 重新构建并跑 `node tools/verify-extension-package.mjs`。
