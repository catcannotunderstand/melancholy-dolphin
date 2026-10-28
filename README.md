# melancholy-dolphin

Azure Container Apps の状態とコストを **閲覧するだけ** の MCP サーバー。Claude のカスタムコネクタとして使う。

```
Claude ──(コネクタ)──▶ melancholy-dolphin(Azure Container Apps、0.25コア、使わないときは0台)
                              │ マネージドID(閲覧の権限だけ)
                              ▼
                     Azure Resource Manager(コンテナの状態・メトリクス・コスト・予算)
```

## ツール

| ツール | 内容 |
|---|---|
| `containerapp_status` | コンテナの今の状態(実行中か、0台に縮んでいるか)、動いている版とイメージ、レプリカ |
| `containerapp_revisions` | 入れ替えの履歴(自動デプロイが反映されたか) |
| `containerapp_metrics` | 1時間ごとのリクエスト数・レプリカ数・再起動回数 |
| `cost_summary` | 今月・先月・直近7日/30日のコスト。サブスクリプション全体か、対象のリソースグループ。リソースグループ別・サービス別などにまとめる |
| `containerapps_usage` | 今月の Container Apps の使用量(無料枠の消費) |
| `budgets` | 予算と今の使用額・予測額 |

コストのデータは Azure 側で数時間〜1日遅れて反映される。

## 守り

- **権限は閲覧だけ。** Azure へはアプリのマネージドID(パスワードや鍵なし)でアクセスし、与える権限は「見る対象のリソースグループの閲覧者」と「サブスクリプションのコスト管理の閲覧者」だけ。止める・変える操作はできない。対象でないリソースグループの中身は見られない(コストの金額だけは見える)。
- **見る対象は設定で固定。** 環境変数 `TARGETS`(`リソースグループ/アプリ名` のカンマ区切り)に書いたアプリしか調べられない。呼ぶ側が自由に指定することはできない。
- **秘密は返さない。** 返す項目を選んで組み立てていて、シークレット・環境変数の値・予算の通知先メールアドレスは含めない(テストで確認している)。
- **入口。** URL の中の40文字の秘密の文字列+ Azure の IP 制限(Claude のコネクタの通信元 `160.79.104.0/21` だけ)。
- **自動デプロイの権限。** GitHub Actions は、このリポジトリの main から実行されたときだけ、`melancholy-dolphin-rg` の中だけを操作できる(OIDC。鍵は保存しない)。

## 最初の設定(1回だけ)

1. このリポジトリに最初にプッシュすると、GitHub Actions がイメージを作る。
2. GitHub のプロフィール → Packages → `melancholy-dolphin` → Package settings → Change visibility → **Public**(コードにもイメージにも秘密はない)。
3. Azure Cloud Shell(Bash)で実行する。
   ```
   cd ~ && rm -rf melancholy-dolphin
   git clone https://github.com/catcannotunderstand/melancholy-dolphin && cd melancholy-dolphin
   bash setup.sh
   ```
4. 表示された URL を claude.ai の 設定 → コネクタ → カスタムコネクタを追加 に登録する(人に見せない)。
5. 表示された `AZURE_CLIENT_ID=…` を Claude に伝える(`.github/workflows/build.yml` に書けば、以後はプッシュで自動入れ替え)。

## 見る対象を足す

```
bash add_target.sh <リソースグループ>/<アプリ名>
```

そのリソースグループの閲覧者の権限を付け、`TARGETS` に加える。URL は変わらない。

## 開発

```
npm ci && npm run build
./test/run.sh      # 偽の Azure を相手に全ツールを呼び、秘密が漏れていないか確かめる(要: python3 と mcp)
```

## 片付け

`az group delete -n melancholy-dolphin-rg` でアプリと実行環境が消える。Entra ID のアプリの登録「melancholy-dolphin-deploy」と、対象のリソースグループに付けた閲覧者の権限は別に残るので、必要なら消す。

## ファイル

| ファイル | 内容 |
|---|---|
| `src/index.ts` | サーバー本体 |
| `Dockerfile` | イメージ(node:22-slim) |
| `.github/workflows/build.yml` | テスト → イメージ作成 → Azure の入れ替え |
| `setup.sh` | 最初の設定(1回だけ) |
| `add_target.sh` | 見る対象を足す |
| `test/` | 偽の Azure と、MCP クライアントからのテスト |
