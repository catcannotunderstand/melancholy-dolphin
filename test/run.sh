#!/bin/bash
# 偽の Azure を相手に、ビルドした dist/index.js を動かして全ツールを試す
cd "$(dirname "$0")/.."
node test/fake_arm.mjs & A=$!
MCP_SECRET=testsecret_0123456789abcdefXYZ SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000 \
TARGETS=voicevox-rg/voicevox,melancholy-dolphin-rg/melancholy-dolphin PORT=18091 \
ARM_ENDPOINT=http://127.0.0.1:18090 FAKE_ARM_TOKEN=test-token node dist/index.js > "${TMPDIR:-/tmp}/melancholy-dolphin-test.log" 2>&1 & S=$!
sleep 1.5
echo "healthz: $(curl -s localhost:18091/healthz)  wrong path: $(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:18091/mcp/wrong)  GET: $(curl -s -o /dev/null -w '%{http_code}' localhost:18091/mcp/testsecret_0123456789abcdefXYZ)"
python3 test/client_test.py http://127.0.0.1:18091/mcp/testsecret_0123456789abcdefXYZ
kill $A $S
