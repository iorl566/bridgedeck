# BridgeDeck — ja-JP store listing

Locale: `ja-JP` (package locale `ja`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/ja/messages.json`, read-only):
BridgeDeck は、ログイン済みのブラウザを AI エージェントのワークスペースに変えます。ローカル daemon + MV3 拡張機能、テレメトリなし。

## Description

BridgeDeck は、いつも使っているブラウザを AI エージェントのワークスペースに変えます。

エージェントにタスクを渡すと、すでにログインしているセッションをそのまま使って、専用の Agent Window の中で作業を進めます。何をしているかはいつでも見えていて、途中で自分が操作を引き継いだり、一時停止や停止をしたりできます。

できること

- ログイン済みの場所でそのまま作業：社内文書の閲覧、社内システムの検索、自分のアカウントが必要な Web 上の手続きの完了まで。
- 指示をブラウザ操作に変換：ページ構造の読み取り、クリック、文字入力、フォーム入力、選択、ドラッグ、スクロール、ファイルのアップロードとダウンロード、タブの管理。
- 常にコントロールを保てます：目に見える操作カード、操作対象のページを囲む青い呼吸する枠線、いつでも使える一時停止と停止、そしてあなたのタブを借りる前に表示される確認プロンプト。
- Web データを持ち出せます：表やリストを JSON または CSV として抽出し、列名と、それぞれの値がどのページやフレームから来たのかも記録します。
- 失敗の理由を証拠から突き止められます：リクエスト、レスポンス本文、コンソールメッセージ、ページの変化、パフォーマンスの所要時間、重複リクエストの検査を JSON として書き出せます。
- 作業のリプレイを残せます：許可したタスクタブを無音の MP4 として録画し、拡張機能の中でプレビュー、保存、削除ができます。
- 長いページも丸ごと保存：自動スクロール、手動でのつなぎ合わせ、表示されている範囲だけのキャプチャから選べます。
- 記録を残せます：任意で有効にできる操作監査、タスク履歴、証拠はすべてローカルに保存されます。

エージェント向けに設計

CLI ひとつ、MCP サーバー（92 ツール）、DeepSeek Harness プラグイン（37 ツール）、そして Node.js と Python の SDK。シェルコマンドを実行できるエージェントならどれでもブラウザを操作できます。特定のモデルやベンダーに縛られることはありません。

既定でローカル、既定でプライベート

- 127.0.0.1 上のローカル daemon に接続します。クラウドサービスもテレメトリもありません。
- リモートペアリングは任意で、常に認証付きの WSS を使用します。ペアリングしていないローカル接続も利用できますが、識別情報に関する警告が表示されます。
- スクリーンショット、録画、デバッグ用の証拠、監査記録は、すべてお使いのマシン上に残ります。
- 拡張機能が単独で AI プロバイダーを呼び出すことはありません。

動作環境

- Microsoft Edge など Chromium ベースのブラウザ、バージョン 111 以降。
- ローカル daemon と CLI には Node.js 20 以降が必要です。
- daemon は Windows、macOS、Linux で動作します。Windows にはグラフィカルなインストーラーがあり、macOS と Linux では install.sh を含む tar.gz アーカイブを使います。

はじめかた

拡張機能をインストールしてポップアップを開き、「接続済み」と表示されることを確認してください。最初に bridge コマンドを実行したときに、daemon が自動的に起動します。

ソースコード、CLI のインストールガイド、ドキュメント：https://github.com/iorl566/bridgedeck

プライバシーに関する通知：https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- ブラウザ自動化
- AI エージェント
- ブラウザ操作
- Web スクレイピング
- ページ読み取り
- MCP サーバー
- Edge 拡張機能

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/ja/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
