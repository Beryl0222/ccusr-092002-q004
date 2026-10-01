import assert from "node:assert/strict";
import test from "node:test";

import { Ledger, obfuscateLocation } from "../src/domain.js";

// ---------- 场景夹具 ----------

function setupLedger() {
  const l = new Ledger();
  const good = obfuscateLocation(47.0, 128.0, 1000);
  const far = obfuscateLocation(47.1, 128.1, 1000);
  assert.notEqual(good.grid, far.grid);
  l.publishForest({
    forest_id: "F1",
    name: "北沟样地",
    grid_size_m: 1000,
    allowed_grids: [good.grid],
    effective_from: "2026-01-01",
    season_start: "05-01",
    season_end: "10-31",
    min_tree_age_years: 30,
    per_tree_quota_g: 2000,
    recovery_required: true,
    recovery_due_days: 30,
  });
  l.registerTeam({
    team_id: "T1",
    name: "第一采集队",
    permit_id: "PMT-1",
    permit_valid_from: "2026-01-01",
    permit_valid_to: "2026-12-31",
  });
  l.issueLicense({
    license_id: "LIC-1",
    forest_id: "F1",
    rule_version: 1,
    season_start: "2026-05-01",
    season_end: "2026-10-31",
    total_quota_g: 5000,
  });
  const claim = l.claimQuota({
    license_id: "LIC-1",
    team_id: "T1",
    permit_id: "PMT-1",
    requested_g: 3000,
    request_id: "REQ-1",
  });
  return { l, goodGrid: good.grid, farGrid: far.grid, claimId: claim.claim_id };
}

function harvestRec(over = {}) {
  return {
    record_id: "HV-1",
    harvested_on: "2026-09-01",
    tree_age_years: 45,
    weight_g: 500,
    tree_handling: "局部剥取后涂保护剂",
    ...over,
  };
}

function syncOne(l, claimId, rec, permitId = "PMT-1") {
  return l.syncHarvestBatch({
    batch_id: `B-${rec.record_id}`,
    claim_id: claimId,
    permit_id: permitId,
    records: [rec],
  });
}

// ---------- 定位模糊化 ----------

test("精确坐标量化为模糊网格，附近点同格且服务拿不到精确点", () => {
  const a = obfuscateLocation(47.0001, 128.0001, 1000);
  const b = obfuscateLocation(47.0002, 128.0002, 1000);
  assert.equal(a.grid, b.grid);
  const { l, claimId } = setupLedger();
  const summary = syncOne(l, claimId, harvestRec({ lat: 47.0, lon: 128.0 }));
  assert.deepEqual(summary.rejected, []);
  const rec = l.harvests.get("HV-1");
  assert.ok(rec.grid.startsWith("G1000m-"));
  assert.equal("lat" in rec, false);
  assert.equal("lon" in rec, false);
});

// ---------- 合规判定与隔离 ----------

test("越界网格的采材被隔离", () => {
  const { l, farGrid, claimId } = setupLedger();
  const s = syncOne(l, claimId, harvestRec({ grid: farGrid }));
  assert.equal(s.accepted.length, 0);
  assert.match(s.rejected[0].reasons.join(";"), /越出许可林地/);
  assert.equal(l.harvests.get("HV-1").status, "quarantined");
  assert.equal(l.quarantined.length, 1);
});

test("证照过期或未生效的采材被隔离", () => {
  const { l, goodGrid } = setupLedger();
  l.registerTeam({
    team_id: "T2",
    permit_id: "PMT-OLD",
    permit_valid_from: "2025-01-01",
    permit_valid_to: "2025-12-31",
  });
  const claim = l.claimQuota({
    license_id: "LIC-1",
    team_id: "T2",
    permit_id: "PMT-OLD",
    requested_g: 500,
    request_id: "REQ-OLD",
  });
  const s = syncOne(l, claim.claim_id, harvestRec({ grid: goodGrid }), "PMT-OLD");
  assert.match(s.rejected[0].reasons.join(";"), /已过期或未生效/);
});

test("树龄不足与单株超限分别给出原因", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const s = syncOne(
    l,
    claimId,
    harvestRec({ grid: goodGrid, tree_age_years: 10, weight_g: 5000 }),
  );
  const why = s.rejected[0].reasons.join(";");
  assert.match(why, /低于当日规则要求 30/);
  assert.match(why, /单株取材 5000g 超过当日单株上限 2000g/);
});

test("季节窗口外采材被隔离", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const s = syncOne(l, claimId, harvestRec({ grid: goodGrid, harvested_on: "2026-03-01" }));
  assert.match(s.rejected[0].reasons.join(";"), /季节窗口/);
});

test("隔离材料禁止交接和投产", () => {
  const { l, farGrid, claimId } = setupLedger();
  syncOne(l, claimId, harvestRec({ grid: farGrid }));
  assert.throws(() => l.handover({ handover_id: "H1", record_ids: ["HV-1"], to_workshop_id: "WS1" }),
    /禁止交接/);
  assert.throws(
    () => l.allocateToWork({ work_id: "W1", makers: [{ id: "a", share: 1 }], items: [{ record_id: "HV-1", amount_g: 100 }] }),
    /禁止投产/,
  );
});

// ---------- 配额并发与幂等 ----------

test("并发申领总量绝不被突破", () => {
  const { l } = setupLedger(); // LIC-1 总额 5000，已先申领 3000
  let ok = 0;
  let fail = 0;
  // 模拟事件循环中交错到达的申领：每个 claim 同步完成"检查-扣减"
  for (let i = 0; i < 10; i++) {
    try {
      l.claimQuota({
        license_id: "LIC-1",
        team_id: "T1",
        permit_id: "PMT-1",
        requested_g: 300,
        request_id: `R-${i}`,
      });
      ok++;
    } catch (e) {
      assert.equal(e.code, "quota_exceeded");
      fail++;
    }
  }
  assert.equal(ok, 6); // 2000 剩余 / 300 = 6
  assert.equal(fail, 4);
  assert.equal(l.licenses.get("LIC-1").allocated_quota_g, 4800);
});

test("申领幂等：同一 request_id 重放不重复扣减", () => {
  const { l } = setupLedger();
  const a = l.claimQuota({
    license_id: "LIC-1",
    team_id: "T1",
    permit_id: "PMT-1",
    requested_g: 200,
    request_id: "DUP",
  });
  const b = l.claimQuota({
    license_id: "LIC-1",
    team_id: "T1",
    permit_id: "PMT-1",
    requested_g: 200,
    request_id: "DUP",
  });
  assert.equal(a.claim_id, b.claim_id);
  assert.equal(l.licenses.get("LIC-1").allocated_quota_g, 3200);
});

// ---------- 弱网同步 ----------

test("批次幂等与乱序送达不重复计账", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const batch = {
    batch_id: "BATCH-1",
    claim_id: claimId,
    permit_id: "PMT-1",
    records: [
      harvestRec({ record_id: "HV-A", grid: goodGrid, weight_g: 100 }),
      harvestRec({ record_id: "HV-B", grid: goodGrid, weight_g: 200 }),
    ],
  };
  const s1 = l.syncHarvestBatch(batch);
  assert.equal(s1.accepted_weight_g, 300);
  // 重放（即使记录乱序）原样返回首次结果，但台账不发生任何第二次变动
  const s2 = l.syncHarvestBatch({ ...batch, records: [...batch.records].reverse() });
  assert.deepEqual(s2, s1);
  assert.equal(l.claims.get(claimId).used_g, 300);

  // 已同步的记录混进新批次：只去重回显，不重复计重量
  const s3 = l.syncHarvestBatch({
    batch_id: "BATCH-2",
    claim_id: claimId,
    permit_id: "PMT-1",
    records: [harvestRec({ record_id: "HV-A", grid: goodGrid, weight_g: 100 })],
  });
  assert.deepEqual(s3.accepted, ["HV-A"]);
  assert.equal(s3.accepted_weight_g, 0);
  assert.equal(l.claims.get(claimId).used_g, 300);
});

// ---------- 恢复观察 ----------

test("恢复检查未完成的材料必须隔离，不得交接投产", () => {
  const { l, goodGrid, claimId } = setupLedger();
  syncOne(l, claimId, harvestRec({ grid: goodGrid }));
  assert.throws(
    () => l.handover({ handover_id: "H1", record_ids: ["HV-1"], to_workshop_id: "WS1" }),
    /恢复检查尚未完成/,
  );
  const task = l.recoveryTasks.get("REC-HV-1");
  assert.equal(task.status, "pending");
  l.recordRecoveryCheck({ task_id: task.task_id, checked_on: "2026-10-01", observer: "护林员赵某", healthy: true });
  assert.equal(task.status, "completed");
  const doc = l.handover({ handover_id: "H1", record_ids: ["HV-1"], to_workshop_id: "WS1" });
  assert.equal(doc.total_g, 500);
});

test("交接凭证不可重复占用", () => {
  const { l, goodGrid, claimId } = setupLedger();
  syncOne(l, claimId, harvestRec({ grid: goodGrid }));
  l.recordRecoveryCheck({ task_id: "REC-HV-1", checked_on: "2026-10-01", healthy: true });
  l.handover({ handover_id: "H1", record_ids: ["HV-1"], to_workshop_id: "WS1" });
  assert.throws(
    () => l.handover({ handover_id: "H2", record_ids: ["HV-1"], to_workshop_id: "WS2" }),
    /已交接，禁止重复占用/,
  );
});

test("恢复观察不合格，已入库材料追转入隔离", () => {
  const { l, goodGrid, claimId } = setupLedger();
  syncOne(l, claimId, harvestRec({ grid: goodGrid }));
  l.recordRecoveryCheck({
    task_id: "REC-HV-1",
    checked_on: "2026-10-01",
    healthy: false,
    finding: "剥口流脂异常",
  });
  assert.equal(l.harvests.get("HV-1").status, "quarantined");
  assert.equal(l.quarantined.some((q) => q.via === "recovery_failed"), true);
});

// ---------- 工坊用料守恒 ----------

function readyMaterial(l, claimId, grid, over = {}) {
  const rec = harvestRec({ grid, ...over });
  syncOne(l, claimId, rec);
  l.recordRecoveryCheck({ task_id: `REC-${rec.record_id}`, checked_on: "2026-10-01", healthy: true });
  return rec.record_id;
}

test("投料-边角料-净入作守恒，溯源不重复计算", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-1", weight_g: 1000 });
  const id2 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-2", weight_g: 500 });
  l.allocateToWork({
    work_id: "BRK-1",
    makers: [{ id: "artisan-07", share: 0.6 }, { id: "artisan-12", share: 0.4 }],
    items: [
      { record_id: id1, amount_g: 1000, scrap_g: 200 },
      { record_id: id2, amount_g: 500, scrap_g: 0 },
    ],
  });
  const trace = l.traceWork("BRK-1");
  assert.equal(trace.unique_record_count, 2);
  assert.equal(trace.traced_mass_g, 1300);
  assert.equal(trace.conservation_holds, true);
  assert.equal(l.workView("BRK-1").scrap_g, 200);
});

test("边角料跨作品再利用守恒且凭证去重", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-1", weight_g: 1000 });
  l.allocateToWork({
    work_id: "BRK-1",
    makers: [{ id: "a", share: 1 }],
    items: [{ record_id: id1, amount_g: 1000, scrap_g: 200 }],
  });
  // 第二件作品先用整料 HV-2
  const id2 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-2", weight_g: 400 });
  l.allocateToWork({
    work_id: "BRK-2",
    makers: [{ id: "b", share: 1 }],
    items: [{ record_id: id2, amount_g: 400, scrap_g: 0 }],
  });
  // 再把 BRK-1 的边角料 150g 投入 BRK-2
  l.reuseScrap({ scrap_id: "SCR-BRK-1-HV-1", into_work_id: "BRK-2", amount_g: 150 });
  const t2 = l.traceWork("BRK-2");
  assert.equal(t2.unique_record_count, 2);
  const fromHv1 = t2.records.find((r) => r.record_id === "HV-1");
  assert.equal(fromHv1.incorporated_g, 150);
  assert.equal(fromHv1.from_scrap_g, 150);
  assert.equal(t2.traced_mass_g, 550);
  assert.equal(t2.conservation_holds, true);
  // BRK-1 净用料不受边角料再利用影响
  assert.equal(l.traceWork("BRK-1").traced_mass_g, 800);
});

test("退料核减净用料，退回的整料可再次分配", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-1", weight_g: 1000 });
  l.allocateToWork({
    work_id: "BRK-1",
    makers: [{ id: "a", share: 1 }],
    items: [{ record_id: id1, amount_g: 1000, scrap_g: 100 }],
  });
  // 可退 = 1000 - 100(边角料) = 900
  l.returnMaterial({ work_id: "BRK-1", record_id: "HV-1", amount_g: 300, reason: "裁切计划调整" });
  const t = l.traceWork("BRK-1");
  assert.equal(t.traced_mass_g, 600);
  assert.equal(t.conservation_holds, true);
  assert.throws(
    () => l.returnMaterial({ work_id: "BRK-1", record_id: "HV-1", amount_g: 700 }),
    /可退重量不足/,
  );
  // 退料投入新作品
  l.allocateToWork({
    work_id: "BRK-3",
    makers: [{ id: "c", share: 1 }],
    items: [{ record_id: "HV-1", amount_g: 300, scrap_g: 0 }],
  });
  assert.equal(l.traceWork("BRK-3").traced_mass_g, 300);
});

test("多人合制份额之和必须为 1", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { weight_g: 100 });
  assert.throws(
    () => l.allocateToWork({
      work_id: "W-BAD",
      makers: [{ id: "a", share: 0.5 }, { id: "b", share: 0.4 }],
      items: [{ record_id: id1, amount_g: 100 }],
    }),
    /份额之和必须为 1/,
  );
});

test("同一凭证超余额重复分配被拒绝", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { weight_g: 500 });
  l.allocateToWork({
    work_id: "W1",
    makers: [{ id: "a", share: 1 }],
    items: [{ record_id: id1, amount_g: 400, scrap_g: 0 }],
  });
  assert.throws(
    () => l.allocateToWork({
      work_id: "W2",
      makers: [{ id: "b", share: 1 }],
      items: [{ record_id: id1, amount_g: 200, scrap_g: 0 }],
    }),
    /可投余额不足/,
  );
});

// ---------- 规则版本时效 ----------

test("规则修订只约束后续采集，历史材料按当时版本审计", () => {
  const { l, goodGrid, claimId } = setupLedger();
  // v1 下 9 月采材合规
  syncOne(l, claimId, harvestRec({ record_id: "HV-OLD", grid: goodGrid, harvested_on: "2026-09-15", tree_age_years: 35 }));
  assert.equal(l.harvests.get("HV-OLD").rule_version_when_harvested, 1);
  // 10 月修订：季节窗口缩到 11 月，树龄门槛提到 60 年（自动形成 v2）
  l.reviseRule({
    forest_id: "F1",
    effective_from: "2026-10-01",
    season_start: "11-01",
    season_end: "11-30",
    min_tree_age_years: 60,
    per_tree_quota_g: 1000,
    recovery_required: true,
    recovery_due_days: 30,
  });
  // 修订后再在 10 月采：违反新季节窗口 → 隔离
  const s = syncOne(l, claimId, harvestRec({
    record_id: "HV-NEW", grid: goodGrid, harvested_on: "2026-10-15", tree_age_years: 70,
  }));
  assert.equal(l.harvests.get("HV-NEW").rule_version_when_harvested, 2);
  assert.match(s.rejected[0].reasons.join(";"), /v2.*季节窗口/);
  // 历史材料依旧合规、可投产（恢复完成后）
  l.recordRecoveryCheck({ task_id: "REC-HV-OLD", checked_on: "2026-10-20", healthy: true });
  l.allocateToWork({
    work_id: "W-OLD",
    makers: [{ id: "a", share: 1 }],
    items: [{ record_id: "HV-OLD", amount_g: 500, scrap_g: 0 }],
  });
  assert.equal(l.traceWork("W-OLD").records[0].rule_version, 1);
});

// ---------- 月报与公开验真 ----------

test("林地月报数字守恒", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-1", weight_g: 1000 });
  l.allocateToWork({
    work_id: "BRK-1",
    makers: [{ id: "a", share: 1 }],
    items: [{ record_id: id1, amount_g: 1000, scrap_g: 200 }],
  });
  l.returnMaterial({ work_id: "BRK-1", record_id: "HV-1", amount_g: 100 });
  const rep = l.monthlyReport("F1", "2026-09");
  assert.equal(rep.harvest.compliant_weight_g, 1000);
  // 净入作 = 1000 - 200(边角料余量) - 100(退料) = 700
  assert.equal(rep.consumption.incorporated_g, 700);
  assert.equal(rep.consumption.scrap_open_g, 200);
  assert.equal(rep.consumption.returned_g, 100);
  assert.equal(rep.conservation, true);
  assert.equal(rep.recovery_tasks.length, 1);
  assert.equal(rep.quota[0].remaining_g, 2000);
});

test("公开验真只显示来源结论，不泄露敏感林点", () => {
  const { l, goodGrid, claimId } = setupLedger();
  const id1 = readyMaterial(l, claimId, goodGrid, { record_id: "HV-1", weight_g: 800 });
  l.allocateToWork({
    work_id: "BRK-2026-118",
    makers: [{ id: "artisan-07", share: 1 }],
    items: [{ record_id: id1, amount_g: 800, scrap_g: 100 }],
  });
  const pub = l.publicVerification("BRK-2026-118");
  assert.equal(pub.verdict, "来源合规");
  assert.equal(pub.recovery_completed, true);
  const dumped = JSON.stringify(pub);
  for (const secret of [goodGrid, "F1", "PMT-1", "LIC-1", "CLM-", "grid", "permit"]) {
    assert.equal(dumped.includes(secret), false, `公开视图泄露了 ${secret}`);
  }
});
