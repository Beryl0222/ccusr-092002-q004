import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createServer, createStore } from "../src/service.js";

let server;
let base;
let storeFile;
let storeDir;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "craft-ledger-"));
  storeFile = join(storeDir, "ledger.jsonl");
  server = createServer(createStore(storeFile)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(storeDir, { recursive: true, force: true });
});

test("健康检查", async () => {
  const { status, json } = await call("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.service, "craft-provenance");
});

test("全链路：发布-发证-并发申领-弱网同步-恢复-交接-投产-验真", async () => {
  await call("POST", "/admin/forests", {
    forest_id: "F1",
    grid_size_m: 1000,
    allowed_grids: ["G1000m-X9717-Y5232"],
    effective_from: "2026-01-01",
    season_start: "05-01",
    season_end: "10-31",
    min_tree_age_years: 30,
    per_tree_quota_g: 2000,
    recovery_required: true,
    recovery_due_days: 30,
  });
  await call("POST", "/admin/teams", {
    team_id: "T1",
    permit_id: "PMT-1",
    permit_valid_from: "2026-01-01",
    permit_valid_to: "2026-12-31",
  });
  await call("POST", "/admin/licenses", {
    license_id: "LIC-1",
    forest_id: "F1",
    rule_version: 1,
    season_start: "2026-05-01",
    season_end: "2026-10-31",
    total_quota_g: 1000,
  });

  // 15 个并发申领，每个 100g，总量 1000g：恰好 10 个成功
  const claims = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      call("POST", "/claims", {
        license_id: "LIC-1",
        team_id: "T1",
        permit_id: "PMT-1",
        requested_g: 100,
        request_id: `REQ-${i}`,
      })),
  );
  const okCount = claims.filter((c) => c.status === 200).length;
  const failCount = claims.filter((c) => c.json.code === "quota_exceeded").length;
  assert.equal(okCount, 10);
  assert.equal(failCount, 5);
  const { json: licView } = await call("GET", "/licenses");
  assert.deepEqual(licView.licenses[0], {
    license_id: "LIC-1",
    forest_id: "F1",
    total_g: 1000,
    allocated_g: 1000,
    remaining_g: 0,
  });

  const claimId = claims.find((c) => c.status === 200).json.result.claim_id;

  // 弱网同步：一批两笔，其中一笔越界
  const sync = await call("POST", "/harvests/sync", {
    batch_id: "B1",
    claim_id: claimId,
    permit_id: "PMT-1",
    records: [
      { record_id: "HV-OK", harvested_on: "2026-09-01", lat: 47.0, lon: 128.0, tree_age_years: 40, weight_g: 100, tree_handling: "局部剥取" },
      { record_id: "HV-BAD", harvested_on: "2026-09-01", grid: "G1000m-X9999-Y9999", tree_age_years: 40, weight_g: 100 },
    ],
  });
  assert.deepEqual(sync.json.result.accepted, ["HV-OK"]);
  assert.equal(sync.json.result.rejected[0].record_id, "HV-BAD");

  // 幂等重放：原样返回首次结果，但许可下的合规采集量不翻倍
  const replay = await call("POST", "/harvests/sync", {
    batch_id: "B1",
    claim_id: claimId,
    permit_id: "PMT-1",
    records: [
      { record_id: "HV-BAD", harvested_on: "2026-09-01", grid: "G1000m-X9999-Y9999", tree_age_years: 40, weight_g: 100 },
      { record_id: "HV-OK", harvested_on: "2026-09-01", lat: 47.0, lon: 128.0, tree_age_years: 40, weight_g: 100 },
    ],
  });
  assert.equal(replay.json.result.accepted_weight_g, 100);

  // 恢复未完成不得交接
  const blocked = await call("POST", "/handovers", {
    handover_id: "H0",
    record_ids: ["HV-OK"],
    to_workshop_id: "WS1",
  });
  assert.equal(blocked.status, 400);

  await call("POST", "/recovery/checks", {
    task_id: "REC-HV-OK",
    checked_on: "2026-10-01",
    healthy: true,
    observer: "护林员",
  });
  const handover = await call("POST", "/handovers", {
    handover_id: "H1",
    record_ids: ["HV-OK"],
    to_workshop_id: "WS1",
  });
  assert.equal(handover.status, 200);

  const work = await call("POST", "/works", {
    work_id: "BRK-2026-118",
    makers: [{ id: "artisan-07", share: 0.7 }, { id: "artisan-12", share: 0.3 }],
    items: [{ record_id: "HV-OK", amount_g: 100, scrap_g: 20 }],
  });
  assert.equal(work.json.result.net_incorporated_g, 80);

  const trace = await call("GET", "/works/BRK-2026-118/trace");
  assert.equal(trace.json.unique_record_count, 1);
  assert.equal(trace.json.conservation_holds, true);

  const pub = await call("GET", "/v/works/BRK-2026-118");
  assert.equal(pub.json.verdict, "来源合规");
  assert.equal(pub.json.verdict, "来源合规");
  assert.equal(JSON.stringify(pub.json).includes("G1000m"), false);

  const q = await call("GET", "/quarantine");
  assert.equal(q.json.quarantined.some((r) => r.record_id === "HV-BAD"), true);

  const report = await call("GET", "/reports/forests/F1/months/2026-09");
  assert.equal(report.json.conservation, true);
});

test("规则修订端点只约束后续采集", async () => {
  const rev = await call("POST", "/admin/forests/F1/revisions", {
    effective_from: "2026-11-01",
    season_start: "11-01",
    season_end: "11-15",
    min_tree_age_years: 50,
    per_tree_quota_g: 800,
    recovery_required: true,
    recovery_due_days: 45,
  });
  assert.equal(rev.json.result.version, 2);
});

test("落盘命令日志重放后台账一致", async () => {
  const raw = await readFile(storeFile, "utf8");
  const ops = raw.trim().split("\n").map((l) => JSON.parse(l).op);
  assert.ok(ops.includes("harvest.sync"));
  assert.ok(ops.includes("work.allocate"));
  // 命令日志同样不得留存精确坐标，只保留模糊网格
  assert.equal(raw.includes('"lat"'), false);
  assert.equal(raw.includes('"lon"'), false);

  const rebuilt = createStore(storeFile);
  const pub = rebuilt.ledger.publicVerification("BRK-2026-118");
  assert.equal(pub.verdict, "来源合规");
  assert.equal(pub.material_mass_g, 80);
  // 隔离状态与许可余额也完整恢复
  assert.equal(rebuilt.ledger.quarantined.some((r) => r.record_id === "HV-BAD"), true);
  assert.equal(rebuilt.ledger.licenses.get("LIC-1").allocated_quota_g, 1000);
});
