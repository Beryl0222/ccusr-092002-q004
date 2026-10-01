// 生态采材与工坊用料领域核心
//
// 设计要点：
// - 林地规则版本化：修订只约束修订生效之后的采集，历史材料按采集当时的规则审计。
// - 许可总量在并发申领下原子扣减（Ledger.claim 内单次同步执行，无 await）。
// - 采材支持弱网：现场生成 client_id 离线记录，联网后整批同步，幂等且乱序安全。
// - 敏感林点只保留模糊网格：服务从不持久化精确坐标，网格边长由规则声明。
// - 不合规材料（越界、证照过期、恢复检查未完成）进入隔离账，不得交接或投产。
// - 合法材料（整料/退料）、边角料、成品在每次流转中数量守恒；溯源按凭证去重。

export const UNIT_GRAMS = "g";

// ---------- 基础工具 ----------

export function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function monthOf(date) {
  return String(date).slice(0, 7);
}

export function assert(cond, message, code = "invalid_request", status = 400) {
  if (!cond) {
    const err = new Error(message);
    err.code = code;
    err.status = status;
    throw err;
  }
}

// 定位模糊化：把精确坐标量化为网格单元，服务端只留存网格编号。
// 偏移取 floor（不向中心聚拢），并返回网格边长供公开侧解释精度。
export function obfuscateLocation(lat, lon, gridMeters) {
  assert(Number.isFinite(lat) && Number.isFinite(lon), "缺少有效的采集坐标");
  assert(Number.isFinite(gridMeters) && gridMeters > 0, "网格边长无效");
  const latDeg = gridMeters / 111_320;
  const lonDeg = gridMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const gy = Math.floor(lat / latDeg);
  const gx = Math.floor(lon / lonDeg);
  return {
    grid: `G${gridMeters}m-X${gx}-Y${gy}`,
    grid_size_m: gridMeters,
    lat_band: gy,
    lon_band: gx,
  };
}

function gridToBands(grid) {
  const m = /^G(\d+)m-X(-?\d+)-Y(-?\d+)$/.exec(grid);
  assert(m, `网格编号无法解析: ${grid}`);
  return { size: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

// 同一套网格体系下，采集点必须落在林地声明的网格集合内。
export function isWithinForest(forest, grid) {
  const cell = gridToBands(grid);
  if (cell.size !== forest.grid_size_m) return false;
  if (!forest.allowed_grids || forest.allowed_grids.length === 0) return true;
  return forest.allowed_grids.includes(grid);
}

function shareOf(forest, version) {
  const rev = forest.revisions.find((r) => r.version === version);
  assert(rev, `规则版本 ${version} 不存在`, "invalid_request", 400);
  return { forest, rev };
}

// 某日生效的规则版本；atDate 早于全部版本时返回最早版本（建账时已公示）。
export function ruleVersionAt(forest, atDate = today()) {
  const revs = [...forest.revisions].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let active = revs[0];
  for (const rev of revs) if (rev.effective_from <= atDate) active = rev;
  return active.version;
}

function licenseAt(ledger, licenseId) {
  const lic = ledger.licenses.get(licenseId);
  assert(lic, `许可 ${licenseId} 不存在`, "not_found", 404);
  return lic;
}

function permitAt(ledger, permitId) {
  const p = ledger.permits.get(permitId);
  assert(p, `采集证照 ${permitId} 不存在`, "not_found", 404);
  return p;
}

function sumShares(makers) {
  return makers.reduce((s, m) => s + m.share, 0);
}

// ---------- 账本 ----------

export class Ledger {
  constructor(now = () => new Date()) {
    this.now = now;
    this.forests = new Map();
    this.teams = new Map();
    this.permits = new Map();
    this.licenses = new Map();
    this.claims = new Map();
    this.harvests = new Map();
    this.recoveryTasks = new Map();
    this.handovers = new Map();
    this.works = new Map();
    this.quarantined = [];
    this.allocations = [];
    this.scraps = [];
    this.returns = [];
    this.events = [];
    this._seq = 0;
  }

  _emit(type, payload) {
    const evt = { seq: ++this._seq, at: this.now().toISOString(), type, payload };
    this.events.push(evt);
    return evt;
  }

  // ----- 主体与证照 -----

  registerTeam({ team_id, name, permit_id, permit_valid_from, permit_valid_to }) {
    assert(team_id, "缺少 team_id");
    assert(!this.teams.has(team_id), `采集队 ${team_id} 已存在`);
    assert(permit_id && permit_valid_from && permit_valid_to, "证照编号与有效期必填");
    this.teams.set(team_id, { team_id, name: name ?? team_id });
    this.permits.set(permit_id, {
      permit_id,
      team_id,
      valid_from: permit_valid_from,
      valid_to: permit_valid_to,
    });
    this._emit("team.registered", { team_id, permit_id });
    return this.teams.get(team_id);
  }

  permitValid(permitId, atDate = today(this.now())) {
    const p = permitAt(this, permitId);
    return p.valid_from <= atDate && atDate <= p.valid_to;
  }

  // ----- 林地与规则版本 -----

  publishForest({
    forest_id,
    name,
    grid_size_m = 1000,
    allowed_grids = [],
    version = 1,
    effective_from = today(this.now()),
    season_start,
    season_end,
    min_tree_age_years,
    per_tree_quota_g,
    recovery_required = false,
    recovery_due_days = 0,
    notes = "",
  }) {
    assert(forest_id, "缺少 forest_id");
    assert(season_start && season_end, "必须声明季节窗口");
    assert(season_start.slice(5) <= season_end.slice(5), "季节窗口起止非法");
    assert(min_tree_age_years > 0, "树龄条件必须为正数");
    assert(per_tree_quota_g > 0, "单株上限必须为正数");
    if (!this.forests.has(forest_id)) {
      this.forests.set(forest_id, {
        forest_id,
        name: name ?? forest_id,
        grid_size_m,
        allowed_grids: [...allowed_grids],
        published_at: this.now().toISOString(),
        revisions: [],
      });
    }
    const forest = this.forests.get(forest_id);
    assert(!forest.revisions.some((r) => r.version === version), `规则版本 ${version} 已存在`);
    forest.revisions.push({
      version,
      effective_from,
      season: { start: season_start, end: season_end },
      min_tree_age_years,
      per_tree_quota_g,
      recovery_required,
      recovery_due_days,
      notes,
    });
    forest.revisions.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    this._emit("forest.rule_published", { forest_id, version, effective_from });
    return shareOf(forest, version).rev;
  }

  reviseRule(args) {
    const forest_id = args.forest_id;
    assert(this.forests.has(forest_id), `林地 ${forest_id} 不存在`, "not_found", 404);
    const nextVersion = Math.max(...this.forests.get(forest_id).revisions.map((r) => r.version)) + 1;
    return this.publishForest({ ...args, version: nextVersion });
  }

  // ----- 许可与并发申领 -----

  issueLicense({ license_id, forest_id, rule_version, season_start, season_end, total_quota_g }) {
    assert(license_id, "缺少 license_id");
    assert(!this.licenses.has(license_id), `许可 ${license_id} 已存在`);
    const forest = this.forests.get(forest_id);
    assert(forest, `林地 ${forest_id} 不存在`, "not_found", 404);
    const { rev } = shareOf(forest, rule_version);
    if (season_start && season_end) {
      assert(season_start.slice(5) >= rev.season.start && season_end.slice(5) <= rev.season.end,
        "许可窗口超出规则季节窗口");
    }
    assert(total_quota_g > 0, "许可总量必须为正数");
    this.licenses.set(license_id, {
      license_id,
      forest_id,
      rule_version,
      season_start: season_start ?? `${rev.effective_from.slice(0, 4)}-${rev.season.start}`,
      season_end: season_end ?? `${rev.effective_from.slice(0, 4)}-${rev.season.end}`,
      total_quota_g,
      allocated_quota_g: 0,
      issued_at: this.now().toISOString(),
    });
    this._emit("license.issued", { license_id, forest_id, total_quota_g });
    return this.licenses.get(license_id);
  }

  // 原子申领：同一许可的并发请求在 JS 单线程事件循环中依次完整执行，
  // 因此"检查剩余 - 扣减"之间不会穿插其他申领，总量绝不被突破。
  claimQuota({ license_id, team_id, permit_id, requested_g, request_id }) {
    assert(request_id, "缺少 request_id（申领幂等键）");
    const lic = licenseAt(this, license_id);
    assert(this.teams.has(team_id), `采集队 ${team_id} 不存在`, "not_found", 404);
    const permit = permitAt(this, permit_id);
    assert(permit.team_id === team_id, "证照不属于该采集队");
    assert(requested_g > 0, "申领额度必须为正数");

    for (const c of this.claims.values()) {
      if (c.request_id === request_id && c.license_id === license_id) return c;
    }
    const remaining = lic.total_quota_g - lic.allocated_quota_g;
    if (requested_g > remaining) {
      const err = new Error(`许可剩余额度不足：申请 ${requested_g}g，剩余 ${remaining}g`);
      err.code = "quota_exceeded";
      err.status = 409;
      err.remaining_g = remaining;
      throw err;
    }
    const claim_id = `CLM-${license_id}-${this.claims.size + 1}`;
    const claim = {
      claim_id,
      request_id,
      license_id,
      team_id,
      permit_id,
      allocated_g: requested_g,
      used_g: 0,
      status: "active",
      created_at: this.now().toISOString(),
    };
    this.claims.set(claim_id, claim);
    lic.allocated_quota_g += requested_g;
    this._emit("quota.claimed", { claim_id, license_id, requested_g });
    return claim;
  }

  // ----- 弱网采材同步 -----

  // batch：{ claim_id, permit_id, batch_id, records: [...] }
  // 同一 batch_id 重放整批返回同一结果；乱序送达时按 record_id 去重。
  syncHarvestBatch(batch) {
    assert(batch && batch.batch_id, "缺少 batch_id");
    // 同一批次重放：原样返回首次结果（含重量），但不再改动任何台账，天然防重复计账。
    const cached = this._batchIndex?.get(batch.batch_id);
    if (cached) return cached;

    const claim = this.claims.get(batch.claim_id);
    assert(claim, `额度记录 ${batch.claim_id} 不存在`, "not_found", 404);
    assert(claim.permit_id === batch.permit_id, "证照与申领记录不一致");
    assert(Array.isArray(batch.records) && batch.records.length > 0, "批次内没有采材记录");

    const accepted = [];
    const rejected = [];
    let batchAcceptedWeight = 0;
    const seenInBatch = new Set();

    for (const rec of [...batch.records].sort((a, b) =>
      String(a.record_id).localeCompare(String(b.record_id)))) {
      assert(rec.record_id, "采材记录缺少 record_id");
      assert(!seenInBatch.has(rec.record_id), `批次内记录重复: ${rec.record_id}`);
      seenInBatch.add(rec.record_id);
      // 已在早先批次同步过的记录：乱序重投只去重，重量不重复计入本批，分类仍按现状给出。
      if (this.harvests.has(rec.record_id)) {
        const prior = this.harvests.get(rec.record_id);
        if (prior.status === "accepted") accepted.push(prior);
        else rejected.push(prior);
        continue;
      }
      const result = this._ingestHarvest(claim, rec);
      if (result.record.status === "accepted") {
        accepted.push(result.record);
        batchAcceptedWeight += result.record.weight_g;
      } else {
        rejected.push(result.record);
      }
    }

    const summary = {
      batch_id: batch.batch_id,
      claim_id: batch.claim_id,
      accepted: accepted.map((r) => r.record_id),
      rejected: rejected.map((r) => ({ record_id: r.record_id, reasons: r.reasons })),
      accepted_weight_g: batchAcceptedWeight,
    };
    this._batchIndex ??= new Map();
    this._batchIndex.set(batch.batch_id, summary);
    this._emit("harvest.batch_synced", {
      batch_id: batch.batch_id,
      accepted: summary.accepted.length,
      rejected: summary.rejected.length,
    });
    return summary;
  }

  _ingestHarvest(claim, rec) {
    const lic = licenseAt(this, claim.license_id);
    const forest = this.forests.get(lic.forest_id);
    const atDate = String(rec.harvested_on ?? "").slice(0, 10);
    const reasons = [];

    // 1) 证照在采集当日有效
    if (!this.permitValid(claim.permit_id, atDate)) {
      const p = this.permits.get(claim.permit_id);
      reasons.push(`证照 ${claim.permit_id} 在 ${atDate} 已过期或未生效（有效期 ${p.valid_from}~${p.valid_to}）`);
    }
    // 2) 当日生效规则版本（规则修订不溯及既往）及其季节窗口
    const activeVersion = ruleVersionAt(forest, atDate);
    const activeRev = shareOf(forest, activeVersion).rev;
    const md = atDate.slice(5);
    if (!(atDate >= lic.season_start && atDate <= lic.season_end)) {
      reasons.push(`采集日期 ${atDate} 超出许可季节窗口 ${lic.season_start}~${lic.season_end}`);
    }
    if (!(md >= activeRev.season.start && md <= activeRev.season.end)) {
      reasons.push(`采集日期 ${atDate} 超出当日规则(v${activeVersion})季节窗口 ${activeRev.season.start}~${activeRev.season.end}`);
    }
    // 3) 定位：现场设备做网格量化；即便误传精确坐标，服务端也再次模糊化，不留精确点
    let gridInfo;
    if (rec.grid) {
      gridInfo = { grid: rec.grid, grid_size_m: forest.grid_size_m };
      if (!isWithinForest(forest, rec.grid)) reasons.push(`采集网格 ${rec.grid} 越出许可林地范围`);
    } else if (Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) {
      gridInfo = obfuscateLocation(rec.lat, rec.lon, forest.grid_size_m);
      if (!isWithinForest(forest, gridInfo.grid)) reasons.push(`采集网格 ${gridInfo.grid} 越出许可林地范围`);
    } else {
      reasons.push("缺少采集定位");
      gridInfo = { grid: null, grid_size_m: forest.grid_size_m };
    }
    // 4) 树龄与单株上限按采集当日生效的规则判定
    if (!(rec.tree_age_years >= activeRev.min_tree_age_years)) {
      reasons.push(`树龄 ${rec.tree_age_years} 低于当日规则要求 ${activeRev.min_tree_age_years} 年`);
    }
    if (!(rec.weight_g > 0)) reasons.push("采材重量非法");
    if (rec.weight_g > activeRev.per_tree_quota_g) {
      reasons.push(`单株取材 ${rec.weight_g}g 超过当日单株上限 ${activeRev.per_tree_quota_g}g`);
    }
    // 5) 申领额度余额（只计合规重量）
    const remaining = claim.allocated_g - claim.used_g;
    if (rec.weight_g > remaining) reasons.push(`超出申领额度：本笔 ${rec.weight_g}g，剩余 ${remaining}g`);

    const record = {
      record_id: rec.record_id,
      claim_id: claim.claim_id,
      license_id: claim.license_id,
      forest_id: lic.forest_id,
      team_id: claim.team_id,
      harvested_on: atDate,
      harvested_month: monthOf(atDate),
      rule_version_when_harvested: activeVersion,
      license_rule_version: lic.rule_version,
      grid: gridInfo.grid,
      grid_size_m: gridInfo.grid_size_m,
      tree_age_years: rec.tree_age_years,
      weight_g: rec.weight_g ?? 0,
      tree_handling: rec.tree_handling ?? "",
      recovery_required: activeRev.recovery_required,
      recovery_task_id: activeRev.recovery_required ? `REC-${rec.record_id}` : null,
      permit_id: claim.permit_id,
      status: reasons.length === 0 ? "accepted" : "quarantined",
      reasons,
      observed_at: rec.observed_at ?? null,
      client_created_at: rec.client_created_at ?? null,
      synced_at: this.now().toISOString(),
    };

    this.harvests.set(rec.record_id, record);

    if (record.status === "accepted") {
      claim.used_g += record.weight_g;
      if (record.recovery_task_id) {
        this.recoveryTasks.set(record.recovery_task_id, {
          task_id: record.recovery_task_id,
          record_id: record.record_id,
          forest_id: lic.forest_id,
          due_on: addDays(atDate, activeRev.recovery_due_days),
          status: "pending",
          checks: [],
        });
      }
      this._emit("harvest.accepted", {
        record_id: record.record_id,
        weight_g: record.weight_g,
        grid: record.grid,
      });
    } else {
      this.quarantined.push({ ...record, quarantined_at: this.now().toISOString() });
      this._emit("harvest.quarantined", { record_id: record.record_id, reasons });
    }
    return { record };
  }

  // ----- 恢复观察 -----

  recordRecoveryCheck({ task_id, checked_on, observer, finding, healthy }) {
    const task = this.recoveryTasks.get(task_id);
    assert(task, `恢复任务 ${task_id} 不存在`, "not_found", 404);
    assert(healthy !== undefined, "必须给出树体是否健康的结论");
    task.checks.push({ checked_on, observer: observer ?? "", finding: finding ?? "", healthy: !!healthy });
    this._emit("recovery.checked", { task_id, healthy });
    if (task.checks.some((c) => !c.healthy)) {
      task.status = "failed";
      // 恢复观察不合格：对应材料即便已合规入库，也立即转入隔离，停止后续交接与投产。
      const rec = this.harvests.get(task.record_id);
      if (rec && rec.status === "accepted") {
        rec.status = "quarantined";
        rec.reasons.push(`恢复观察不合格（${task.task_id}）：${finding || "树体健康检查未通过"}`);
        this.quarantined.push({ ...rec, quarantined_at: this.now().toISOString(), via: "recovery_failed" });
        this._emit("harvest.quarantined", { record_id: rec.record_id, reasons: rec.reasons });
      }
    } else if (checked_on >= task.due_on) {
      task.status = "completed";
    } else {
      task.status = "observed";
    }
    return task;
  }

  recoveryStatusFor(recordId) {
    const rec = this.harvests.get(recordId);
    assert(rec, `采材凭证 ${recordId} 不存在`, "not_found", 404);
    if (!rec.recovery_task_id) return { required: false, status: "not_required" };
    const task = this.recoveryTasks.get(rec.recovery_task_id);
    return { required: true, task_id: task.task_id, status: task.status, due_on: task.due_on };
  }

  // ----- 交接凭证（合规材料才可交接） -----

  handover({ handover_id, record_ids, to_workshop_id, handed_on }) {
    assert(handover_id, "缺少 handover_id");
    assert(!this.handovers.has(handover_id), `交接单 ${handover_id} 已存在`);
    assert(Array.isArray(record_ids) && record_ids.length > 0, "交接凭证列表为空");
    const records = record_ids.map((id) => {
      const r = this.harvests.get(id);
      assert(r, `采材凭证 ${id} 不存在`, "not_found", 404);
      assert(r.status === "accepted", `凭证 ${id} 未通过合规判定，禁止交接`);
      assert(!r.handed_over_at, `凭证 ${id} 已交接，禁止重复占用`);
      if (r.recovery_task_id) {
        const task = this.recoveryTasks.get(r.recovery_task_id);
        assert(task.status === "completed",
          `凭证 ${id} 的恢复检查尚未完成（${task.status}），材料须隔离`);
      }
      return r;
    });
    for (const r of records) r.handed_over_at = handed_on ?? today(this.now());
    const doc = {
      handover_id,
      record_ids: [...record_ids],
      to_workshop_id,
      handed_on: handed_on ?? today(this.now()),
      total_g: records.reduce((s, r) => s + r.weight_g, 0),
    };
    this.handovers.set(handover_id, doc);
    this._emit("material.handed_over", { handover_id, count: record_ids.length });
    return doc;
  }

  // ----- 工坊用料：分配 / 边角料 / 退料，全程守恒 -----

  allocateToWork({ work_id, makers, items, produced_on = today(this.now()) }) {
    assert(work_id, "缺少 work_id（作品编号）");
    assert(!this.works.has(work_id), `作品 ${work_id} 已登记`);
    assert(Array.isArray(makers) && makers.length > 0, "制作者至少一人");
    const shareTotal = sumShares(makers);
    assert(Math.abs(shareTotal - 1) < 1e-9, `多人合制份额之和必须为 1，当前 ${shareTotal}`);
    assert(Array.isArray(items) && items.length > 0, "用料批次为空");

    const usedRecords = new Set();
    let inputTotal = 0;
    for (const item of items) {
      const r = this.harvests.get(item.record_id);
      assert(r, `采材凭证 ${item.record_id} 不存在`, "not_found", 404);
      assert(r.status === "accepted", `凭证 ${item.record_id} 未通过合规判定，禁止投产`);
      assert(!usedRecords.has(item.record_id), `同一次配料中凭证 ${item.record_id} 重复`);
      usedRecords.add(item.record_id);
      if (r.recovery_task_id) {
        const task = this.recoveryTasks.get(r.recovery_task_id);
        assert(task.status === "completed", `凭证 ${item.record_id} 恢复检查未完成，材料须隔离`);
      }
      const allocated = this._allocatedOf(r.record_id);
      assert(item.amount_g > 0, "投料重量必须为正数");
      assert(item.amount_g <= r.weight_g - allocated,
        `凭证 ${item.record_id} 可投余额不足：申请 ${item.amount_g}g，余额 ${r.weight_g - allocated}g`);
      assert((item.scrap_g ?? 0) >= 0 && (item.scrap_g ?? 0) <= item.amount_g,
        `凭证 ${item.record_id} 边角料重量须在 0~投料量之间`);
      inputTotal += item.amount_g;
    }
    const scrapTotal = items.reduce((s, i) => s + (i.scrap_g ?? 0), 0);

    const work = {
      work_id,
      makers: makers.map((m) => ({ id: m.id, share: m.share })),
      produced_on,
      allocations: items.map((i) => ({ record_id: i.record_id, amount_g: i.amount_g, scrap_g: i.scrap_g ?? 0 })),
      input_g: inputTotal,
      scrap_g: scrapTotal,
      incorporated_g: inputTotal - scrapTotal,
      returns: [],
      returned_g: 0,
      net_incorporated_g: inputTotal - scrapTotal,
    };
    for (const i of items) {
      this.allocations.push({
        work_id,
        record_id: i.record_id,
        amount_g: i.amount_g,
        scrap_g: i.scrap_g ?? 0,
        produced_on,
      });
      if (i.scrap_g > 0) {
        this.scraps.push({
          scrap_id: `SCR-${work_id}-${i.record_id}`,
          work_id,
          source_record_id: i.record_id,
          forest_id: this.harvests.get(i.record_id).forest_id,
          weight_g: i.scrap_g,
          status: "recovered",
          recovered_into_work_id: null,
        });
      }
    }
    this.works.set(work_id, work);
    this._emit("work.allocated", { work_id, input_g: inputTotal, scrap_g: scrapTotal });
    return this.workView(work_id);
  }

  _allocatedOf(recordId) {
    let used = 0;
    for (const a of this.allocations) if (a.record_id === recordId) used += a.amount_g;
    for (const r of this.returns) if (r.record_id === recordId) used -= r.amount_g;
    return used;
  }

  _harvestWindow(records) {
    const dates = records.map((r) => r.harvested_on).sort();
    return dates.length === 1 ? dates[0] : `${dates[0]}~${dates[dates.length - 1]}`;
  }

  // 边角料再投入其他作品：守恒（来源作品的净用料不变，边角料池减量）。
  reuseScrap({ scrap_id, into_work_id, amount_g, produced_on = today(this.now()) }) {
    const scrap = this.scraps.find((s) => s.scrap_id === scrap_id);
    assert(scrap, `边角料 ${scrap_id} 不存在`, "not_found", 404);
    assert(scrap.status === "recovered", `边角料 ${scrap_id} 已用尽或不可用`);
    const work = this.works.get(into_work_id);
    assert(work, `作品 ${into_work_id} 不存在`, "not_found", 404);
    assert(amount_g > 0 && amount_g <= scrap.weight_g, "边角料可用重量不足");
    const sourceRec = this.harvests.get(scrap.source_record_id);
    work.allocations.push({
      record_id: scrap.source_record_id,
      amount_g: 0,
      scrap_g: 0,
      via_scrap_id: scrap_id,
      scrap_reuse_g: amount_g,
    });
    work.input_g += amount_g;
    work.net_incorporated_g += amount_g;
    scrap.weight_g -= amount_g;
    scrap.reused_g = (scrap.reused_g ?? 0) + amount_g;
    scrap.recovered_into_work_id = into_work_id;
    if (scrap.weight_g === 0) scrap.status = "consumed";
    this._emit("scrap.reused", { scrap_id, into_work_id, amount_g });
    return this.workView(into_work_id);
  }

  // 退料：已投产材料整料退回库存，作品净用料核减；退料可再次分配，守恒不断。
  returnMaterial({ work_id, record_id, amount_g, reason = "", returned_on = today(this.now()) }) {
    const work = this.works.get(work_id);
    assert(work, `作品 ${work_id} 不存在`, "not_found", 404);
    const entry = work.allocations.find((a) => a.record_id === record_id && !a.via_scrap_id);
    assert(entry, `作品 ${work_id} 未使用凭证 ${record_id}`);
    const alreadyReturned = work.returns.filter((r) => r.record_id === record_id)
      .reduce((s, r) => s + r.amount_g, 0);
    const available = entry.amount_g - entry.scrap_g - alreadyReturned;
    assert(amount_g > 0 && amount_g <= available,
      `可退重量不足：申请 ${amount_g}g，可退 ${available}g（边角料不可整料退）`);
    const ret = {
      return_id: `RET-${work_id}-${record_id}-${work.returns.length + 1}`,
      work_id,
      record_id,
      amount_g,
      reason,
      returned_on,
    };
    work.returns.push(ret);
    work.returned_g += amount_g;
    work.net_incorporated_g -= amount_g;
    this.returns.push(ret);
    this._emit("material.returned", { work_id, record_id, amount_g });
    return ret;
  }

  // ---------- 查询：溯源 / 验真 / 报表 ----------

  // 从作品回溯采材凭证；边角料跨作品再利用只沿同一凭证计一次，绝不重复计算。
  traceWork(work_id) {
    const work = this.works.get(work_id);
    assert(work, `作品 ${work_id} 不存在`, "not_found", 404);
    const byRecord = new Map();
    for (const a of work.allocations) {
      const cur = byRecord.get(a.record_id) ?? { direct_g: 0, scrap_reuse_g: 0 };
      cur.direct_g += a.amount_g - a.scrap_g;
      cur.scrap_reuse_g += a.scrap_reuse_g ?? 0;
      byRecord.set(a.record_id, cur);
    }
    for (const r of work.returns) {
      const cur = byRecord.get(r.record_id);
      cur.direct_g -= r.amount_g;
    }
    const traced = [...byRecord.entries()].map(([record_id, g]) => {
      const rec = this.harvests.get(record_id);
      return {
        record_id,
        incorporated_g: g.direct_g + g.scrap_reuse_g,
        from_direct_g: g.direct_g,
        from_scrap_g: g.scrap_reuse_g,
        harvested_on: rec.harvested_on,
        rule_version: rec.rule_version_when_harvested,
        license_id: rec.license_id,
        compliance: rec.status === "accepted" ? "合规" : "隔离",
        recovery: this.recoveryStatusFor(record_id).status,
      };
    });
    const total = traced.reduce((s, t) => s + t.incorporated_g, 0);
    return {
      work_id,
      makers: work.makers,
      net_incorporated_g: work.net_incorporated_g,
      traced_mass_g: total,
      conservation_holds: Math.abs(total - work.net_incorporated_g) < 1e-6,
      unique_record_count: traced.length,
      records: traced,
    };
  }

  // 公开验真视图：只暴露必要来源结论，不泄露网格/林地精确信息/证照号。
  publicVerification(work_id) {
    const work = this.works.get(work_id);
    assert(work, `作品 ${work_id} 不存在`, "not_found", 404);
    const trace = this.traceWork(work_id);
    const ruleVersions = [...new Set(trace.records.map((r) => r.rule_version))].sort();
    return {
      craft_id: work.work_id,
      verdict: "来源合规",
      makers: work.makers.map((m) => ({ id: m.id, share: m.share })),
      batch_count: trace.unique_record_count,
      material_mass_g: work.net_incorporated_g,
      sourced_in_forest_count: new Set(trace.records.map((r) => this.harvests.get(r.record_id).forest_id)).size,
      harvest_window: this._harvestWindow(trace.records.map((r) => this.harvests.get(r.record_id))),
      rule_versions_at_harvest: ruleVersions,
      recovery_completed: trace.records.every((r) => r.recovery === "completed" || r.recovery === "not_required"),
      scrap_recycled_g: work.scrap_g - this._scrapStillHeld(work_id),
      // 显式不含：grid、forest_id、permit_id、claim_id、精确坐标
    };
  }

  _scrapStillHeld(workId) {
    return this.scraps.filter((s) => s.work_id === workId).reduce((s, x) => s + x.weight_g, 0);
  }

  // 管理者按林地 + 月份核对：实际消耗、恢复任务、剩余额度。
  monthlyReport(forestId, month) {
    const forest = this.forests.get(forestId);
    assert(forest, `林地 ${forestId} 不存在`, "not_found", 404);
    const recs = [...this.harvests.values()].filter(
      (r) => r.forest_id === forestId && r.harvested_month === month,
    );
    const accepted = recs.filter((r) => r.status === "accepted");
    const quarantine = recs.filter((r) => r.status === "quarantined");

    let allocatedDirect_g = 0;
    let directNet_g = 0;
    const netByWork = new Map();
    for (const a of this.allocations) {
      const r = this.harvests.get(a.record_id);
      if (r.forest_id !== forestId || r.harvested_month !== month) continue;
      if (a.via_scrap_id) {
        // 本月材料产生的边角料再投入某件作品
        netByWork.set(a.work_id, (netByWork.get(a.work_id) ?? 0) + (a.scrap_reuse_g ?? 0));
      } else {
        allocatedDirect_g += a.amount_g;
        const net = a.amount_g - a.scrap_g;
        directNet_g += net;
        netByWork.set(a.work_id, (netByWork.get(a.work_id) ?? 0) + net);
      }
    }
    let scrapOpen_g = 0;
    for (const s of this.scraps) {
      const r = this.harvests.get(s.source_record_id);
      if (r.forest_id === forestId && r.harvested_month === month) {
        scrapOpen_g += s.weight_g;
      }
    }
    let returned_g = 0;
    for (const ret of this.returns) {
      const r = this.harvests.get(ret.record_id);
      if (r.forest_id === forestId && r.harvested_month === month) {
        returned_g += ret.amount_g;
        netByWork.set(ret.work_id, (netByWork.get(ret.work_id) ?? 0) - ret.amount_g);
      }
    }
    // 净入作 = 直投净额(已扣原始边角料) + 边角料再利用 - 退料
    //        = 直投 - 边角料余量 - 退料（再利用量与原始量中的已用部分相消）
    const incorporated_g = allocatedDirect_g - scrapOpen_g - returned_g;

    const recovery = [...this.recoveryTasks.values()]
      .filter((t) => t.forest_id === forestId && monthOf(this.harvests.get(t.record_id).harvested_on) === month)
      .map((t) => ({ task_id: t.task_id, record_id: t.record_id, status: t.status, due_on: t.due_on }));

    const licenses = [...this.licenses.values()].filter((l) => l.forest_id === forestId);
    const quota = licenses.map((l) => ({
      license_id: l.license_id,
      total_g: l.total_quota_g,
      allocated_g: l.allocated_quota_g,
      remaining_g: l.total_quota_g - l.allocated_quota_g,
      harvested_compliant_g: [...this.harvests.values()]
        .filter((r) => r.license_id === l.license_id && r.status === "accepted")
        .reduce((s, r) => s + r.weight_g, 0),
    }));

    return {
      forest_id: forestId,
      month,
      harvest: {
        compliant_weight_g: accepted.reduce((s, r) => s + r.weight_g, 0),
        quarantined_weight_g: quarantine.reduce((s, r) => s + r.weight_g, 0),
        compliant_records: accepted.length,
        quarantined_records: quarantine.length,
      },
      consumption: {
        incorporated_g,
        returned_g,
        scrap_open_g: scrapOpen_g,
      },
      recovery_tasks: recovery,
      quota,
      // 守恒：合规采集量 = 库存 + 净入作 + 未闭环边角料（退料已回到库存并从净入作核减）
      conservation:
        Math.abs(
          accepted.reduce((s, r) => s + r.weight_g, 0) -
            incorporated_g -
            scrapOpen_g -
            this._inStockForestMonth(forestId, month),
        ) < 1e-6,
      works: [...netByWork.entries()]
        .map(([work_id, g]) => ({ work_id, incorporated_g: g }))
        .filter((w) => Math.abs(w.incorporated_g) > 1e-9),
    };
  }

  // 已合规采集但尚未投产/退料/边角料形态的库存重量
  _inStockForestMonth(forestId, month) {
    let stock = 0;
    for (const r of this.harvests.values()) {
      if (r.forest_id !== forestId || r.harvested_month !== month || r.status !== "accepted") continue;
      stock += r.weight_g - this._allocatedOf(r.record_id);
    }
    return stock;
  }

  workView(work_id) {
    const w = this.works.get(work_id);
    return {
      work_id: w.work_id,
      makers: w.makers,
      produced_on: w.produced_on,
      input_g: w.input_g,
      scrap_g: w.scrap_g,
      returned_g: w.returned_g,
      net_incorporated_g: w.net_incorporated_g,
      allocations: w.allocations,
    };
  }
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
