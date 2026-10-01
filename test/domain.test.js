import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateMaterials,
  assertConservation,
  completeRecoveryCheck,
  createLedger,
  handoff,
  issuePermit,
  publicVerification,
  publishForestland,
  recycleScrap,
  registerCraft,
  requestQuota,
  returnMaterials,
  reviseForestlandRules,
  submitHarvestRecord,
  traceRecordToCrafts,
  traceRecords,
  reconciliationReport,
} from "../src/domain.js";

const RULES = {
  season: { start: "05-01", end: "09-30" },
  min_tree_age_years: 15,
  per_tree_limit_kg: 3,
  recovery: { observe_days: 30, required_checks: ["cambium_intact", "photo_followup"] },
};

const BOUNDARY = [
  [126.10, 49.10],
  [126.10, 49.30],
  [126.40, 49.30],
  [126.40, 49.10],
];

function seedLedger() {
  const ledger = createLedger();
  publishForestland(ledger, {
    forestland_id: "FL-A",
    name: "北沟桦树林",
    region: "兴安-北沟",
    boundary: BOUNDARY,
    rules: RULES,
  });
  issuePermit(ledger, {
    permit_id: "P-1",
    forestland_id: "FL-A",
    team_id: "team-1",
    total_quota_kg: 50,
    valid_from: "2026-05-01",
    valid_to: "2026-09-30",
    required_credentials: ["forest_pass"],
  });
  registerCraft(ledger, {
    craft_id: "BRK-2026-118",
    makers: [{ id: "artisan-07", share: 1 }],
  });
  return ledger;
}

function harvest(ledger, overrides = {}) {
  return submitHarvestRecord(ledger, {
    record_id: "R-1",
    permit_id: "P-1",
    team_id: "team-1",
    collected_on: "2026-06-10",
    location: { lat: 49.20, lon: 126.25 },
    tree_id: "T-1",
    tree_age_years: 20,
    weight_kg: 2,
    treatment: "bark_harvest",
    credentials: [{ type: "forest_pass", number: "FP-9", expires_on: "2026-12-31" }],
    ...overrides,
  });
}

function release(ledger, recordId = "R-1", asOf = "2026-07-15") {
  completeRecoveryCheck(ledger, { record_id: recordId, check_name: "cambium_intact", done_on: asOf });
  return completeRecoveryCheck(ledger, { record_id: recordId, check_name: "photo_followup", done_on: asOf });
}

test("新采材先进隔离，恢复观察完成且观察期届满后放行", () => {
  const ledger = seedLedger();
  const r = harvest(ledger);
  assert.equal(r.status, "quarantined");
  assert.ok(r.violations.some((v) => v.code === "RECOVERY_PENDING"));

  // 观察期未满：仍隔离
  completeRecoveryCheck(ledger, { record_id: "R-1", check_name: "cambium_intact", done_on: "2026-06-20" });
  completeRecoveryCheck(ledger, { record_id: "R-1", check_name: "photo_followup", done_on: "2026-06-20" });
  assert.equal(ledger.quarantined.has("R-1"), true);

  const out = release(ledger);
  assert.equal(out.status, "released");
  assert.equal(ledger.records.has("R-1"), true);
  assertConservation(ledger);
});

test("越界采材保持隔离，不得交接或入工坊", () => {
  const ledger = seedLedger();
  const r = harvest(ledger, { location: { lat: 48.00, lon: 125.00 } });
  assert.ok(r.violations.some((v) => v.code === "OUT_OF_BOUNDARY"));
  release(ledger);
  // 恢复完成但越界仍在 -> rejected，且不在合格库
  assert.equal(ledger.records.has("R-1"), false);
  assert.throws(
    () => handoff(ledger, { handoff_id: "H-1", permit_id: "P-1", to_workshop: "ws-1", record_ids: ["R-1"] }),
    /未通过隔离/
  );
});

test("证照过期、季节窗口外、树龄不足、单株超限分别被标记", () => {
  const ledger = seedLedger();
  const r = harvest(ledger, {
    record_id: "R-X",
    collected_on: "2026-04-15",
    tree_age_years: 10,
    weight_kg: 9,
    credentials: [{ type: "forest_pass", number: "FP-1", expires_on: "2026-01-01" }],
  });
  const codes = r.violations.map((v) => v.code);
  assert.ok(codes.includes("OUT_OF_SEASON"));
  assert.ok(codes.includes("TREE_TOO_YOUNG"));
  assert.ok(codes.includes("PER_TREE_LIMIT"));
  assert.ok(codes.includes("CREDENTIAL_EXPIRED"));

  // 许可有效期外
  const r2 = harvest(ledger, {
    record_id: "R-Y",
    tree_id: "T-2",
    collected_on: "2026-10-15",
  });
  assert.ok(r2.violations.some((v) => v.code === "PERMIT_EXPIRED"));
});

test("同一棵树不能被两个许可重复占用", () => {
  const ledger = seedLedger();
  issuePermit(ledger, {
    permit_id: "P-2",
    forestland_id: "FL-A",
    team_id: "team-2",
    total_quota_kg: 50,
    valid_from: "2026-05-01",
    valid_to: "2026-09-30",
  });
  harvest(ledger, { record_id: "R-1" });
  const r2 = submitHarvestRecord(ledger, {
    record_id: "R-2",
    permit_id: "P-2",
    team_id: "team-2",
    collected_on: "2026-06-11",
    location: { lat: 49.20, lon: 126.25 },
    tree_id: "T-1",
    tree_age_years: 20,
    weight_kg: 1,
    treatment: "bark_harvest",
  });
  assert.ok(r2.violations.some((v) => v.code === "TREE_ALREADY_CLAIMED"));
});

test("规则修订只约束后续采集，旧凭证按当时规则接受审计", () => {
  const ledger = seedLedger();
  harvest(ledger, { tree_age_years: 16, weight_kg: 2 });
  release(ledger);

  // 修订：树龄门槛提高到 30，单株上限降到 1.5
  reviseForestlandRules(ledger, "FL-A", {
    ...RULES,
    min_tree_age_years: 30,
    per_tree_limit_kg: 1.5,
  });
  // 新发许可锁定新版本
  issuePermit(ledger, {
    permit_id: "P-3",
    forestland_id: "FL-A",
    team_id: "team-1",
    total_quota_kg: 10,
    valid_from: "2027-05-01",
    valid_to: "2027-09-30",
  });
  const rNew = submitHarvestRecord(ledger, {
    record_id: "R-3",
    permit_id: "P-3",
    team_id: "team-1",
    collected_on: "2027-06-01",
    location: { lat: 49.2, lon: 126.25 },
    tree_id: "T-3",
    tree_age_years: 16,
    weight_kg: 2,
    treatment: "bark_harvest",
  });
  assert.equal(rNew.rule_version, 2);
  const codes = rNew.violations.map((v) => v.code);
  assert.ok(codes.includes("TREE_TOO_YOUNG"));
  assert.ok(codes.includes("PER_TREE_LIMIT"));

  // 旧凭证仍按 v1 合格
  const old = ledger.records.get("R-1");
  assert.equal(old.rule_version, 1);
  assert.equal(old.status, "released");
});

test("弱网重传：同一 record_id 与同一申领单幂等", () => {
  const ledger = seedLedger();
  const a = harvest(ledger);
  const b = harvest(ledger);
  assert.equal(b.idempotent, true);
  assert.equal(ledger.quarantined.size + ledger.records.size, 1);

  const q1 = requestQuota(ledger, { permit_id: "P-1", request_id: "Q-1", amount_kg: 10 });
  const q2 = requestQuota(ledger, { permit_id: "P-1", request_id: "Q-1", amount_kg: 10 });
  assert.equal(q2.idempotent, true);
  assert.equal(q1.allocated_quota_kg, 10);
});

test("额度串行扣减：并发申领合计不得突破总量", async () => {
  const ledger = seedLedger();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          return requestQuota(ledger, { permit_id: "P-1", request_id: `Q-${i}`, amount_kg: 5 });
        } catch (e) {
          return { error: e.code };
        }
      })
    )
  );
  const granted = results.filter((r) => r.granted_amount_kg).length;
  const denied = results.filter((r) => r.error === "QUOTA_EXCEEDED").length;
  assert.equal(granted, 10); // 50 / 5
  assert.equal(denied, 10);
  const permit = ledger.permits.get("P-1");
  assert.equal(permit.allocated_quota_kg, 50);
});

test("工坊物料守恒：领料 = 成品占用 + 边角料；退料恢复可用量", () => {
  const ledger = seedLedger();
  harvest(ledger, { weight_kg: 3 });
  release(ledger);

  assert.throws(
    () =>
      allocateMaterials(ledger, {
        batch_id: "B-1",
        workshop_id: "ws-1",
        craft_id: "BRK-2026-118",
        lines: [{ record_id: "R-1", kg: 3 }],
        product_kg: 2,
        scrap_kg: 0.5,
      }),
    /物料不守恒/
  );

  allocateMaterials(ledger, {
    batch_id: "B-1",
    workshop_id: "ws-1",
    craft_id: "BRK-2026-118",
    lines: [{ record_id: "R-1", kg: 3 }],
    product_kg: 2.4,
    scrap_kg: 0.6,
  });
  assertConservation(ledger);

  // 超领被拒
  assert.throws(
    () =>
      allocateMaterials(ledger, {
        batch_id: "B-2",
        workshop_id: "ws-1",
        craft_id: "BRK-2026-118",
        lines: [{ record_id: "R-1", kg: 1 }],
        product_kg: 1,
        scrap_kg: 0,
      }),
    /可用量不足/
  );

  // 退料 1：凭证可用量恢复
  returnMaterials(ledger, {
    return_id: "RT-1",
    batch_id: "B-1",
    lines: [{ record_id: "R-1", kg: 1 }],
  });
  const r = ledger.records.get("R-1");
  assert.equal(r.used_kg, 2);
  assert.equal(r.returned_kg, 1);
  assertConservation(ledger);

  // 边角料回收不超过本批边角料
  assert.throws(
    () => recycleScrap(ledger, { batch_id: "B-1", recycled_kg: 2 }),
    /超过该批次边角料/
  );
  recycleScrap(ledger, { batch_id: "B-1", recycled_kg: 0.5 });
});

test("多人合制份额之和为 1，多批次不重复计算凭证", () => {
  const ledger = seedLedger();
  harvest(ledger, { weight_kg: 3 });
  release(ledger);
  registerCraft(ledger, {
    craft_id: "BRK-2026-200",
    makers: [
      { id: "artisan-07", share: 0.6 },
      { id: "artisan-08", share: 0.4 },
    ],
  });
  allocateMaterials(ledger, {
    batch_id: "B-1",
    workshop_id: "ws-1",
    craft_id: "BRK-2026-200",
    lines: [{ record_id: "R-1", kg: 2 }],
    product_kg: 2,
    scrap_kg: 0,
  });
  allocateMaterials(ledger, {
    batch_id: "B-2",
    workshop_id: "ws-1",
    craft_id: "BRK-2026-200",
    lines: [{ record_id: "R-1", kg: 1 }],
    product_kg: 1,
    scrap_kg: 0,
  });
  const traced = traceRecords(ledger, "BRK-2026-200");
  assert.equal(traced.length, 1); // 去重
  assert.equal(traced[0].consumed_kg, 3); // 净用量合计
  assertConservation(ledger);
});

test("公开验真只给结论，不泄露林点、树号、许可与队伍", () => {
  const ledger = seedLedger();
  harvest(ledger, { weight_kg: 3 });
  release(ledger);
  handoff(ledger, { handoff_id: "H-1", permit_id: "P-1", to_workshop: "ws-1", record_ids: ["R-1"] });
  allocateMaterials(ledger, {
    batch_id: "B-1",
    workshop_id: "ws-1",
    craft_id: "BRK-2026-118",
    lines: [{ record_id: "R-1", kg: 3 }],
    product_kg: 2.5,
    scrap_kg: 0.5,
  });

  const v = publicVerification(ledger, "BRK-2026-118");
  assert.equal(v.verdict, "COMPLIANT");
  const json = JSON.stringify(v);
  for (const secret of ["T-1", "P-1", "team-1", "G2@", "49.20", "126.25"]) {
    assert.ok(!json.includes(secret), `公开验真泄露了 ${secret}`);
  }
  assert.equal(v.source_summary.distinct_records, 1);
  assert.deepEqual(v.source_summary.rule_versions, [1]);
});

test("凭证反向追溯到作品，且作品到凭证无重复计算", () => {
  const ledger = seedLedger();
  harvest(ledger, { weight_kg: 3 });
  release(ledger);
  allocateMaterials(ledger, {
    batch_id: "B-1",
    workshop_id: "ws-1",
    craft_id: "BRK-2026-118",
    lines: [{ record_id: "R-1", kg: 3 }],
    product_kg: 3,
    scrap_kg: 0,
  });
  const crafts = traceRecordToCrafts(ledger, "R-1");
  assert.equal(crafts.length, 1);
  assert.equal(crafts[0].craft_id, "BRK-2026-118");
});

test("对账：按林地与月份汇总消耗、退料、隔离与剩余额度", () => {
  const ledger = seedLedger();
  harvest(ledger, { weight_kg: 3 });
  release(ledger);
  allocateMaterials(ledger, {
    batch_id: "B-1",
    workshop_id: "ws-1",
    craft_id: "BRK-2026-118",
    lines: [{ record_id: "R-1", kg: 3 }],
    product_kg: 3,
    scrap_kg: 0,
  });
  returnMaterials(ledger, {
    return_id: "RT-1",
    batch_id: "B-1",
    lines: [{ record_id: "R-1", kg: 1 }],
  });
  requestQuota(ledger, { permit_id: "P-1", request_id: "Q-1", amount_kg: 20 });

  const report = reconciliationReport(ledger, { forestland_id: "FL-A", month: "2026-06" });
  const g = report.groups[0];
  assert.equal(g.harvested_kg, 3);
  assert.equal(g.consumed_kg, 2);
  assert.equal(g.returned_kg, 1);
  assert.equal(g.stock_kg, 0);
  const permit = report.permits.find((p) => p.permit_id === "P-1");
  assert.equal(permit.allocated_quota_kg, 20);
  assert.equal(permit.remaining_quota_kg, 30);
  assert.equal(report.open_recovery_tasks.length, 0);
});
