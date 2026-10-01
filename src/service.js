import http from "node:http";
import { pathToFileURL } from "node:url";

import {
  allocateMaterials,
  assertConservation,
  closePermit,
  completeRecoveryCheck,
  createLedger,
  fingerprintOf,
  handoff,
  issuePermit,
  publicForestland,
  publicPermit,
  publicRecord,
  publicVerification,
  publishForestland,
  reconciliationReport,
  recycleScrap,
  registerCraft,
  requestQuota,
  returnMaterials,
  reviseForestlandRules,
  submitHarvestRecord,
  traceRecords,
  traceRecordToCrafts,
} from "./domain.js";

export const serviceId = "craft-provenance";
export const serviceName = "传统工艺来源授权账";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

// 领域写操作在同一进程内串行执行：判剩余额度与扣减一次完成，
// 并发申领不会在判定间隙同时通过而突破许可总量。
function createMutex() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}

export function createApp({ ledger = createLedger() } = {}) {
  const withLock = createMutex();

  async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function send(response, status, body) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  // 写操作统一加锁；领域错误为 400，额度不足为 409。
  function mutate(response, fn) {
    withLock(() => {
      try {
        const result = fn();
        try {
          assertConservation(ledger);
        } catch (e) {
          send(response, 500, { error: `台账守恒校验失败: ${e.message}` });
          return;
        }
        send(response, 200, result);
      } catch (e) {
        const status = e?.code === "QUOTA_EXCEEDED" ? 409 : 400;
        send(response, status, { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.remaining_kg !== undefined ? { remaining_kg: e.remaining_kg } : {}) });
      }
    }).catch((e) => send(response, 500, { error: e.message }));
  }

  function routes() {
    return [
      ["POST", /^\/admin\/forestlands$/, (b) => publishForestland(ledger, b)],
      [
        "POST",
        /^\/admin\/forestlands\/([^/]+)\/revisions$/,
        (b, m) => reviseForestlandRules(ledger, m[1], b.rules, b.note ?? ""),
      ],
      ["GET", /^\/admin\/forestlands\/([^/]+)$/, (b, m) => publicForestland(requireForestland(ledger, m[1]))],
      ["POST", /^\/admin\/permits$/, (b) => issuePermit(ledger, b)],
      ["GET", /^\/admin\/permits\/([^/]+)$/, (b, m) => publicPermit(requirePermit(ledger, m[1]))],
      ["POST", /^\/admin\/permits\/([^/]+)\/close$/, (b, m) => closePermit(ledger, m[1])],
      ["POST", /^\/api\/permits\/([^/]+)\/quota-requests$/, (b, m) =>
        requestQuota(ledger, { ...b, permit_id: m[1] })],
      ["POST", /^\/api\/harvest-records$/, (b) => submitHarvestRecord(ledger, b)],
      ["POST", /^\/api\/recovery-checks$/, (b) => completeRecoveryCheck(ledger, b)],
      ["POST", /^\/api\/handoffs$/, (b) => handoff(ledger, b)],
      ["POST", /^\/workshop\/crafts$/, (b) => registerCraft(ledger, b)],
      ["POST", /^\/workshop\/batches$/, (b) => allocateMaterials(ledger, b)],
      ["POST", /^\/workshop\/batches\/([^/]+)\/recycle$/, (b, m) =>
        recycleScrap(ledger, { ...b, batch_id: m[1] })],
      ["POST", /^\/workshop\/returns$/, (b) => returnMaterials(ledger, b)],
      ["GET", /^\/verify\/([^/]+)$/, (b, m) => publicVerification(ledger, m[1])],
      ["GET", /^\/admin\/crafts\/([^/]+)\/trace$/, (b, m) => ({
        craft_id: m[1],
        verification: publicVerification(ledger, m[1]),
        records: traceRecords(ledger, m[1]),
      })],
      ["GET", /^\/admin\/records\/([^/]+)\/trace$/, (b, m) => ({
        record_id: m[1],
        record: publicRecord(getRecordSafe(ledger, m[1])),
        crafts: traceRecordToCrafts(ledger, m[1]),
      })],
      ["GET", /^\/admin\/reconciliation$/, (b, m, query) =>
        reconciliationReport(ledger, {
          forestland_id: query.get("forestland_id") || undefined,
          month: query.get("month") || undefined,
        })],
      ["GET", /^\/admin\/audit-fingerprint$/, () => ({
        fingerprint: fingerprintOf(ledger.auditLog),
        entries: ledger.auditLog.length,
      })],
    ];
  }

  function requireForestland(l, id) {
    const fl = l.forestlands.get(id);
    if (!fl) throw new Error(`林地 ${id} 不存在`);
    return fl;
  }
  function requirePermit(l, id) {
    const p = l.permits.get(id);
    if (!p) throw new Error(`许可 ${id} 不存在`);
    return p;
  }
  function getRecordSafe(l, id) {
    const r = l.records.get(id) ?? l.quarantined.get(id);
    if (!r) throw new Error(`采材凭证 ${id} 不存在`);
    return r;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://craft-provenance.local");
    if (url.pathname === "/health") {
      send(response, 200, healthPayload());
      return;
    }
    const match = routes().find(
      ([method, re]) => method === request.method && re.test(url.pathname)
    );
    if (!match) {
      send(response, 404, { error: "未找到资源" });
      return;
    }
    const [, re, handler] = match;
    const m = re.exec(url.pathname);

    if (request.method === "GET") {
      try {
        send(response, 200, handler({}, m, url.searchParams));
      } catch (e) {
        send(response, 400, { error: e.message });
      }
      return;
    }

    let body;
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { error: "请求体不是合法 JSON" });
      return;
    }
    mutate(response, () => handler(body, m, url.searchParams));
  });

  return { server, ledger };
}

export function createServer() {
  return createApp().server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    createServer().listen(port, "0.0.0.0");
  }
}
