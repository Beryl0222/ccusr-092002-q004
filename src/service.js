import http from "node:http";
import {
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

import { Ledger } from "./domain.js";

export const serviceId = "craft-provenance";
export const serviceName = "生态采材与工坊用料服务";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

// 命令名 -> 在账本上执行的变更操作。所有写操作都经此分发，
// 因此持久化只需把命令按顺序追加到 JSONL，重启时重放即可重建全部台账。
const COMMANDS = {
  "team.register": (l, b) => l.registerTeam(b),
  "forest.publish": (l, b) => l.publishForest(b),
  "forest.revise": (l, b) => l.reviseRule(b),
  "license.issue": (l, b) => l.issueLicense(b),
  "quota.claim": (l, b) => l.claimQuota(b),
  "harvest.sync": (l, b) => l.syncHarvestBatch(b),
  "recovery.check": (l, b) => l.recordRecoveryCheck(b),
  "material.handover": (l, b) => l.handover(b),
  "work.allocate": (l, b) => l.allocateToWork(b),
  "scrap.reuse": (l, b) => l.reuseScrap(b),
  "material.return": (l, b) => l.returnMaterial(b),
};

export function applyCommand(ledger, command) {
  const handler = COMMANDS[command.op];
  if (!handler) throw Object.assign(new Error(`未知命令 ${command.op}`), { status: 400 });
  return handler(ledger, command.body ?? {});
}

export function createStore(storeFile) {
  const ledger = new Ledger();
  if (storeFile && existsSync(storeFile)) {
    const lines = readFileSync(storeFile, "utf8").split("\n").filter(Boolean);
    for (const line of lines) applyCommand(ledger, JSON.parse(line));
  }
  return {
    ledger,
    submit(command) {
      // 先执行（含全部校验）再落盘：落盘内容必然是已接受的命令。
      const result = applyCommand(ledger, command);
      if (storeFile) appendFileSync(storeFile, JSON.stringify(sanitize(ledger, command)) + "\n");
      return result;
    },
  };
}

// 落盘前脱敏：采材命令中的精确坐标替换为入库后的模糊网格，
// 命令日志本身也不得留存敏感林点。重放时网格判定结果一致。
function sanitize(ledger, command) {
  if (command.op !== "harvest.sync") return command;
  const records = command.body.records.map((rec) => {
    if (!("lat" in rec || "lon" in rec)) return rec;
    const stored = ledger.harvests.get(rec.record_id);
    const { lat, lon, ...rest } = rec;
    return { ...rest, grid: stored?.grid ?? null };
  });
  return { ...command, body: { ...command.body, records } };
}

const json = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

export function createServer(store = createStore(process.env.STORE_FILE || null)) {
  const ledger = () => store.ledger;

  return http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const { pathname } = url;

    if (pathname === "/health") {
      json(response, 200, healthPayload());
      return;
    }

    const readBody = () =>
      new Promise((resolve, reject) => {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 2_000_000) reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        });
        request.on("end", () => {
          if (!raw) return resolve({});
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }));
          }
        });
        request.on("error", reject);
      });

    const serve = (handler) => {
      try {
        handler();
      } catch (err) {
        json(response, err.status ?? 500, {
          ok: false,
          error: err.message,
          code: err.code ?? "internal_error",
        });
      }
    };

    if (request.method === "POST") {
      const postRoutes = {
        "/admin/teams": "team.register",
        "/admin/forests": "forest.publish",
        "/admin/licenses": "license.issue",
        "/claims": "quota.claim",
        "/harvests/sync": "harvest.sync",
        "/recovery/checks": "recovery.check",
        "/handovers": "material.handover",
        "/works": "work.allocate",
        "/scraps/reuse": "scrap.reuse",
        "/returns": "material.return",
      };
      const revisionMatch = /^\/admin\/forests\/([^/]+)\/revisions$/.exec(pathname);
      const op = revisionMatch ? "forest.revise" : postRoutes[pathname];
      if (!op) {
        json(response, 404, { error: "未找到资源" });
        return;
      }
      return readBody()
        .then((body) => {
          const command = revisionMatch
            ? { op, body: { ...body, forest_id: revisionMatch[1] } }
            : { op, body };
          json(response, 200, { ok: true, result: store.submit(command) });
        })
        .catch((err) =>
          json(response, err.status ?? 500, {
            ok: false,
            error: err.message,
            code: err.code ?? "internal_error",
          }),
        );
    }

    if (request.method === "GET") {
      serve(() => {
        let m;
        if (pathname === "/licenses") {
          // 管理者查看全部许可余额
          json(response, 200, {
            licenses: [...ledger().licenses.values()].map((l) => ({
              license_id: l.license_id,
              forest_id: l.forest_id,
              total_g: l.total_quota_g,
              allocated_g: l.allocated_quota_g,
              remaining_g: l.total_quota_g - l.allocated_quota_g,
            })),
          });
          return;
        }
        if ((m = /^\/works\/([^/]+)\/trace$/.exec(pathname))) {
          json(response, 200, ledger().traceWork(decodeURIComponent(m[1])));
          return;
        }
        if ((m = /^\/v\/works\/([^/]+)$/.exec(pathname))) {
          // 公开验真端点
          json(response, 200, ledger().publicVerification(decodeURIComponent(m[1])));
          return;
        }
        if ((m = /^\/reports\/forests\/([^/]+)\/months\/(\d{4}-\d{2})$/.exec(pathname))) {
          json(response, 200, ledger().monthlyReport(decodeURIComponent(m[1]), m[2]));
          return;
        }
        if ((m = /^\/quarantine$/.exec(pathname))) {
          json(response, 200, {
            quarantined: ledger().quarantined.map((r) => ({
              record_id: r.record_id,
              forest_id: r.forest_id,
              weight_g: r.weight_g,
              reasons: r.reasons,
            })),
          });
          return;
        }
        json(response, 404, { error: "未找到资源" });
      });
      return;
    }

    json(response, 404, { error: "未找到资源" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    const storeIndex = process.argv.indexOf("--store");
    const storeFile = storeIndex >= 0 ? process.argv[storeIndex + 1] : process.env.STORE_FILE || null;
    createServer(createStore(storeFile)).listen(port, "0.0.0.0");
  }
}
