# BSK 0.5.0 ⇄ BridgeDeck 行为级差分基准

> 生成：2026-11-26T09:05:52.459Z；BSK `bsk 0.5.0` ⇄ BridgeDeck `0.3.1`；
> fixture 同页：`http://127.0.0.1:63846/diff.html`；两侧临时 profile/HOME，真实 Edge（非 headless）。
> 判定：equal = 两侧可观察行为一致；diff = 只有一侧满足；unsupported = 两侧都未满足/无法比较。

## 汇总

| 任务 | 我们 | BSK | 判定 | 耗时（我们/BSK） |
| --- | --- | --- | --- | --- |
| open | ✅ | ✅ | **equal** | 630ms / 868ms |
| observe | ✅ | ✅ | **equal** | 323ms / 149ms |
| click | ✅ | ✅ | **equal** | 330ms / 418ms |
| read_after_click | ✅ | ✅ | **equal** | 233ms / 61ms |
| fill | ✅ | ✅ | **equal** | 291ms / 74ms |
| read_after_fill | ✅ | ❌ | **diff** | 236ms / 57ms |
| extract_table | ✅ | ✅ | **equal** | 217ms / 100ms |
| get_html | ✅ | ✅ | **equal** | 245ms / 52ms |
| screenshot | ✅ | ✅ | **equal** | 371ms / 2299ms |
| click_missing | ✅ | ✅ | **equal** | 287ms / 86ms |
| observe_iframe | ✅ | ✅ | **equal** | 233ms / 176ms |
| observe_oopif | ✅ | ✅ | **equal** | 266ms / 149ms |
| fullpage | ✅ | ❌ | **diff** | 417ms / 120ms |
| video | ✅ | ✅ | **equal** | 4017ms / 3738ms |
| multi_session | ✅ | ✅ | **equal** | 1031ms / 1005ms |
| record | ✅ | ✅ | **equal** | 0ms / 0ms |
| record_replay | ❌ | ❌ | **unsupported** | 0ms / 0ms |
| pair_link | ✅ | ✅ | **equal** | 257ms / 102ms |
| tab_borrow | ❌ | ✅ | **diff** | 6029ms / 194ms |

## 任务细节（stdout 摘要，完整原始输出见 JSON）

### open

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"sessionId":"vfug","url":"http://127.0.0.1:63846/diff.html","title":"Differential Fixture","observation":null},"schema":"bb.cli/1","command":"open"}` |
| bsk | 0 | `[state session=lfki tab=993975493 ctx=c1 history_complete=false url="http://127.0.0.1:63846/diff.html" title=""] @vom 1 @view 1241x808 @layers 1 focus=L1 L1 page RootWebArea "Differential Fixture" heading "Diff Fixture" @e1 button "Submit Query" StaticText "idle" @e2 textbox "keyword" [empty] placeholder="keyword" list "alpha beta" listitem "alpha" ListMarker "•" listitem "beta" ListMarker "•" table row "Name \| Score" row "Alice \| 10" row "Bob \| 20" Iframe "same" heading "Same-origin Frame" @e3 button "IFRAME_BTN" StaticText "IFRAME_MARKER" Iframe "cross" heading "Cross-origin Frame" StaticTex…` |

### observe

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"url":"","title":"","observation":"frame 0 http://127.0.0.1:63846/diff.html\n- document \"Differential Fixture\"\n - heading \"Diff Fixture\" [level=1]\n - button \"Submit Query\" [@e1]\n - textbox \"keyword\" [@e2]\n - list\n - listitem: alpha\n - listitem: beta\n - table\n - row \"Alice10\" [@e3]\n - row \"Bob20\" [@e4]\n - iframe\n - heading \"Same-origin Frame\" [level=2]\n - button \"IFRAME_BTN\" [@e5]\n - iframe\n\nframe 9 http://127.0.0.1:63846/frame.html\n- document \"Frame\"\n - heading \"Same-origin Frame\" [level=2]\n - button \"IFRAME_BTN\" [@e6]\n\nframe 10 ht…` |
| bsk | 0 | `@vom 1 @view 1241x808 @layers 1 focus=L1 L1 page RootWebArea "Differential Fixture" heading "Diff Fixture" @e1 button "Submit Query" StaticText "idle" @e2 textbox "keyword" [empty] placeholder="keyword" list "alpha beta" listitem "alpha" ListMarker "•" listitem "beta" ListMarker "•" table row "Name \| Score" row "Alice \| 10" row "Bob \| 20" Iframe "same" heading "Same-origin Frame" @e3 button "IFRAME_BTN" StaticText "IFRAME_MARKER" Iframe "cross" heading "Cross-origin Frame" StaticText "OOPIF_MARKER" StaticText "tall"` |

### click

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"ok":true,"trusted":true,"x":56.75,"y":103.375,"effectState":"committed","cleanupState":"ok","phase":"pointer","pointer_moves":{"planned":3,"kept":3,"dropped":0,"min_distance_px":1,"max_events":3,"dropped_reasons":{},"last":{"x":56.75,"y":103.375}},"tx_id":"atx_001","journal_id":"aj_mwxbxpxr_gtx3_001","replayable":false,"receipt":{"method":"click","ref":null,"frameId":0,"revision":0,"effectState":"committed","target":{"selector":"#btn"},"recovery":null},"targetMarker":"shown"},"schema":"bb.cli/1","command":"click"}` |
| bsk | 0 | `click ok tab=993975493 target=@e4 at=(56.75, 103.375)` |

### read_after_click

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"fields":[{"contentEditable":false,"disabled":false,"name":"","readonly":false,"required":false,"tag":"div","type":"div","value":"CLICKED"}],"revision":8},"schema":"bb.cli/1","command":"read"}` |
| bsk | 0 | `{ "tab_id": 993975493, "page_url": "http://127.0.0.1:63846/diff.html", "frame_url": "http://127.0.0.1:63846/diff.html", "frame_id": "F27E1EFC2014C15D0A2763678D51BB44", "title": "Differential Fixture", "captured_at": "2026-11-26T09:08:51.293Z", "items": [ { "ref": "@e5", "values": { "text": "CLICKED" }, "redacted": [] } ], "truncated": false, "scope": "current_dom" }` |

### fill

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"ok":true,"trusted":true,"fast":true,"effectState":"committed","cleanupState":"ok","phase":"pointer","fill_strategy":"fast","fill_steps":["insert"],"fill_step_count":1,"fill_needs_clear":false,"fill_control_kind":"text-control","fill_path":"trusted-insert","fill_step_evidence":[{"step":"insert","via":"cdp-insertText","ok":true,"detail":{"matches":true,"value_length":10}}],"input_clock":{"epoch":2,"seq":1,"timestamp":1795684078.3194},"actual_value":"hello-diff","expected_value":"hello-diff","formatted":false,"matches":true,"tx_id":"atx_002","journal_id":"aj_mwxbxqdr_gccq_00…` |
| bsk | 0 | `fill ok tab=993975493 target=@e6 length=10` |

### read_after_fill

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"fields":[{"contentEditable":false,"disabled":false,"name":"","placeholder":"keyword","readonly":false,"ref":"@e2","required":false,"tag":"input","type":"text","value":"hello-diff"}],"revision":10},"schema":"bb.cli/1","command":"read"}` |
| bsk | 0 | `{ "tab_id": 993975493, "page_url": "http://127.0.0.1:63846/diff.html", "frame_url": "http://127.0.0.1:63846/diff.html", "frame_id": "F27E1EFC2014C15D0A2763678D51BB44", "title": "Differential Fixture", "captured_at": "2026-11-26T09:08:51.426Z", "items": [ { "ref": "@e2", "values": { "text": "" }, "redacted": [] } ], "truncated": false, "scope": "current_dom" }` |

### extract_table

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"budget":{"bytes":445,"cells":4,"maxBytes":262144,"maxCells":20000,"maxRows":500,"offset":0,"rows":2,"stopReason":"end"},"cells":4,"columnCount":2,"columns":[{"key":"c1","label":"Name"},{"key":"c2","label":"Score"}],"complete":true,"coverage":{"datasetComplete":"unknown","declared":null,"offset":0,"omitted":null,"returned":2,"scope":"loaded-dom","stopReason":"end"},"declaredRows":null,"hasMore":false,"kind":"table","offset":0,"revision":10,"rowCount":2,"rows":[{"c1":"Alice","c2":"10"},{"c1":"Bob","c2":"20"}],"stopReason":"end","totalRows":2,"truncated":false,"warnings":[]}…` |
| bsk | 0 | `{ "schema_version": 1, "kind": "table", "tab_id": 993975493, "source": { "page_url": "http://127.0.0.1:63846/diff.html", "frame_url": "http://127.0.0.1:63846/diff.html", "frame_id": "F27E1EFC2014C15D0A2763678D51BB44", "title": "Differential Fixture", "captured_at": "2026-11-26T09:08:51.511Z", "selector": "#tbl" }, "columns": [ { "key": "c1", "name": "Name", "header_path": [ "Name" ], "name_source": "header" }, { "key": "c2", "name": "Score", "header_path": [ "Score" ], "name_source": "header" } ], "rows": [ { "c1": "Alice", "c2": "10" }, { "c1": "Bob", "c2": "20" } ], "row_sources": [ { "row":…` |

### get_html

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"html":"<html><head><meta charset=\"utf-8\"><title>Differential Fixture</title></head>\n<body>\n<h1 id=\"title\">Diff Fixture</h1>\n<button id=\"btn\" onclick=\"document.getElementById('result').textContent='CLICKED'\">Submit Query</button>\n<div id=\"result\">CLICKED</div>\n<input id=\"inp\" placeholder=\"keyword\">\n<ul id=\"list\"><li>alpha</li><li>beta</li></ul>\n<table id=\"tbl\"><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>Alice</td><td>10</td></tr><tr><td>Bob</td><td>20</td></tr></tbody></table>\n<iframe id=\"same\" src=\"/frame.html\" width=\"3…` |
| bsk | 0 | `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Differential Fixture</title><style wxt-shadow-root-document-styles="vpjprei2qbi">@property --tw-translate-x{syntax:"*";inherits:false;initial-value:0}@property --tw-translate-y{syntax:"*";inherits:false;initial-value:0}@property --tw-translate-z{syntax:"*";inherits:false;initial-value:0}@property --tw-rotate-x{syntax:"*";inherits:false}@property --tw-rotate-y{syntax:"*";inherits:false}@property --tw-rotate-z{syntax:"*";inherits:false}@property --tw-skew-x{syntax:"*";inherits:false}@property --tw-skew-y{syntax:"*";inherits:false}@property …` |

### screenshot

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"path":"D:\\浏览器桥\\.tmp\\bsk-differential\\shots\\ours.png","width":1256,"height":760,"bytes":34507},"schema":"bb.cli/1","command":"screenshot"}` PNG 1256x760 (34507B) |
| bsk | 0 | `D:\浏览器桥\.tmp\bsk-differential\shots\bsk.png` PNG 1256x760 (31433B) |

### click_missing

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 1 | `{"ok":false,"error":{"code":"E_NO_SESSION","message":"存在多个 session，请用 --session 指定：vfug, zcqq","data":{"effect_state":"unknown"},"hint":"先 bridge session start（或 bridge open <url>）","retry":"after-action"},"schema":"bb.cli/1","command":"click"}` |
| bsk | 1 | `` |

### observe_iframe

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"url":"","title":"","observation":"frame 0 http://127.0.0.1:63846/diff.html\n- document \"Differential Fixture\"\n - heading \"Diff Fixture\" [level=1]\n - button \"Submit Query\" [@e1]\n - textbox \"keyword\" [@e2]\n - list\n - listitem: alpha\n - listitem: beta\n - table\n - row \"Alice10\" [@e3]\n - row \"Bob20\" [@e4]\n - iframe\n - heading \"Same-origin Frame\" [level=2]\n - button \"IFRAME_BTN\" [@e5]\n - iframe\n\nframe 9 http://127.0.0.1:63846/frame.html\n- document \"Frame\"\n - heading \"Same-origin Frame\" [level=2]\n - button \"IFRAME_BTN\" [@e6]\n\nframe 10 ht…` |
| bsk | 0 | `@vom 1 @view 1241x760 @layers 1 focus=L1 L1 page RootWebArea "Differential Fixture" heading "Diff Fixture" @e1 button "Submit Query" StaticText "CLICKED" @e2 textbox "keyword" [filled] placeholder="keyword" ="hello-diff" list "alpha beta" listitem "alpha" ListMarker "•" listitem "beta" ListMarker "•" table row "Name \| Score" row "Alice \| 10" row "Bob \| 20" Iframe "same" heading "Same-origin Frame" @e3 button "IFRAME_BTN" StaticText "IFRAME_MARKER" Iframe "cross" heading "Cross-origin Frame" StaticText "OOPIF_MARKER" StaticText "tall"` |

### observe_oopif

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"url":"","title":"","observation":"frame 0 http://127.0.0.1:63846/diff.html\n- document \"Differential Fixture\"\n - heading \"Diff Fixture\" [level=1]\n - button \"Submit Query\" [@e1]\n - textbox \"keyword\" [@e2]\n - list\n - listitem: alpha\n - listitem: beta\n - table\n - row \"Alice10\" [@e3]\n - row \"Bob20\" [@e4]\n - iframe\n - heading \"Same-origin Frame\" [level=2]\n - button \"IFRAME_BTN\" [@e5]\n - iframe\n\nframe 9 http://127.0.0.1:63846/frame.html\n- document \"Frame\"\n - heading \"Same-origin Frame\" [level=2]\n - button \"IFRAME_BTN\" [@e6]\n\nframe 10 ht…` |
| bsk | 0 | `@vom 1 @view 1241x760 @layers 1 focus=L1 L1 page RootWebArea "Differential Fixture" heading "Diff Fixture" @e1 button "Submit Query" StaticText "CLICKED" @e2 textbox "keyword" [filled] placeholder="keyword" ="hello-diff" list "alpha beta" listitem "alpha" ListMarker "•" listitem "beta" ListMarker "•" table row "Name \| Score" row "Alice \| 10" row "Bob \| 20" Iframe "same" heading "Same-origin Frame" @e3 button "IFRAME_BTN" StaticText "IFRAME_MARKER" Iframe "cross" heading "Cross-origin Frame" StaticText "OOPIF_MARKER" StaticText "tall"` |

### fullpage

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"path":"D:\\浏览器桥\\.tmp\\bsk-differential\\shots\\ours-full.png","width":1241,"height":2266,"bytes":46558},"schema":"bb.cli/1","command":"screenshot"}` PNG 1241x2266 (46558B) |
| bsk | 1 | `` |

### video

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"ok":true,"recordingId":"4c7ed3f6-301c-4ac4-9bd4-391538540619","tabId":325006505,"mime":"video/mp4","startedAt":1795684080871,"mode":"debugger","durationMs":12000,"recording_state":"recording","budget":{"version":1,"maxDurationMs":600000,"maxTotalBytes":268435456,"maxSegmentBytes":67108864,"maxConcurrent":1,"bitrateFloor":1000000,"downgradeRatio":0.6,"warnRatio":0.9},"budget_plan":{"ok":true,"action":"cap-duration","level":3,"stop_reason":null,"steps":2,"actions":["cap-duration","downgrade-bitrate"],"projectedBytes":300000000,"projectedAfterBytes":180000000,"cap_ms":536870…` |
| bsk | 0 | `vid_04732dddce2c4c4db5df86d0b5c3e883 · Recording · 0.0s · 0 bytes vid_04732dddce2c4c4db5df86d0b5c3e883 · Ready · 2.0s · 38815 bytes stop reason: user_stopped; completeness: Some(Complete) saved: D:\浏览器桥\.tmp\bsk-differential\shots\bsk-video.mp4` |

### multi_session

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"sessionId":"zcqq","url":"http://127.0.0.1:63846/diff.html","title":"Differential Fixture","observation":null},"schema":"bb.cli/1","command":"open"} {"ok":true,"result":{"service":"browser-bridge","version":"0.3.1","protocol":"1.9","pid":24240,"port":52917,"uptimeMs":134398,"browsers":[{"instanceId":"dc1aef8e","browser":"edge","browserVersion":"158.0.0.0","extVersion":"0.3.1","protocol":"1.9","protocolSkew":null,"capabilities":["observe","frames","dialog","screenshot","network","rules","video","recording","pairing","auth-challenge","unverified","dom-read"],"label":"","loca…` |
| bsk | 0 | `[state session=rdlr tab=993975496 ctx=c1 history_complete=false url="http://127.0.0.1:63846/diff.html" title=""] @vom 1 @view 1241x760 @layers 1 focus=L1 L1 page RootWebArea "Differential Fixture" heading "Diff Fixture" @e1 button "Submit Query" StaticText "idle" @e2 textbox "keyword" [empty] placeholder="keyword" list "alpha beta" listitem "alpha" ListMarker "•" listitem "beta" ListMarker "•" table row "Name \| Score" row "Alice \| 10" row "Bob \| 20" Iframe "same" heading "Same-origin Frame" @e3 button "IFRAME_BTN" StaticText "IFRAME_MARKER" Iframe "cross" heading "Cross-origin Frame" StaticTex…` |

### record

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"ok":true,"tabId":325006505,"startedAt":1795684087710,"receipt":{"method":"record.start","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","command":"record","subcommand":"start"} {"ok":true,"result":{"ok":true,"recording":{"id":"ec214e53-bf40-49b4-80fc-cd1c05df4994","events":0},"receipt":{"method":"record.stop","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectSta…` |
| bsk | 0 | `saved 1 steps to D:\浏览器桥\.tmp\bsk-differential\record\bsk\trace.json and 2 states to D:\浏览器桥\.tmp\bsk-differential\record\bsk\states` |

### record_replay

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `replay 需要对等 CLI（参考实现仅 recipe run，我方 trace replay 未暴露 CLI）` |
| bsk | 0 | `replay 需要对等 CLI（参考实现仅 recipe run，我方 trace replay 未暴露 CLI）` |

### pair_link

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | 0 | `{"ok":true,"result":{"ok":true,"link":"ws://127.0.0.1:52917/ws#d7dec8619b932584256ce4c9b7f5de4b","token":"d7dec8619b932584256ce4c9b7f5de4b","code":"387486","expiresAt":1795684390550,"strict":true},"schema":"bb.cli/1","command":"daemon"}` |
| bsk | 0 | `ws://127.0.0.1:52800/#bsk-local.v1.Jz3FOE6E9typM-XVkGih1A.MVNTXet2kLCaxqin4DPEfg.a1TLHk5ObHJC5So5VAoBtXVKUolwPp1CZlhgm59NlQI` |

### tab_borrow

| 侧 | exit | 摘要 |
| --- | --- | --- |
| ours | TIMEOUT | `错误 E_NO_SESSION: 存在多个 session，请用 --session 指定：vfug, zcqq 下一步（after-action）：先 bridge session start（或 bridge open <url>）` |
| bsk | 0 | `borrowed tab_id=993975491 from window=993975489 index=0 → agent_window=993975492` |

## 环境

```json
{
  "edge": "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "node": "v24.22.3",
  "platform": "win32"
}
```



## 第四阶段：真实用户窗口场景（2026-11-26，19 任务）

- 新增模式：浏览器启动时直接打开 fixture 用户页（替换 `about:blank`），配合 `tools/uia-click.ps1`
  做真人点击；专用设计见 `docs/BEHAVIOR-DIFF-USER-WINDOW.md`。
- 汇总：**19 任务 15 equal / 3 diff / 1 unsupported**。
  - equal 新增：`record`（我们 events=1；参考实现 saved 1 steps + trace.json）。
  - diff：`read_after_fill`（价值暴露）；`fullpage`（参考实现要求页面可见，遮挡时拒绝）；
    `tab_borrow`（参考实现确认条可被 UIA 点中并成功借用；我们确认模态在 closed shadow +
    human-only 设置，UIA 不可达，如实记为 `pendingConfirmation`，需真人点击）。
  - unsupported：`record_replay`（两侧都没有对等 `replay <trace>` CLI；参考实现只有 recipe run）。
- 结论：借用确认的安全姿态不同（我们刻意 human-only/closed shadow）、录制输入源不同（Agent vs 真人）、
  回放是共同缺口；详见 `docs/BEHAVIOR-DIFF-USER-WINDOW.md`。
