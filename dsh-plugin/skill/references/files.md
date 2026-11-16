# 上传与下载

```sh
bridge upload @e5 --file C:\path\a.pdf --session <id>
bridge upload @e5 --file a.pdf --file b.png --session <id>
bridge upload @e5 --file a.pdf --mode drop --session <id>
bridge download @e5 --out report.csv --session <id>
bridge download --url https://example.com/a.zip --out a.zip --session <id>
```

## 上传

- 目标是 `input[type=file]` 时直接赋值并派发 `input/change`；是按钮/标签时挂 debugger 拦截文件选择器，用可信点击打开后填路径；拦截不到再退回页面里第一个隐藏 file input。
- 结果里的 `via` 说明路径：`chooser`（选择器拦截）、`hidden-input`（兜底赋值）、`drop`（拖放）。
- `--mode drop` 走 CDP 拖放，只对明确的投放区/编辑器用，别对空白区域或含义不明的容器用；它要求文件路径在浏览器那台机器上。
- 选择器拦截与 `--mode drop` 都依赖 CLI 与浏览器同机；只给 `--file` 时也会随请求传 base64，直接赋值不需要同机。
- 总大小上限 20MB；超限直接参数错误。
- 报 `E_NO_FILE_CHOOSER` 表示点完没出现选择器、页面里也没有可赋值的 file input：重新观察目标，仍不行就交给人工，不要反复换机制重试。
- 上传成功只证明“文件已交给页面”，不证明站点已接收：完成后观察附件列表/预览再继续。
- 页面显示的文件名可能是伪造的，确认来源或让用户决定。

## 下载

- 下载命令点击元素或导航 URL，然后等该 tab 的下载事件；`state` 为 `complete` 或 `interrupted`。
- `--out` 在下载完成后把文件复制到指定路径，浏览器原文件保留在下载目录（`--json` 里的 `browserPath`）。
- 目标文件已存在时拒绝覆盖，确认要替换才加 `--overwrite`。
- 超时没观测到下载回 `E_NO_DOWNLOAD`；中断回 `E_DOWNLOAD_FAILED`。
- 下载的是站点控制的字节，不要下载未知来源的可执行文件；只保存到用户指定位置。
