"""MCP クライアントとして全ツールを呼び、結果と、秘密が漏れていないことを確かめる。"""
import asyncio, json, sys
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = sys.argv[1]
LEAKS = ["SHOULD-NOT-LEAK", "mcp-secret", "gcs-key", "GCS_BUCKET", "test-token"]


async def main():
    async with streamablehttp_client(URL) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = (await s.list_tools()).tools
            print("tools:", [(t.name, t.annotations.readOnlyHint if t.annotations else None) for t in tools])
            calls = [
                ("containerapp_status", {}),
                ("containerapp_revisions", {"limit": 5}),
                ("containerapp_metrics", {"hours": 24}),
                ("cost_summary", {"period": "this_month", "group_by": "resource_group"}),
                ("cost_summary", {"period": "last_7_days", "group_by": "resource"}),
                ("containerapps_usage", {}),
                ("budgets", {}),
                ("containerapp_status", {"app": "someone-elses-app"}),
                ("containerapp_status", {"app": "melancholy-dolphin"}),
                ("cost_summary", {"scope": "voicevox-rg", "group_by": "service"}),
                ("cost_summary", {"scope": "licorice"}),
            ]
            leaked = []
            for name, args in calls:
                res = await s.call_tool(name, args)
                text = res.content[0].text
                leaked += [k for k in LEAKS if k in text]
                print(f"--- {name} {args} isError={res.isError}")
                print(text[:700])
            print("LEAKS:", leaked or "なし")


asyncio.run(main())
