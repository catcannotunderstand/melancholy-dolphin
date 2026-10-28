// 動作確認用の偽の Azure Resource Manager。実際の応答の形をまねる(値は架空)。
import { createServer } from "node:http";

const SUB = "00000000-0000-0000-0000-000000000000", RG = "voicevox-rg";
const APP = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps`;
const APP2 = `/subscriptions/${SUB}/resourceGroups/melancholy-dolphin-rg/providers/Microsoft.App/containerApps`;
let costCalls = 0;

const app = name => ({
  id: `${APP}/${name}`, name, location: "Japan East",
  properties: {
    provisioningState: "Succeeded", runningStatus: "Running",
    latestRevisionName: `${name}--r1028`, latestReadyRevisionName: `${name}--r1028`,
    configuration: {
      // 本物の応答と同じく、シークレットは名前だけ・環境変数は値も入っている。どちらも外に出してはいけない
      secrets: [{ name: "mcp-secret" }, { name: "gcs-key" }],
      ingress: { external: true, targetPort: 8080, fqdn: `${name}.example.japaneast.azurecontainerapps.io`,
        ipSecurityRestrictions: [{ name: "anthropic", ipAddressRange: "160.79.104.0/21", action: "Allow" }] },
    },
    template: {
      containers: [{ name, image: `ghcr.io/catcannotunderstand/cheerful-owl:abc123`, resources: { cpu: 2, memory: "4Gi" },
        env: [{ name: "MCP_SECRET", secretRef: "mcp-secret" }, { name: "GCS_BUCKET", value: "SHOULD-NOT-LEAK-bucket" }] }],
      scale: { minReplicas: 0, maxReplicas: 1 },
    },
  },
});
const rev = (name, created, active) => ({ name, properties: { createdTime: created, active, trafficWeight: active ? 100 : 0, replicas: active ? 1 : 0,
  runningState: active ? "Running" : "Deprovisioned", healthState: "Healthy", provisioningState: "Provisioned",
  template: { containers: [{ image: `ghcr.io/catcannotunderstand/cheerful-owl:${name.slice(-5)}` }] } } });

function route(method, path, query) {
  if (method === "GET" && path === `${APP}/voicevox`) return app("voicevox");
  if (method === "GET" && path === `${APP2}/melancholy-dolphin`) return app("melancholy-dolphin");
  if (method === "GET" && path === `${APP2}/melancholy-dolphin/revisions`) return { value: [] };
  if (method === "GET" && path === `${APP}/voicevox/revisions`)
    return { value: [rev("voicevox--r1026", "2026-10-26T12:30:00Z", false), rev("voicevox--r1028", "2026-10-28T12:00:00Z", true)] };
  if (method === "GET" && path === `${APP}/voicevox/revisions/voicevox--r1028/replicas`)
    return { value: [{ name: "voicevox--r1028-abc", properties: { createdTime: "2026-10-28T12:59:00Z", runningState: "Running",
      containers: [{ name: "voicevox", ready: true, started: true, restartCount: 0 }] } }] };
  if (method === "GET" && path === `${APP}/voicevox/providers/Microsoft.Insights/metrics`) {
    const h = t => `2026-10-28T${String(t).padStart(2, "0")}:00:00Z`;
    return { value: [
      { name: { value: "Requests" }, timeseries: [{ data: [{ timeStamp: h(11), total: 0 }, { timeStamp: h(12), total: 42 }, { timeStamp: h(13), total: 7 }] }] },
      { name: { value: "Replicas" }, timeseries: [{ data: [{ timeStamp: h(11), maximum: 0 }, { timeStamp: h(12), maximum: 1 }, { timeStamp: h(13), maximum: 1 }] }] },
      { name: { value: "RestartCount" }, timeseries: [{ data: [{ timeStamp: h(11), total: 0 }, { timeStamp: h(12), total: 0 }, { timeStamp: h(13), total: 1 }] }] },
    ] };
  }
  if (method === "POST" && path.endsWith("/providers/Microsoft.CostManagement/query")) {
    costCalls++;
    if (costCalls === 1) return { status: 429, headers: { "retry-after": "1" }, body: { error: { message: "Too many requests" } } };
    return "COST";
  }
  if (method === "GET" && path === `/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets`)
    return { value: [{ name: "monthly-500", properties: { amount: 500, timeGrain: "Monthly", currentSpend: { amount: 123.456, unit: "JPY" },
      forecastSpend: { amount: 300.1, unit: "JPY" }, notifications: { a: { enabled: true, operator: "GreaterThan", threshold: 80, contactEmails: ["SHOULD-NOT-LEAK@example.com"] } } } }] };
  if (path.includes("forbidden")) return { status: 403, body: { error: { message: "does not have authorization" } } };
  return { status: 404, body: { error: { message: "not found" } } };
}

function cost(body) {
  const g = body.dataset.grouping[0].name;
  if (g === "Meter") return { properties: {
    columns: [{ name: "Cost" }, { name: "UsageQuantity" }, { name: "Meter" }, { name: "Currency" }],
    rows: [[0, 5321.5, "Standard vCPU Active Usage", "JPY"], [0, 10643, "Standard Memory Active Usage", "JPY"], [0, 0.012, "Standard Requests", "JPY"]] } };
  const names = { ResourceGroupName: ["voicevox-rg", "licorice"], ServiceName: ["Azure Container Apps", "SQL Database"],
    ResourceId: [`${APP}/voicevox`, `/subscriptions/${SUB}/resourceGroups/licorice/providers/Microsoft.Sql/servers/licori225`], Meter: [] }[g];
  return { properties: { columns: [{ name: "PreTaxCost" }, { name: g }, { name: "Currency" }],
    rows: [[12.345, names[0], "JPY"], [880.5, names[1], "JPY"]] } };
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = ""; for await (const c of req) body += c;
  if (req.headers.authorization !== "Bearer test-token") { res.writeHead(401).end("{}"); return; }
  if (!url.searchParams.get("api-version")) { res.writeHead(400).end(JSON.stringify({ error: { message: "api-version missing" } })); return; }
  let out = route(req.method, url.pathname, url.searchParams);
  if (out === "COST") out = cost(JSON.parse(body));
  if (out && out.status) { res.writeHead(out.status, { "Content-Type": "application/json", ...(out.headers ?? {}) }).end(JSON.stringify(out.body)); return; }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
}).listen(18090);
