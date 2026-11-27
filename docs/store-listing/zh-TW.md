# BridgeDeck — zh-TW store listing

Locale: `zh-TW` (package locale `zh_TW`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/zh_TW/messages.json`, read-only):
BridgeDeck 把已登入的瀏覽器變成 AI Agent 的工作區：本機 daemon + MV3 擴充功能，資料只在本機流動。

## Description

BridgeDeck 把你已經在用的瀏覽器，變成 AI Agent 的工作區。

把任務交給 Agent，它會在獨立的 Agent Window 裡，用你已經登入的工作階段完成操作；你隨時看得到它在做什麼，也能隨時接手、暫停或停止。

能做什麼

- 用你既有的帳號做網站任務：讀取文件、搜尋內部系統、走完需要本人登入的網頁流程。
- 把一句指令變成瀏覽器操作：讀取頁面結構、點擊、輸入、填表、選擇、拖曳、捲動、上傳與下載檔案、管理標籤頁。
- 過程始終可控：看得見的接手卡片、被控制頁面外圍的藍色呼吸邊框、隨時暫停或停止，借用你既有標籤頁之前會先請你確認。
- 把網頁資料帶走：表格與清單匯出成 JSON 或 CSV，保留欄位名稱，以及每個值來自哪個頁面或 iframe。
- 出問題時找得到證據：請求、回應內容、主控台訊息、頁面變化、效能耗時與疑似重複請求，可匯出成 JSON。
- 留下可回放的過程：把一個已授權的任務標籤頁錄成無聲 MP4，在擴充功能裡預覽、儲存或刪除。
- 整頁留存：自動捲動、手動拼接，或只擷取可見區域。
- 留下紀錄：可開啟的操作稽核、任務歷史與證據，全部保存在本機。

為 Agent 而做

一個 CLI、一個 MCP 伺服器（92 個工具）、一個 DeepSeek Harness 外掛（37 個工具），以及 Node.js 與 Python SDK。只要能執行本機命令，Agent 就能驅動瀏覽器；不綁定任何模型或廠商。

預設在本機、預設私密

- 預設只連線到本機 127.0.0.1 上的 daemon，沒有雲端服務，也沒有遙測。
- 遠端配對是選項，且一律使用具備驗證的 WSS；未配對的本機連線仍可使用，但會顯示身分未驗證的警告。
- 截圖、錄影、除錯證據與稽核紀錄都留在你的電腦上。
- 擴充功能不會自行呼叫任何 AI 供應商。

環境需求

- Microsoft Edge、Google Chrome 或其他 Chromium 核心瀏覽器，版本 111 以上。
- 本機 daemon 與 CLI 需要 Node.js 20 以上。
- daemon 支援 Windows、macOS 與 Linux；Windows 有圖形安裝程式，macOS 與 Linux 使用 tar.gz 壓縮檔內的 install.sh。

開始使用

安裝擴充功能後開啟彈出視窗，確認顯示「已連線」。第一次執行 bridge 命令時，daemon 會自動啟動。

原始碼、CLI 安裝指南與文件：https://github.com/iorl566/bridgedeck

隱私權說明：https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- 瀏覽器自動化
- AI Agent
- 瀏覽器控制
- 網頁擷取
- 頁面讀取
- MCP 伺服器
- Edge 擴充功能

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/zh_TW/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
