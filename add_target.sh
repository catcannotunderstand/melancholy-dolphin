#!/bin/bash
# 見る対象のアプリを足す(Azure Cloud Shell で実行)。
#   使い方: bash add_target.sh <リソースグループ>/<アプリ名>
#   例:     bash add_target.sh my-blog-rg/my-blog
# そのリソースグループの「閲覧者」の権限をコネクタに与え、対象の一覧に加える。URLは変わらない。
set -euo pipefail

NEW="${1:?「リソースグループ/アプリ名」を指定してください(例: my-blog-rg/my-blog)}"
[[ "$NEW" =~ ^[A-Za-z0-9._()-]+/[A-Za-z0-9._()-]+$ ]] || { echo "書き方が違います: $NEW"; exit 1; }
RG="melancholy-dolphin-rg"
APP="melancholy-dolphin"
NEW_RG="${NEW%%/*}"; NEW_APP="${NEW##*/}"

az config set extension.use_dynamic_install=yes_without_prompt >/dev/null 2>&1 || true
az extension add -n containerapp --upgrade -y </dev/null >/dev/null 2>&1
SUB=$(az account show --query id -o tsv)

az containerapp show -n "$NEW_APP" -g "$NEW_RG" -o none 2>/dev/null || { echo "${NEW} が見つかりません"; exit 1; }

PRINCIPAL=$(az containerapp show -n "$APP" -g "$RG" --query identity.principalId -o tsv)
SCOPE="/subscriptions/${SUB}/resourceGroups/${NEW_RG}"
if [ -z "$(az role assignment list --assignee "$PRINCIPAL" --role Reader --scope "$SCOPE" --query '[0].id' -o tsv)" ]; then
  az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role Reader --scope "$SCOPE" -o none
fi

TARGETS=$(az containerapp show -n "$APP" -g "$RG" \
  --query "properties.template.containers[0].env[?name=='TARGETS'].value | [0]" -o tsv)
if [[ ",${TARGETS}," == *",${NEW},"* ]]; then
  echo "${NEW} はすでに対象です"
else
  az containerapp update -n "$APP" -g "$RG" --set-env-vars TARGETS="${TARGETS},${NEW}" -o none
  echo "対象に ${NEW} を足しました(${NEW_RG} の閲覧者の権限も付けました)。"
fi
