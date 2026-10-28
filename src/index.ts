/**
 * Azure Container Apps の状態とコストを「閲覧するだけ」の MCP サーバー(Claude のカスタムコネクタ用)。
 *
 * - 認証: URL の中の秘密の文字列(/mcp/<MCP_SECRET>)+ Azure 側の IP 制限(VOICEVOX と同じ方式)
 * - Azure へは、このアプリのマネージドID(パスワード不要)でアクセスする。
 *   権限は「対象のリソースグループの閲覧者」と「サブスクリプションのコスト管理の閲覧者」だけ。変更する操作は一切しない。
 * - 調べられるアプリは TARGETS に書いたものだけ(呼ぶ側が自由に指定できないようにする)。
 * - 返す内容は項目を選んで組み立てる。シークレットや環境変数の値は返さない。
 *
 * 環境変数:
 *   MCP_SECRET       必須。24文字以上の英数字
 *   SUBSCRIPTION_ID  必須
 *   TARGETS          必須。「リソースグループ/アプリ名」のカンマ区切り
 *                    (例: voicevox-rg/voicevox,melancholy-dolphin-rg/melancholy-dolphin)
 *   PORT             既定 8080
 *   ARM_ENDPOINT     既定 https://management.azure.com(テスト用に差し替えられる)
 *   FAKE_ARM_TOKEN   テスト用。指定するとマネージドIDの代わりにこのトークンを使う
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { ManagedIdentityCredential } from "@azure/identity";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ------------------------------------------------------------------ 設定

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`${name} を設定してください`); process.exit(1); }
  return v;
}
const MCP_SECRET = need("MCP_SECRET");
if (!/^[A-Za-z0-9_-]{24,}$/.test(MCP_SECRET)) { console.error("MCP_SECRET は24文字以上の英数字にしてください"); process.exit(1); }
const SUB = need("SUBSCRIPTION_ID");
type Target = { rg: string; app: string; key: string };
const NAME = /^[A-Za-z0-9._()-]{1,90}$/;
const TARGETS: Target[] = need("TARGETS").split(",").map(s => s.trim()).filter(Boolean).map(s => {
  const [rg, app, ...rest] = s.split("/");
  if (!rg || !app || rest.length || !NAME.test(rg) || !NAME.test(app)) { console.error(`TARGETS の書き方が違います: ${s}`); process.exit(1); }
  return { rg, app, key: app };
});
// 同じアプリ名が別のリソースグループにもあるときは「リソースグループ/アプリ名」で呼び分ける
for (const t of TARGETS) if (TARGETS.filter(u => u.app === t.app).length > 1) t.key = `${t.rg}/${t.app}`;
const APPS = TARGETS.map(t => t.key) as [string, ...string[]];
const RGS = [...new Set(TARGETS.map(t => t.rg))];
const target = (key: string) => TARGETS.find(t => t.key === key)!;
const PORT = Number(process.env.PORT ?? 8080);
const ARM = (process.env.ARM_ENDPOINT ?? "https://management.azure.com").replace(/\/$/, "");
const MCP_PATH = `/mcp/${MCP_SECRET}`;

const APP_API = "2024-03-01";
const COST_API = "2023-11-01";
const BUDGET_API = "2023-05-01";
const METRICS_API = "2023-10-01";

// ------------------------------------------------------------------ Azure への問い合わせ

const credential = process.env.FAKE_ARM_TOKEN ? null : new ManagedIdentityCredential();

async function token(): Promise<string> {
  if (!credential) return process.env.FAKE_ARM_TOKEN!;
  const t = await credential.getToken("https://management.azure.com/.default");
  if (!t) throw new Error("マネージドIDのトークンを取得できませんでした");
  return t.token;
}

class ArmError extends Error {}

async function arm(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ARM + path, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res.json();
    // コスト管理の API は呼びすぎると 429 を返す。1回だけ待ってやり直す
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(15, Number(res.headers.get("retry-after") ?? res.headers.get("x-ms-ratelimit-microsoft.costmanagement-entity-retry-after") ?? 5));
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    let detail = "";
    try { detail = ((await res.json()) as any)?.error?.message ?? ""; } catch { /* 本文なし */ }
    const hint: Record<number, string> = {
      401: "認証に失敗しました(マネージドIDの設定を確認)",
      403: "権限がありません(ロールの割り当てを確認。付けたばかりなら数分待つ)",
      404: "見つかりません",
      429: "呼び出しが多すぎます。少し待ってからやり直してください",
    };
    throw new ArmError(`${hint[res.status] ?? `Azure がエラーを返しました(HTTP ${res.status})`}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
}

const appPath = (key: string) => {
  const t = target(key);
  return `/subscriptions/${SUB}/resourceGroups/${encodeURIComponent(t.rg)}/providers/Microsoft.App/containerApps/${encodeURIComponent(t.app)}`;
};

// ------------------------------------------------------------------ 整形

const img = (s?: string) => s ?? null;

function containerSummary(c: any) {
  return { name: c?.name, image: img(c?.image), cpu: c?.resources?.cpu ?? null, memory: c?.resources?.memory ?? null };
}

function revisionSummary(r: any) {
  const p = r?.properties ?? {};
  return {
    name: r?.name,
    created: p.createdTime ?? null,
    active: p.active ?? null,
    traffic_percent: p.trafficWeight ?? null,
    replicas: p.replicas ?? null,
    running_state: p.runningState ?? null,
    health: p.healthState ?? null,
    provisioning: p.provisioningState ?? null,
    image: img(p.template?.containers?.[0]?.image),
  };
}

function table(res: any) {
  const cols: { name: string }[] = res?.properties?.columns ?? [];
  const rows: any[][] = res?.properties?.rows ?? [];
  return rows.map(r => Object.fromEntries(cols.map((c, i) => [c.name, r[i]])));
}

const round = (n: unknown, d = 2) => typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : n;

function costColumn(row: Record<string, unknown>): string | undefined {
  return ["Cost", "PreTaxCost", "CostUSD", "PreTaxCostUSD"].find(k => k in row);
}

function timeframe(period: "this_month" | "last_month" | "last_7_days" | "last_30_days") {
  if (period === "this_month") return { timeframe: "MonthToDate" };
  if (period === "last_month") return { timeframe: "TheLastMonth" };
  const to = new Date();
  const from = new Date(to.getTime() - (period === "last_7_days" ? 7 : 30) * 86400_000);
  return { timeframe: "Custom", timePeriod: { from: from.toISOString(), to: to.toISOString() } };
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

async function safe(fn: () => Promise<unknown>) {
  try { return ok(await fn()); } catch (e) { console.error(e); return fail(e); }
}

// ------------------------------------------------------------------ ツール

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const appArg = z.enum(APPS).default(APPS[0]).describe(`調べるアプリ(${APPS.join(" / ")})`);

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "melancholy-dolphin", version: "0.2.0" },
    {
      instructions:
        `Azure Container Apps の状態と、サブスクリプションのコストを見るためのツール。閲覧のみ。対象のアプリ: ${TARGETS.map(t => `${t.rg}/${t.app}`).join(", ")}。` +
        "コストのデータは Azure 側で数時間〜1日遅れて反映される。金額の通貨は結果の currency を見る。",
    },
  );

  server.registerTool("containerapp_status", {
    title: "コンテナの状態",
    description: "アプリの今の状態(実行中か、0台に縮んでいるか)、動いている版(リビジョン)とイメージ、台数の設定、動いているレプリカを返す。",
    inputSchema: { app: appArg },
    annotations: READ_ONLY,
  }, ({ app }) => safe(async () => {
    const a = await arm("GET", `${appPath(app)}?api-version=${APP_API}`);
    const p = a.properties ?? {};
    const revs = (await arm("GET", `${appPath(app)}/revisions?api-version=${APP_API}`)).value ?? [];
    const active = revs.filter((r: any) => r?.properties?.active);
    const replicas = [];
    for (const r of active) {
      const list = (await arm("GET", `${appPath(app)}/revisions/${encodeURIComponent(r.name)}/replicas?api-version=${APP_API}`)).value ?? [];
      for (const x of list) {
        replicas.push({
          revision: r.name, name: x?.name, created: x?.properties?.createdTime ?? null,
          running_state: x?.properties?.runningState ?? null,
          containers: (x?.properties?.containers ?? []).map((c: any) => ({
            name: c?.name, ready: c?.ready ?? null, started: c?.started ?? null, restart_count: c?.restartCount ?? null,
          })),
        });
      }
    }
    return {
      app: a.name,
      resource_group: target(app).rg,
      location: a.location,
      running_status: p.runningStatus ?? null,
      provisioning_state: p.provisioningState ?? null,
      latest_revision: p.latestRevisionName ?? null,
      latest_ready_revision: p.latestReadyRevisionName ?? null,
      containers: (p.template?.containers ?? []).map(containerSummary),
      scale: { min_replicas: p.template?.scale?.minReplicas ?? 0, max_replicas: p.template?.scale?.maxReplicas ?? null },
      ingress: p.configuration?.ingress ? {
        external: p.configuration.ingress.external ?? null,
        target_port: p.configuration.ingress.targetPort ?? null,
        ip_rules: (p.configuration.ingress.ipSecurityRestrictions ?? []).map((r: any) => ({ name: r?.name, ip: r?.ipAddressRange, action: r?.action })),
      } : null,
      active_revisions: active.map(revisionSummary),
      running_replicas: replicas,
      note: replicas.length === 0 ? "動いているレプリカは0台(使われていないので縮んでいる。次の呼び出しで起動する)" : undefined,
    };
  }));

  server.registerTool("containerapp_revisions", {
    title: "入れ替えの履歴",
    description: "アプリのリビジョン(デプロイのたびに作られる版)を新しい順に返す。自動デプロイが反映されたかの確認に使う。",
    inputSchema: { app: appArg, limit: z.number().int().min(1).max(30).default(10).describe("返す件数") },
    annotations: READ_ONLY,
  }, ({ app, limit }) => safe(async () => {
    const revs = (await arm("GET", `${appPath(app)}/revisions?api-version=${APP_API}`)).value ?? [];
    const list = revs.map(revisionSummary).sort((x: any, y: any) => String(y.created).localeCompare(String(x.created)));
    return { app, total: list.length, revisions: list.slice(0, limit) };
  }));

  server.registerTool("containerapp_metrics", {
    title: "利用状況",
    description: "直近の数時間〜数日の、1時間ごとのリクエスト数、レプリカ数(最大)、再起動回数を返す。いつ起きていたか、どれだけ使われたかが分かる。",
    inputSchema: { app: appArg, hours: z.number().int().min(1).max(168).default(24).describe("さかのぼる時間(1〜168)") },
    annotations: READ_ONLY,
  }, ({ app, hours }) => safe(async () => {
    const q = new URLSearchParams({
      "api-version": METRICS_API, metricnames: "Requests,Replicas,RestartCount",
      timespan: `PT${hours}H`, interval: "PT1H", aggregation: "Total,Maximum",
    });
    const m = await arm("GET", `${appPath(app)}/providers/Microsoft.Insights/metrics?${q}`);
    type Hour = { requests?: number; restarts?: number; max_replicas?: number };
    const byHour = new Map<string, Hour>();
    const totals: Record<string, number> = { requests: 0, restarts: 0, max_replicas: 0 };
    for (const metric of m.value ?? []) {
      const name = metric?.name?.value as string;
      for (const d of metric?.timeseries?.[0]?.data ?? []) {
        const row: Hour = byHour.get(d.timeStamp) ?? {};
        if (name === "Requests") { row.requests = d.total ?? 0; totals.requests += d.total ?? 0; }
        if (name === "RestartCount") { row.restarts = d.total ?? 0; totals.restarts += d.total ?? 0; }
        if (name === "Replicas") { row.max_replicas = d.maximum ?? 0; totals.max_replicas = Math.max(totals.max_replicas, d.maximum ?? 0); }
        byHour.set(d.timeStamp, row);
      }
    }
    const rows = [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, v]) => ({ hour, ...v }) as { hour: string } & Hour)
      .filter(r => (r.requests ?? 0) > 0 || (r.max_replicas ?? 0) > 0 || (r.restarts ?? 0) > 0);
    return {
      app, hours, totals,
      active_hours: rows.filter(r => (r.max_replicas ?? 0) > 0).length,
      hours_with_activity: rows,
      note: "動きのなかった時間は省いている。時刻は UTC。",
    };
  }));

  const groupNames = { resource_group: "ResourceGroupName", service: "ServiceName", resource: "ResourceId", meter: "Meter" } as const;

  server.registerTool("cost_summary", {
    title: "コスト",
    description: "サブスクリプション(または対象のリソースグループ)の実際のコストを、期間とまとめ方を選んで返す。データは数時間〜1日遅れる。",
    inputSchema: {
      period: z.enum(["this_month", "last_month", "last_7_days", "last_30_days"]).default("this_month").describe("期間"),
      group_by: z.enum(["resource_group", "service", "resource", "meter"]).default("service").describe("まとめ方"),
      scope: z.enum(["subscription", ...RGS] as [string, ...string[]]).default("subscription").describe(`範囲(subscription か、リソースグループ: ${RGS.join(" / ")})`),
    },
    annotations: READ_ONLY,
  }, ({ period, group_by, scope }) => safe(async () => {
    const scopePath = scope === "subscription" ? `/subscriptions/${SUB}` : `/subscriptions/${SUB}/resourceGroups/${encodeURIComponent(scope)}`;
    const res = await arm("POST", `${scopePath}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`, {
      type: "ActualCost", ...timeframe(period),
      dataset: {
        granularity: "None",
        aggregation: { totalCost: { name: "Cost", function: "Sum" } },
        grouping: [{ type: "Dimension", name: groupNames[group_by] }],
      },
    });
    const rows = table(res);
    const cc = rows[0] ? costColumn(rows[0]) : undefined;
    const items = rows.map(r => ({
      name: group_by === "resource" ? String(r[groupNames[group_by]] ?? "").split("/").slice(-2).join("/") : r[groupNames[group_by]],
      cost: round(cc ? r[cc] : null),
      currency: r.Currency ?? null,
    })).sort((a: any, b: any) => (b.cost ?? 0) - (a.cost ?? 0));
    const total = items.reduce((s, x: any) => s + (typeof x.cost === "number" ? x.cost : 0), 0);
    return {
      period, scope, group_by,
      total: round(total), currency: items[0]?.currency ?? null,
      items: items.slice(0, 25), more: items.length > 25 ? items.length - 25 : 0,
    };
  }));

  server.registerTool("containerapps_usage", {
    title: "Container Apps の無料枠の消費",
    description: "今月の Azure Container Apps の使用量(メーターごとの数量と金額)を返す。無料枠はサブスクリプション全体で毎月 180,000 vCPU秒・360,000 GiB秒・200万リクエスト。データは数時間〜1日遅れる。",
    inputSchema: {},
    annotations: READ_ONLY,
  }, () => safe(async () => {
    const res = await arm("POST", `/subscriptions/${SUB}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`, {
      type: "Usage", timeframe: "MonthToDate",
      dataset: {
        granularity: "None",
        aggregation: { totalCost: { name: "Cost", function: "Sum" }, totalQuantity: { name: "UsageQuantity", function: "Sum" } },
        grouping: [{ type: "Dimension", name: "Meter" }],
        filter: { dimensions: { name: "MeterCategory", operator: "In", values: ["Azure Container Apps"] } },
      },
    });
    const rows = table(res);
    const cc = rows[0] ? costColumn(rows[0]) : undefined;
    return {
      month_to_date: true,
      meters: rows.map(r => ({ meter: r.Meter, quantity: round(r.UsageQuantity, 3), cost: round(cc ? r[cc] : null), currency: r.Currency ?? null })),
      free_grant_per_month: { vcpu_seconds: 180000, gib_seconds: 360000, requests: 2000000 },
      note: "数量の単位はメーターによって異なる(秒・時間・100万リクエストなど)。金額が0なら無料枠の範囲内。",
    };
  }));

  server.registerTool("budgets", {
    title: "予算",
    description: "サブスクリプションに設定された予算と、今の使用額・予測額、通知のしきい値を返す(通知先のメールアドレスは返さない)。",
    inputSchema: {},
    annotations: READ_ONLY,
  }, () => safe(async () => {
    const res = await arm("GET", `/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets?api-version=${BUDGET_API}`);
    const budgets = (res.value ?? []).map((b: any) => {
      const p = b?.properties ?? {};
      return {
        name: b?.name, amount: p.amount ?? null, time_grain: p.timeGrain ?? null,
        current_spend: p.currentSpend ? { amount: round(p.currentSpend.amount), unit: p.currentSpend.unit } : null,
        forecast_spend: p.forecastSpend ? { amount: round(p.forecastSpend.amount), unit: p.forecastSpend.unit } : null,
        thresholds: Object.values(p.notifications ?? {}).map((n: any) => ({ enabled: n?.enabled, operator: n?.operator, threshold_percent: n?.threshold, type: n?.thresholdType ?? "Actual" })),
      };
    });
    return { budgets, note: budgets.length ? undefined : "予算は設定されていない。ポータルの「コストの管理」→「予算」から作れる。" };
  }));

  return server;
}

// ------------------------------------------------------------------ HTTP

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  try {
    if (path === "/healthz") return send(res, 200, { ok: true });
    if (path !== MCP_PATH) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    const body = await readJson(req);
    // セッションを持たない方式: 1リクエストごとにサーバーを作って捨てる
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null });
  }
}).listen(PORT, () => console.log(`melancholy-dolphin MCP listening on ${PORT} (targets: ${TARGETS.map(t => `${t.rg}/${t.app}`).join(", ")})`));
