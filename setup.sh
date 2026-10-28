#!/bin/bash
# Azure Cloud Shell (Bash) で1回だけ実行する。Azure の状態とコストを閲覧するコネクタを作る。
#
#   1. 専用のリソースグループ・実行環境・アプリ(melancholy-dolphin)を作る
#   2. アプリにマネージドID(パスワード不要の身分証明)を付け、閲覧の権限だけ与える
#        - 見る対象のリソースグループの「閲覧者」
#        - サブスクリプションの「コスト管理の閲覧者」(金額と予算だけ。リソースの中身は見られない)
#   3. 外からの入口を Claude の IP 範囲だけにする(+URLの秘密の文字列)
#   4. GitHub Actions がこのリポジトリの main からだけ、専用のリソースグループの中だけを入れ替えられるようにする
#
# 使い方: bash setup.sh
# 2回目以降に実行しても、作成済みのものは飛ばして足りないものだけ作る。
set -euo pipefail

REPO="catcannotunderstand/melancholy-dolphin"
REPO_IDS="catcannotunderstand@207208477/melancholy-dolphin@1437156453"   # GitHub の新しい形式の名乗り
RG="melancholy-dolphin-rg"
LOC="japaneast"
ENV_NAME="melancholy-dolphin-env"
APP="melancholy-dolphin"
IMAGE="ghcr.io/catcannotunderstand/melancholy-dolphin:latest"
DEPLOY_NAME="melancholy-dolphin-deploy"
ANTHROPIC_IPS="160.79.104.0/21"
# 見る対象(リソースグループ/アプリ名)。あとから足すときは add_target.sh を使う
DEFAULT_TARGETS="voicevox-rg/voicevox,${RG}/${APP}"

echo "== 準備(拡張機能。1〜2分)"
az config set extension.use_dynamic_install=yes_without_prompt >/dev/null 2>&1 || true
az extension add -n containerapp --upgrade -y </dev/null
for p in Microsoft.App Microsoft.OperationalInsights; do az provider register -n "$p" --wait >/dev/null; done
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)

echo "== リソースグループと実行環境(初回は数分)"
az group create -n "$RG" -l "$LOC" -o none
az containerapp env show -n "$ENV_NAME" -g "$RG" -o none 2>/dev/null || \
  az containerapp env create -n "$ENV_NAME" -g "$RG" -l "$LOC" --logs-destination none -o none

echo "== アプリ"
SECRET=$(az containerapp secret show -n "$APP" -g "$RG" --secret-name mcp-secret --query value -o tsv </dev/null 2>/dev/null || true)
SECRET="${SECRET:-$(openssl rand -hex 20)}"
if az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  az containerapp identity assign -n "$APP" -g "$RG" --system-assigned -o none
  TARGETS=$(az containerapp show -n "$APP" -g "$RG" \
    --query "properties.template.containers[0].env[?name=='TARGETS'].value | [0]" -o tsv)
  TARGETS="${TARGETS:-$DEFAULT_TARGETS}"
else
  TARGETS="$DEFAULT_TARGETS"
  az containerapp create -n "$APP" -g "$RG" --environment "$ENV_NAME" \
    --image "$IMAGE" --system-assigned \
    --secrets mcp-secret="$SECRET" \
    --env-vars MCP_SECRET=secretref:mcp-secret SUBSCRIPTION_ID="$SUB" TARGETS="$TARGETS" \
    --cpu 0.25 --memory 0.5Gi --min-replicas 0 --max-replicas 1 \
    --ingress external --target-port 8080 -o none
fi
PRINCIPAL=$(az containerapp show -n "$APP" -g "$RG" --query identity.principalId -o tsv)

grant() {  # $1=相手のオブジェクトID $2=ロール $3=範囲
  if [ -z "$(az role assignment list --assignee "$1" --role "$2" --scope "$3" --query '[0].id' -o tsv)" ]; then
    for i in 1 2 3 4 5 6; do
      az role assignment create --assignee-object-id "$1" --assignee-principal-type ServicePrincipal \
        --role "$2" --scope "$3" -o none && return 0
      echo "  反映待ち…($i)"; sleep 10
    done
    return 1
  fi
}

echo "== 閲覧の権限"
for rg in $(echo "$TARGETS" | tr ',' '\n' | cut -d/ -f1 | sort -u); do
  if az group show -n "$rg" -o none 2>/dev/null; then
    grant "$PRINCIPAL" "Reader" "/subscriptions/${SUB}/resourceGroups/${rg}"
    echo "  ${rg} の閲覧者"
  else
    echo "  ${rg} は見つからないので飛ばしました"
  fi
done
grant "$PRINCIPAL" "Cost Management Reader" "/subscriptions/${SUB}"
echo "  サブスクリプションのコスト管理の閲覧者"

echo "== Claude からの通信だけを通す"
az containerapp ingress access-restriction set -n "$APP" -g "$RG" \
  --rule-name anthropic --ip-address "$ANTHROPIC_IPS" --action Allow \
  --description "Claude connectors" -o none

echo "== GitHub からの自動入れ替え(このリポジトリの main からだけ、${RG} の中だけ)"
CLIENT_ID=$(az ad app list --display-name "$DEPLOY_NAME" --query "[0].appId" -o tsv)
[ -n "$CLIENT_ID" ] || CLIENT_ID=$(az ad app create --display-name "$DEPLOY_NAME" --query appId -o tsv)
SP_ID=$(az ad sp show --id "$CLIENT_ID" --query id -o tsv 2>/dev/null || true)
[ -n "$SP_ID" ] || SP_ID=$(az ad sp create --id "$CLIENT_ID" --query id -o tsv)
add_cred() {  # $1=名前 $2=subject
  if [ -z "$(az ad app federated-credential list --id "$CLIENT_ID" --query "[?name=='$1'].name" -o tsv)" ]; then
    az ad app federated-credential create --id "$CLIENT_ID" --parameters "{
      \"name\": \"$1\", \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"$2\", \"audiences\": [\"api://AzureADTokenExchange\"]
    }" -o none
  fi
}
add_cred github-main     "repo:${REPO}:ref:refs/heads/main"
add_cred github-main-ids "repo:${REPO_IDS}:ref:refs/heads/main"
grant "$SP_ID" "Contributor" "/subscriptions/${SUB}/resourceGroups/${RG}"

FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo
echo "できました。"
echo
echo "1) claude.ai の 設定 → コネクタ → カスタムコネクタを追加 に、次のURLを登録してください。"
echo "   (このURLはパスワードと同じです。人に見せないでください)"
echo
echo "   https://${FQDN}/mcp/${SECRET}"
echo
echo "2) 次の3行を Claude に貼ってください(パスワードではないので貼って大丈夫です)。"
echo
echo "AZURE_CLIENT_ID=${CLIENT_ID}"
echo "AZURE_TENANT_ID=${TENANT}"
echo "AZURE_SUBSCRIPTION_ID=${SUB}"
echo
echo "見る対象: ${TARGETS}"
echo "権限の反映に数分かかることがあります。最初に「権限がありません」と出たら、少し待ってからやり直してください。"
