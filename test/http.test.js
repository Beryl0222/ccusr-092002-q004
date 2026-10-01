import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/service.js";

const RULES = {
  season: { start: "05-01", end: "09-30" },
  min_tree_age_years: 15,
  per_tree_limit_kg: 3,
  recovery: { observe_days: 30, required_checks: ["cambium_intact"] },
};

async function withServer(fn) {
  const app = createApp();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base, app.ledger);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}

async function req(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function seed(base) {
  await req(base, "POST", "/admin/forestlands", {
    forestland_id: "FL-A",
    name: "北沟桦树林",
    region: "兴安-北沟",
    boundary: [
      [126.1, 49.1],
      [126.1, 49.3],
      [126.4, 49.3],
      [126.4, 49.1],
    ],
    rules: RULES,
  });
  await req(base, "POST", "/admin/permits", {
    permit_id: "P-1",
    forestland_id: "FL-A",
    team_id: "team-1",
    total_quota_kg: 50,
    valid_from: "2026-05-01",
    valid_to: "2026-09-30",
    required_credentials: ["forest_pass"],
  });
  await req(base, "POST", "/workshop/crafts", {
    craft_id: "BRK-2026-118",
    makers: [{ id: "artisan-07", share: 1 }],
  });
}

test("健康检查保持项目标识", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "GET", "/health");
    assert.equal(status, 200);
    assert.equal(json.service, "craft-provenance");
  });
});

test("同一许可并发申领绝不突破总量（真实 HTTP 竞态）", async () => {
  await withServer(async (base) => {
    await seed(base);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        req(base, "POST", "/api/permits/P-1/quota-requests", {
          request_id: `Q-${i}`,
          amount_kg: 4,
        })
      )
    );
    const granted = results.filter((r) => r.status === 200).length;
    const denied = results.filter((r) => r.status === 409 && r.json.code === "QUOTA_EXCEEDED").length;
    assert.equal(granted, 12); // floor(50/4)
    assert.equal(denied, 13);
    const { json } = await req(base, "GET", "/admin/permits/P-1");
    assert.equal(json.allocated_quota_kg, 48);
    assert.equal(json.remaining_quota_kg, 2);
  });
});

test("越界或恢复未完成的材料在交接与工坊环节被拦截，全流程合规路径可验真", async () => {
  await withServer(async (base) => {
    await seed(base);

    // 合规采材
    const good = await req(base, "POST", "/api/harvest-records", {
      record_id: "R-GOOD",
      permit_id: "P-1",
      team_id: "team-1",
      collected_on: "2026-06-10",
      location: { lat: 49.2, lon: 126.25 },
      tree_id: "T-1",
      tree_age_years: 20,
      weight_kg: 2,
      treatment: "bark_harvest",
      credentials: [{ type: "forest_pass", number: "FP-9", expires_on: "2026-12-31" }],
    });
    assert.equal(good.json.status, "quarantined");

    // 观察期未完成时交接被拒
    const early = await req(base, "POST", "/api/handoffs", {
      handoff_id: "H-EARLY",
      permit_id: "P-1",
      to_workshop: "ws-1",
      record_ids: ["R-GOOD"],
    });
    assert.equal(early.status, 400);

    // 完成恢复检查（观察期 30 天后）
    await req(base, "POST", "/api/recovery-checks", {
      record_id: "R-GOOD",
      check_name: "cambium_intact",
      done_on: "2026-07-15",
    });

    // 越界采材，恢复后仍被拒
    await req(base, "POST", "/api/harvest-records", {
      record_id: "R-BAD",
      permit_id: "P-1",
      team_id: "team-1",
      collected_on: "2026-06-10",
      location: { lat: 48.0, lon: 125.0 },
      tree_id: "T-2",
      tree_age_years: 20,
      weight_kg: 2,
      treatment: "bark_harvest",
      credentials: [{ type: "forest_pass", number: "FP-9", expires_on: "2026-12-31" }],
    });
    await req(base, "POST", "/api/recovery-checks", {
      record_id: "R-BAD",
      check_name: "cambium_intact",
      done_on: "2026-07-15",
    });

    const handoffBad = await req(base, "POST", "/api/handoffs", {
      handoff_id: "H-BAD",
      permit_id: "P-1",
      to_workshop: "ws-1",
      record_ids: ["R-BAD"],
    });
    assert.equal(handoffBad.status, 400);

    // 合格凭证交接并入工坊（守恒：2 = 1.6 成品 + 0.4 边角料）
    const h = await req(base, "POST", "/api/handoffs", {
      handoff_id: "H-1",
      permit_id: "P-1",
      to_workshop: "ws-1",
      record_ids: ["R-GOOD"],
    });
    assert.equal(h.status, 200);

    const batch = await req(base, "POST", "/workshop/batches", {
      batch_id: "B-1",
      workshop_id: "ws-1",
      craft_id: "BRK-2026-118",
      lines: [{ record_id: "R-GOOD", kg: 2 }],
      product_kg: 1.6,
      scrap_kg: 0.4,
    });
    assert.equal(batch.status, 200);

    // 不守恒批次被拒
    const badBatch = await req(base, "POST", "/workshop/batches", {
      batch_id: "B-X",
      workshop_id: "ws-1",
      craft_id: "BRK-2026-118",
      lines: [{ record_id: "R-GOOD", kg: 1 }],
      product_kg: 0.5,
      scrap_kg: 0.1,
    });
    assert.equal(badBatch.status, 400);

    const verify = await req(base, "GET", "/verify/BRK-2026-118");
    assert.equal(verify.status, 200);
    assert.equal(verify.json.verdict, "COMPLIANT");
    const leaked = JSON.stringify(verify.json).match(/T-1|P-1|team-1|G2@|49\.2|126\.25/);
    assert.equal(leaked, null);

    // 审计追溯：作品 -> 去重凭证
    const trace = await req(base, "GET", "/admin/crafts/BRK-2026-118/trace");
    assert.equal(trace.json.records.length, 1);
    assert.equal(trace.json.records[0].consumed_kg, 2);

    // 对账中越界材料仍计入隔离
    const recon = await req(base, "GET", "/admin/reconciliation?forestland_id=FL-A&month=2026-06");
    assert.equal(recon.status, 200);
    assert.ok(recon.json.groups[0].quarantined_kg > 0);
  });
});

test("规则修订后旧许可仍按旧规则判定", async () => {
  await withServer(async (base) => {
    await seed(base);
    const res = await req(base, "POST", "/admin/forestlands/FL-A/revisions", {
      rules: { ...RULES, min_tree_age_years: 30 },
      note: "提高树龄门槛",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.current_version, 2);
    const fl = await req(base, "GET", "/admin/forestlands/FL-A");
    assert.equal(fl.json.current_version, 2);
  });
});
