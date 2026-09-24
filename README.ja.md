# alfa

ターミナルで動く、ローカル優先の coding agent。自分の API とモデルを設定し、会話を読み、変更を確認し、そのまま入力を続けられます。

[English](README.md) · [中文](README.zh.md)

```text
› 設定パーサーを修正
  · read src/config.ts
  edit src/config.ts +2 -1
  - oldValue
  + newValue
  テストに成功。空の値も保持します。
›
```

## インストールと起動

最新リリースを 1 コマンドでインストールできます。Bun は不要です。

**macOS / Linux：**

```sh
curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
```

**Windows（PowerShell）：**

```powershell
irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
```

スクリプトは対応バイナリを選択し、SHA-256 を検証します。インストール先は macOS/Linux では `~/.local/bin`、Windows では `%LOCALAPPDATA%\Programs\alfa` です。ディレクトリが `PATH` にない場合は、表示されたコマンドで追加してください。スクリプトは shell 設定や環境変数を自動変更しません。その後 `alfa` を実行してモデルを設定します。

[Releases](https://github.com/alfa-plus-laboratory/alfa/releases/latest) からバイナリとチェックサムを手動で取得することもできます。

**更新：**

```sh
alfa upgrade
```

**アンインストール：**まず削除対象を確認します。

```sh
alfa uninstall
```

確認後、次の 1 コマンドで削除します。

```sh
alfa uninstall confirm
```

インストール済みバイナリ、グローバル設定、保存済み認証情報、セッションデータ、現在のディレクトリにある `.alfa/` を削除します。他のプロジェクトの `.alfa/` と `PATH` 設定は残ります。Windows で実行ファイルの名前変更が報告された場合は、終了後に表示されたコマンドで残りのファイルを削除してください。

Shell のファイル隔離は macOS Seatbelt または Linux bubblewrap（OS のパッケージ管理で `bwrap` をインストール）を使用します。対応バックエンドがなければ shell 実行を拒否し、ファイルツールは引き続き利用できます。Windows では bubblewrap を備えた WSL を利用できます。

```sh
alfa
alfa -m gateway/model-id -p "このプロジェクトを説明して"
alfa --continue
alfa --resume
printf '失敗するテストを説明して\n' | alfa
```

初回起動は、テンプレートまたはカスタム API → プロトコル → エンドポイント → 非表示の認証情報入力 → モデル取得または ID 入力 → 実際の接続テスト → 今回だけ切り替え／デフォルト設定、の順です。テスト失敗やキャンセルでは不完全な設定を保存しません。

`/setting` のモデル・プロバイダー・認証情報から、追加（検索欄で `+`）、検索、編集、有効化、無効化、削除、接続テスト、切り替えができます。`/model provider/model` も利用でき、`ALFA_MODEL` の上書きがなければデフォルトを保存します。`/models` 未対応、通信失敗、不完全な一覧は「モデルがない」という意味ではありません。ID の手動入力は常に可能です。ループバックのローカル API はキーなし認証を選択できます。

名前付きプロバイダーは `anthropic`、`openai-responses`（OpenAI-compatible Responses API）、`openai-chat`（OpenAI-compatible Chat Completions）の 3 種類のアダプターを共有します。新しいカスタムエンドポイントは Responses が既定です。`/responses` 非対応の従来ゲートウェイでは Chat Completions を明示的に選択します。独自の認証ヘッダーとモデル取得の無効化にも対応します。

通常設定は `config.json`、キーは権限 0600 の `auth.json` に分離します。環境変数が優先されます：`ALFA_MODEL`、`ALFA_KEY_<NAME>`、`ALFA_BASE_URL_<NAME>`、従来の `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` と `OPENAI_API_KEY` / `OPENAI_BASE_URL`。有効なキーとエンドポイントの設定元を表示します。キーは非表示またはマスクされ、全体表示のコマンドはありません。`alfa auth login/list/logout` も維持します。

## 会話と操作

単一カラムの時系列表示です。回答、エラー、承認、edit/write の diff は端末のスクロール履歴に残り、入力部分には現在の動作だけを表示します。`/detail` で直近の完全なツール記録、`/detail read` または `/detail <callID>` で指定の記録を確認できます。`/jobs` と `/agents` はバックグラウンド処理を表示します。端末本来の選択・コピーを使えます。

実行中は入力欄の上の行に、何をしているか（思考・出力・どのツールか）、ターンの経過時間、思考の末尾を表示します。固定行には計画の進み具合、サブエージェント（実行中または一時停止中——一時停止中のものは記憶を保ったまま再開でき、`kill` で完全に削除されます）、バックグラウンド処理を表示します。フッターにはコンテキストの使用量、実測キャッシュヒット率、出力速度を表示します。

- Enter で送信。実行中は追加入力または待機。Ctrl-J / Alt-Enter で改行。
- Esc で中断。Ctrl-C で消去または中断、空入力で二度押すと終了。Ctrl-D で終了。
- Shift-Tab で権限モード変更。`/help` でコマンド確認。
- `@shot.png`、ファイルのドラッグ、または Ctrl-V(クリップボードのスクリーンショット)で画像を添付できます。Cmd-V はテキストしか貼り付けないため、コピーした画像には Ctrl-V を使います。貼り付けた `data:image/…` URL(Google 画像の「画像アドレスをコピー」で得られるもの)も画像として添付されます。
- `/setting` から権限、外部パス、プロジェクトの信頼、言語、チェック、子エージェント並列数、思考、推論の深さ、圧縮も設定できます。
- `/context`、`/compact`、`/check`、`/trust`、`/language`、`/think`、`/effort`、`/agentflow`、`/resume`、`/clear`、`/skills`、`/mcp`、`/init`、`/history-clean`、`/reset` を維持します。

`--plain` と `--no-mouse` は互換用の別名です。`/view` は移行を案内します。全画面パネル、ロボット、マウス取得、レイアウト設定は廃止しました。旧 `view` / `panels` は無視し、次回の設定保存時に除去します。`-p` とパイプ入力は対話端末を取得しません。

## 権限と複数ディレクトリ

**default モードは通常のワークスペース読み取り・編集・書き込みを許可し、edit/write の diff を必ず記録します。** 機密ファイル、危険なコマンド、ネットワーク、拡張ツールは厳しく扱います。`confirm` は通常の読み取り・編集や許可済みコマンドも毎回確認します。`auto` は alfa の主要な自律モードで、Claude Code の auto モードに倣っています。読み取りとワークスペース内の編集は通知なく実行します。それ以外は分類器が採点します（どれだけ明確に依頼されたかと、起こり得る損失の比較）。プロジェクト自身の build/test スクリプト（分類器はスクリプトの実際のコードを見ます）や、`.git`・`.husky`・シェルの rc ファイルなど保護パスの編集も対象です。明確に依頼されていない高リスク操作は agent に戻され、別の方法を選ぶかあなたに確認します。ブロックが続くと auto は一時停止し、あなたに判断を求めます。deny ルールとサンドボックス設定は auto でも有効で、ワークスペース外の最初の読み取りは一度確認します。コマンド出力とサブエージェントの報告は、モデルが読む前にプロンプトインジェクションを検査します。auto 終了時は実行中の作業を停止し、元のルールに戻ります。

起動ディレクトリは初期作業ルートです。外部アクセスは操作と解決済みの実パスを示し、今回のみ・セッション・永続を選べます。ファイル許可を親ディレクトリへ広げません。ディレクトリ許可は子孫も含むと明示します。

```text
/access
/access add read session /path/to/neighbor
/access add write persistent /path/to/second-repo
/access revoke /path/to/second-repo
/access revoke all
```

読み取り許可は書き込み許可ではありません。セッション切り替えで一時許可を消し、永続許可は初期ルートごとに保存します。取り消しは現在のターンを中断し、バックグラウンド処理と子エージェントを停止します。シンボリックリンクや未作成パスは存在する祖先を解決します。認証情報とシステムパスは引き続き制限し、「拒否」と「承認後の実行失敗」を区別します。

**権限ゲートは OS サンドボックスと同義ではありません。** OS サンドボックスは実験的機能で既定はオフです。設定で有効にでき、有効にすると auto を含むすべての権限モードで適用されます。Shell と自動チェックには同じパス台帳から生成したファイルシステム制限を適用し、子プロセスも継承します。macOS はシステム実行ライブラリと許可済みパスを読み取れ、既知の認証情報を拒否します。Linux は bubblewrap のマウントを使います。ネットワーク、実行ライブラリ、OS 差異、並行するファイル変更まで含めた完全なマシン隔離ではありません。Shell での秘密ファイルの制限は個別に承認したファイル読み取りより厳格です。MCP server と信頼済み拡張はホストプロセスとして動き、この shell サンドボックスの対象外です。

## 拡張・評価・開発

skills と MCP を維持します。外部 API v1 はツール、呼び出し前後イベント、`/x:name` コマンド、プレーンテキスト通知を提供します。グローバル設定で審査済み拡張の絶対パスと入口 SHA-256 を指定してください。拡張には**ホスト権限**があります。[API](docs/extensions.md) と [サンプル](examples/extension.ts) を参照してください。

CSV 解析、複数パッケージ API 移行、再試行キャンセルの三つの再現可能な課題を用意しました。[評価手順](eval/README.md) は独立した受け入れテスト、時間、token、料金、承認数、中断・再開を扱います。課題の検証結果はモデルの成功率ではなく、他の agent より優れるという主張はありません。

ソース開発は Bun ≥ 1.3 が必要です。

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

モデル呼び出しは設定したサービスへ直接送信します。web/MCP は追加の通信を行う場合があります。セッションはローカル SQLite に保存し、ツール出力やデバッグログにはプロジェクト内容が含まれる場合があります。alfa アカウントやテレメトリーサービスはありません。

設計：[DESIGN.md](DESIGN.md)。コントリビュート：[CONTRIBUTING.md](CONTRIBUTING.md)、セキュリティ報告：[SECURITY.md](SECURITY.md)、変更履歴：[CHANGELOG.md](CHANGELOG.md)。ライセンス：[Apache-2.0](LICENSE)、第三者表記：[NOTICE](NOTICE)。

設定は「プロバイダー → 接続先 → 認証情報 → モデル → 確認とテスト」の5ステップです。矢印キーと Enter、または入力で候補を絞り込めます。詳細設定は必要なときだけ表示し、テスト失敗後も編集を続けられます。会話で `/` を入力するとコマンド候補が表示されます。並列リクエストは承認済みの範囲を再確認し、承認キーが会話へ流れ込むことを防ぎます。
