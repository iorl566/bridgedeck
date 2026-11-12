# 逐文件镜像清单

由 `node tools/parity-manifest.mjs` 生成。`delta` 为镜像行数减对照行数，正数表示镜像注释更多。目录汇总只统计与对照一一对应的文件，辅助镜像不计入。

## 目录汇总

| 目录 | 文件 | 对照行 | 镜像行 |
| --- | ---: | ---: | ---: |
| debug | 20 | 6478 | 6478 |
| transport | 14 | 3062 | 3071 |
| session-manager | 11 | 1839 | 1839 |
| browser-driver | 5 | 2496 | 2500 |
| content | 15 | 4428 | 4428 |
| long-screenshot | 15 | 2194 | 2194 |
| video | 19 | 2516 | 2428 |
| lib | 48 | 5775 | 5775 |
| shared | 1 | 23 | 23 |

## 文件明细

| 目录 | 文件 | 对照行 | 镜像行 | delta |
| --- | --- | ---: | ---: | ---: |
| debug | analysis.js | 245 | 201 | -44 |
| debug | archive.js | 519 | 466 | -53 |
| debug | bridge.js | 72 | 78 | +6 |
| debug | capabilities.js | 162 | 160 | -2 |
| debug | client.js | 23 | 61 | +38 |
| debug | control-model.js | 361 | 275 | -86 |
| debug | evidence-model.js | 362 | 293 | -69 |
| debug | journal.js | 110 | 153 | +43 |
| debug | json-source.js | 61 | 83 | +22 |
| debug | manager.js | 1430 | 1677 | +247 |
| debug | network-control.js | 621 | 485 | -136 |
| debug | network-store.js | 721 | 681 | -40 |
| debug | observer.js | 414 | 476 | +62 |
| debug | performance-observer.js | 270 | 256 | -14 |
| debug | performance.js | 94 | 84 | -10 |
| debug | query.js | 204 | 189 | -15 |
| debug | recording.js | 114 | 98 | -16 |
| debug | redact.js | 235 | 276 | +41 |
| debug | types.js | 409 | 419 | +10 |
| debug | use-tasks.js | 51 | 67 | +16 |
| transport | credential-db.js | 25 | 30 | +5 |
| transport | daemon-endpoint.js | 40 | 37 | -3 |
| transport | handshake.js | 173 | 95 | -78 |
| transport | local-auth-crypto.js | 110 | 63 | -47 |
| transport | local-auth-protocol.js | 158 | 102 | -56 |
| transport | local-auth.js | 244 | 162 | -82 |
| transport | local-credentials.js | 197 | 100 | -97 |
| transport | pairing-verifier.js | 90 | 66 | -24 |
| transport | remote-authorization.js | 234 | 134 | -100 |
| transport | remote-endpoint.js | 87 | 49 | -38 |
| transport | remote-storage.js | 98 | 95 | -3 |
| transport | transport.js | 26 | 7 | -19 |
| transport | types.js | 1226 | 1887 | +661 |
| transport | ws-transport.js | 354 | 244 | -110 |
| session-manager | agent-window.js | 98 | 88 | -10 |
| session-manager | disconnect-cleanup.js | 76 | 70 | -6 |
| session-manager | event-handler.js | 215 | 202 | -13 |
| session-manager | manager.js | 409 | 392 | -17 |
| session-manager | popup-focus.js | 69 | 69 | 0 |
| session-manager | ref-store.js | 231 | 251 | +20 |
| session-manager | tab-creation.js | 24 | 43 | +19 |
| session-manager | tab-moves.js | 85 | 108 | +23 |
| session-manager | task-popups.js | 156 | 143 | -13 |
| session-manager | ui-activity.js | 182 | 189 | +7 |
| session-manager | window-routing.js | 294 | 284 | -10 |
| browser-driver | background-execution.js | 88 | 89 | +1 |
| browser-driver | chromium-cdp.js | 1829 | 1829 | 0 |
| browser-driver | command-deadline.js | 249 | 250 | +1 |
| browser-driver | frame-graph.js | 145 | 146 | +1 |
| browser-driver | screencast-coordinator.js | 185 | 186 | +1 |
| content | BorrowConfirmationOverlay.js | 292 | 294 | +2 |
| content | ControlGlow.js | 53 | 53 | 0 |
| content | ControlInputBlocker.js | 49 | 63 | +14 |
| content | ControlOverlay.js | 231 | 224 | -7 |
| content | HelpRequestOverlay.js | 824 | 569 | -255 |
| content | RecordOverlay.js | 288 | 272 | -16 |
| content | capture-suppress.js | 100 | 101 | +1 |
| content | cooperation-capture.js | 795 | 822 | +27 |
| content | help-request.js | 32 | 42 | +10 |
| content | input-passthrough.js | 55 | 74 | +19 |
| content | overlay-controller.js | 181 | 214 | +33 |
| content | record-capture.js | 1012 | 1042 | +30 |
| content | record-hover-surface.js | 238 | 326 | +88 |
| content | record-step-delivery.js | 67 | 102 | +35 |
| content | recording\frame-agent.js | 211 | 230 | +19 |
| long-screenshot | background.js | 400 | 480 | +80 |
| long-screenshot | capture.js | 212 | 175 | -37 |
| long-screenshot | exports.js | 130 | 144 | +14 |
| long-screenshot | frame-freshness.js | 53 | 81 | +28 |
| long-screenshot | manual.js | 193 | 165 | -28 |
| long-screenshot | page-client.js | 73 | 66 | -7 |
| long-screenshot | page.js | 447 | 442 | -5 |
| long-screenshot | png.js | 153 | 142 | -11 |
| long-screenshot | retention.js | 48 | 42 | -6 |
| long-screenshot | source.js | 83 | 72 | -11 |
| long-screenshot | storage.js | 48 | 80 | +32 |
| long-screenshot | test-fixture.js | 47 | 42 | -5 |
| long-screenshot | tiles.js | 161 | 129 | -32 |
| long-screenshot | types.js | 109 | 102 | -7 |
| long-screenshot | wait.js | 37 | 32 | -5 |
| video | bridge.js | 102 | 86 | -16 |
| video | browser-fixture.js | 74 | 43 | -31 |
| video | capture-deadline.js | 32 | 23 | -9 |
| video | client.js | 64 | 58 | -6 |
| video | downloads.js | 84 | 108 | +24 |
| video | dsh-fixture.js | 84 | 64 | -20 |
| video | encoder-config.js | 25 | 21 | -4 |
| video | encoder.js | 419 | 413 | -6 |
| video | encoder.worker.js | 93 | 70 | -23 |
| video | errors.js | 21 | 15 | -6 |
| video | host-protocol.js | 26 | 65 | +39 |
| video | host.js | 113 | 152 | +39 |
| video | manager.js | 672 | 507 | -165 |
| video | offscreen.js | 108 | 114 | +6 |
| video | overlay.js | 167 | 236 | +69 |
| video | playback-fixture.js | 143 | 110 | -33 |
| video | store.js | 104 | 194 | +90 |
| video | timeline.js | 59 | 49 | -10 |
| video | types.js | 126 | 100 | -26 |
| lib | audit-bridge.js | 122 | 191 | +69 |
| lib | audit-timeline.js | 50 | 82 | +32 |
| lib | audit.js | 66 | 67 | +1 |
| lib | capture-suppress-bridge.js | 72 | 83 | +11 |
| lib | connection-controller.js | 498 | 449 | -49 |
| lib | controller-info.js | 43 | 58 | +15 |
| lib | daemon-connection-preference.js | 68 | 85 | +17 |
| lib | daemon-port-preference.js | 33 | 52 | +19 |
| lib | daemon-upgrade-notice.js | 144 | 145 | +1 |
| lib | describe-target.js | 369 | 424 | +55 |
| lib | heartbeat.js | 111 | 94 | -17 |
| lib | help-bridge.js | 140 | 144 | +4 |
| lib | hover-trigger-policy.js | 179 | 180 | +1 |
| lib | input-passthrough-bridge.js | 37 | 54 | +17 |
| lib | instance-id.js | 153 | 153 | 0 |
| lib | interaction-preferences.js | 113 | 114 | +1 |
| lib | keepalive.js | 118 | 105 | -13 |
| lib | local-pairing-bridge.js | 71 | 131 | +60 |
| lib | overlay-bridge.js | 202 | 221 | +19 |
| lib | overlay-interrupt-client.js | 49 | 50 | +1 |
| lib | overlay-version.js | 17 | 38 | +21 |
| lib | popup-bridge.js | 24 | 33 | +9 |
| lib | random-uuid.js | 27 | 22 | -5 |
| lib | record-bridge.js | 156 | 172 | +16 |
| lib | recording\document-marker.js | 40 | 47 | +7 |
| lib | recording\document-settle.js | 135 | 115 | -20 |
| lib | recording\draft-policy.js | 35 | 47 | +12 |
| lib | recording\frame-bridge.js | 66 | 44 | -22 |
| lib | recording\frame-coordinator.js | 401 | 296 | -105 |
| lib | recording\navigation-policy.js | 6 | 10 | +4 |
| lib | recording\observation-capture.js | 141 | 115 | -26 |
| lib | recording\observation-session.js | 129 | 116 | -13 |
| lib | recording\recording-runtime.js | 315 | 260 | -55 |
| lib | recording\settle-controller.js | 234 | 209 | -25 |
| lib | recording\state-registry.js | 58 | 62 | +4 |
| lib | recording\step-buffer.js | 161 | 101 | -60 |
| lib | recording\tab-coordinator.js | 62 | 75 | +13 |
| lib | recording\target-matcher.js | 89 | 81 | -8 |
| lib | recording\trace-builder-v3.js | 93 | 83 | -10 |
| lib | recording\trace-reducer-v2.js | 216 | 207 | -9 |
| lib | recording\trace-reducer-v3.js | 155 | 130 | -25 |
| lib | recording\trace-state-body.js | 40 | 39 | -1 |
| lib | recording\types.js | 86 | 47 | -39 |
| lib | semver.js | 69 | 71 | +2 |
| lib | sensitive-autocomplete.js | 22 | 43 | +21 |
| lib | sessions-live-flag.js | 96 | 86 | -10 |
| lib | task-preview.js | 205 | 264 | +59 |
| lib | ui-channel.js | 59 | 80 | +21 |
| shared | recording-document-identity.js | 23 | 23 | 0 |

## 结论

- 对照文件总数：**148**
- 缺失镜像：**0**
- 完全同行的文件：**5**（session-manager/popup-focus.js、browser-driver/chromium-cdp.js、content/ControlGlow.js、lib/instance-id.js、shared/recording-document-identity.js）
- 行数差异绝对值不超过 20 的文件：**86**
