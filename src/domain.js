// 生态采材与工坊用料领域核心
//
// 设计要点：
// - 林地规则按版本发布，修订只约束后续采集；已有采材记录快照其许可与规则版本，按当时规则接受审计。
// - 许可额度申领在同一状态对象内串行判定+扣减，调用方（HTTP 层）对同一状态加锁即可保证并发不超总量。
// - 采材凭证以客户端生成的 record_id 幂等，弱网重传安全；定位只存模糊格网，不存敏感林点。
// - 越界、证照过期、恢复检查未完成等情形的材料进入隔离，不得进入工坊用料。
// - 工坊用料、边角料、退料、多人合制全部走同一物料平衡：输入 = 成品占用 + 边角料 + 退料。

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

// ---------- 基础工具 ----------

export function nowIso() {
  return new Date().toISOString();
}

export function todayDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function assertNumber(value, name, { integer = false, positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}必须是数字`);
  }
  if (integer && !Number.isInteger(value)) throw new Error(`${name}必须是整数`);
  if (positive && value <= 0) throw new Error(`${name}必须大于 0`);
}

function assertNonNegative(value, name, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name}必须是非负数`);
  }
  if (integer && !Number.isInteger(value)) throw new Error(`${name}必须是整数`);
}

function requireFields(obj, fields, label) {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === "") {
      throw new Error(`${label}缺少字段 ${field}`);
    }
  }
}

// 将精确坐标模糊化为格网单元标识（约 cellKm 公里尺度）。
// 只输出格网与粗粒度行政区，不保留可反推单株位置的原始坐标。
export function blurLocation({ lat, lon }, cellKm = 2) {
  assertNumber(lat, "lat");
  assertNumber(lon, "lon");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error("坐标超出范围");
  }
  const latStep = cellKm / 111;
  const lonStep = cellKm / (111 * Math.cos((lat * Math.PI) / 180) || 1);
  const cellLat = Math.floor(lat / latStep) * latStep;
  const cellLon = Math.floor(lon / lonStep) * lonStep;
  return {
    grid: `G${cellKm}@${cellLat.toFixed(3)},${cellLon.toFixed(3)}`,
    cell_km: cellKm,
    // 格网中心仅在授权核验时内部使用，公开验真不返回
    _cell_center: { lat: cellLat + latStep / 2, lon: cellLon + lonStep / 2 },
  };
}

// 多边形边界（[lon,lat] 环）的射线法判定，模糊格网中心必须落在许可地块内
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------- 账状态 ----------

export function createLedger({ clock = nowIso } = {}) {
  return {
    version: 1,
    clock,
    forestlands: new Map(), // id -> {..., ruleVersions:[{version,rules,...}], currentVersion}
    permits: new Map(), // id -> permit
    records: new Map(), // record_id -> 采材凭证
    quarantined: new Map(), // record_id -> 隔离凭证（与 records 互斥存放）
    permitsByRecord: new Map(), // record_id -> permit_id
    handoffs: new Map(), // handoff_id -> {permit_id, record_ids, to_team, at}
    workshops: new Map(), // workshop_id -> {id,name}
    craftMakers: new Map(), // craft_id -> [{maker_id, share}]（来自 craft_record.json）
    allocations: new Map(), // batch_id -> 工坊批次
    craftBatches: new Map(), // craft_id -> [batch_id]
    materialIndex: new Map(), // craft_id -> {record_id -> quantity}（合制时聚合）
    batchIndex: new Map(), // record_id -> Set(batch_id)
    returns: new Map(), // return_id -> 退料
    recoveryTasks: new Map(), // task_id -> 恢复观察任务
    auditLog: [],
  };
}

// ---------- 审计日志 ----------

function audit(ledger, action, detail = {}) {
  ledger.auditLog.push({ at: ledger.clock(), action, ...detail });
}

// ---------- 林地与规则版本 ----------

// 发布林地及其第一版规则。
// rules: { season: {start:"MM-DD", end:"MM-DD"}, min_tree_age_years,
//          per_tree_limit_kg, recovery: { observe_days, required_checks: [...] } }
export function publishForestland(ledger, input) {
  requireFields(input, ["forestland_id", "name", "rules"], "林地");
  if (ledger.forestlands.has(input.forestland_id)) {
    throw new Error("林地已存在，应使用修订规则接口");
  }
  validateRules(input.rules);
  const fl = {
    id: input.forestland_id,
    name: input.name,
    region: input.region ?? null,
    boundary: input.boundary ?? null, // [[lon,lat],...] 闭合环
    currentVersion: 1,
    ruleVersions: [
      {
        version: 1,
        rules: cloneRules(input.rules),
        published_at: ledger.clock(),
        note: input.note ?? "首次发布",
      },
    ],
  };
  ledger.forestlands.set(fl.id, fl);
  audit(ledger, "forestland.publish", { forestland_id: fl.id, version: 1 });
  return publicForestland(fl);
}

// 修订规则：只约束修订之后的新采集；旧许可/旧凭证不受影响。
export function reviseForestlandRules(ledger, forestlandId, rules, note = "") {
  const fl = requireForestland(ledger, forestlandId);
  validateRules(rules);
  const version = fl.currentVersion + 1;
  fl.ruleVersions.push({
    version,
    rules: cloneRules(rules),
    published_at: ledger.clock(),
    note,
  });
  fl.currentVersion = version;
  audit(ledger, "forestland.revise", { forestland_id: fl.id, version });
  return { forestland_id: fl.id, current_version: version };
}

function validateRules(rules) {
  requireFields(
    rules,
    ["season", "min_tree_age_years", "per_tree_limit_kg", "recovery"],
    "采集规则"
  );
  requireFields(rules.season, ["start", "end"], "季节窗口");
  assertNumber(rules.min_tree_age_years, "最低树龄", { positive: true });
  assertNumber(rules.per_tree_limit_kg, "单株上限", { positive: true });
  if (!/^\d{2}-\d{2}$/.test(rules.season.start) || !/^\d{2}-\d{2}$/.test(rules.season.end)) {
    throw new Error("季节窗口格式应为 MM-DD");
  }
  assertNumber(rules.recovery.observe_days, "恢复观察天数", {
    integer: true,
    positive: true,
  });
  if (!Array.isArray(rules.recovery.required_checks)) {
    throw new Error("恢复检查项必须是数组");
  }
}

function cloneRules(rules) {
  return JSON.parse(JSON.stringify(rules));
}

function requireForestland(ledger, id) {
  const fl = ledger.forestlands.get(id);
  if (!fl) throw new Error(`林地 ${id} 不存在`);
  return fl;
}

function getRuleVersion(fl, version) {
  const rv = fl.ruleVersions.find((r) => r.version === version);
  if (!rv) throw new Error(`规则版本 ${version} 不存在`);
  return rv;
}

export function publicForestland(fl) {
  const current = getRuleVersion(fl, fl.currentVersion);
  return {
    forestland_id: fl.id,
    name: fl.name,
    region: fl.region,
    current_version: fl.currentVersion,
    rules: cloneRules(current.rules),
    published_at: current.published_at,
    // 不公开精确边界
  };
}

// ---------- 许可与额度 ----------

// 林地管理者在某块林地上发放采集许可：总量、有效期、要求证照。
export function issuePermit(
  ledger,
  { permit_id, forestland_id, team_id, total_quota_kg, valid_from, valid_to, required_credentials = [] }
) {
  const fl = requireForestland(ledger, forestland_id);
  requireFields(
    { permit_id, forestland_id, team_id, total_quota_kg, valid_from, valid_to },
    ["permit_id", "forestland_id", "team_id", "total_quota_kg", "valid_from", "valid_to"],
    "许可"
  );
  assertNumber(total_quota_kg, "许可总量", { positive: true });
  if (ledger.permits.has(permit_id)) throw new Error("许可编号已存在");
  if (valid_from > valid_to) throw new Error("许可有效期起始晚于结束");
  const permit = {
    id: permit_id,
    forestland_id,
    team_id,
    total_quota_kg,
    allocated_quota_kg: 0,
    valid_from,
    valid_to,
    required_credentials: [...required_credentials],
    rule_version: fl.currentVersion, // 许可发放时锁定规则版本
    issued_at: ledger.clock(),
    closed: false,
  };
  ledger.permits.set(permit.id, permit);
  audit(ledger, "permit.issue", {
    permit_id: permit.id,
    forestland_id,
    total_quota_kg,
    rule_version: permit.rule_version,
  });
  return publicPermit(permit);
}

// 采集队申领额度。判定与扣减在本函数内一次完成；调用方需保证对 ledger 的串行访问。
export function requestQuota(ledger, { permit_id, request_id, amount_kg }) {
  const permit = requirePermit(ledger, permit_id);
  requireFields({ request_id, amount_kg }, ["request_id", "amount_kg"], "额度申领");
  assertNumber(amount_kg, "申领量", { positive: true });

  const requests = (permit.requests ??= new Map());
  if (requests.has(request_id)) {
    // 弱网重试：同一申领单幂等返回首次结果
    return { ...publicPermit(permit), request_id, idempotent: true };
  }
  if (permit.closed) throw new Error("许可已关闭");
  const remaining = permit.total_quota_kg - permit.allocated_quota_kg;
  if (amount_kg > remaining + 1e-9) {
    requests.set(request_id, { at: ledger.clock(), amount_kg, granted: false });
    audit(ledger, "permit.quota_denied", { permit_id, request_id, amount_kg });
    const err = new Error("剩余额度不足");
    err.code = "QUOTA_EXCEEDED";
    err.remaining_kg = remaining;
    throw err;
  }
  permit.allocated_quota_kg += amount_kg;
  requests.set(request_id, { at: ledger.clock(), amount_kg, granted: true });
  audit(ledger, "permit.quota_granted", { permit_id, request_id, amount_kg });
  return { ...publicPermit(permit), request_id, granted_amount_kg: amount_kg };
}

export function closePermit(ledger, permitId) {
  const permit = requirePermit(ledger, permitId);
  permit.closed = true;
  audit(ledger, "permit.close", { permit_id: permitId });
  return publicPermit(permit);
}

function requirePermit(ledger, id) {
  const p = ledger.permits.get(id);
  if (!p) throw new Error(`许可 ${id} 不存在`);
  return p;
}

export function publicPermit(p) {
  return {
    permit_id: p.id,
    forestland_id: p.forestland_id,
    team_id: p.team_id,
    total_quota_kg: p.total_quota_kg,
    allocated_quota_kg: round(p.allocated_quota_kg),
    remaining_quota_kg: round(p.total_quota_kg - p.allocated_quota_kg),
    valid_from: p.valid_from,
    valid_to: p.valid_to,
    rule_version: p.rule_version,
    required_credentials: p.required_credentials,
    closed: p.closed,
  };
}

// ---------- 采材凭证（弱网上报，幂等） ----------

// 上报一笔记采材。客户端预生成 record_id，弱网重发不会重复计量。
// record: {
//   record_id, permit_id, team_id, collected_on,
//   location:{lat,lon} 或已模糊的 {grid,...}, tree_id, tree_age_years,
//   weight_kg, treatment（树体处置：harvest_bark/prune/...）,
//   credentials:[{type, number, expires_on}],
//   client_seq? 弱网排序序号
// }
export function submitHarvestRecord(ledger, record) {
  requireFields(
    record,
    ["record_id", "permit_id", "team_id", "collected_on", "tree_id", "tree_age_years", "weight_kg", "treatment"],
    "采材凭证"
  );
  if (ledger.records.has(record.record_id) || ledger.quarantined.has(record.record_id)) {
    const existing = ledger.records.get(record.record_id) ?? ledger.quarantined.get(record.record_id);
    return { ...publicRecord(existing), idempotent: true };
  }
  const permit = requirePermit(ledger, record.permit_id);
  if (permit.team_id !== record.team_id) throw new Error("采集队与许可不符");
  assertNumber(record.weight_kg, "采材重量", { positive: true });
  assertNumber(record.tree_age_years, "树龄", { positive: true });

  const fl = requireForestland(ledger, permit.forestland_id);
  const rv = getRuleVersion(fl, permit.rule_version); // 按许可锁定的当时规则判定
  const rules = rv.rules;

  // 定位模糊化：接受精确坐标（现场端）或已是格网标识（中继端）
  let location;
  if (record.location?.grid) {
    location = { grid: record.location.grid, cell_km: record.location.cell_km ?? null };
  } else if (record.location?.lat !== undefined) {
    const blurred = blurLocation(record.location);
    location = { grid: blurred.grid, cell_km: blurred.cell_km };
  } else {
    throw new Error("缺少采材定位");
  }

  const stored = {
    record_id: record.record_id,
    permit_id: permit.id,
    forestland_id: fl.id,
    team_id: record.team_id,
    rule_version: permit.rule_version,
    collected_on: record.collected_on,
    location,
    tree_id: record.tree_id,
    tree_age_years: record.tree_age_years,
    weight_kg: record.weight_kg,
    treatment: record.treatment,
    credentials: record.credentials ?? [],
    received_at: ledger.clock(),
    status: "quarantined", // 先隔离，判定通过后转合格
    violations: [],
    // 树体处置/恢复挂钩的任务，检查完成前材料保持隔离
    recovery_task_id: null,
    used_kg: 0,
    returned_kg: 0,
    client_seq: record.client_seq ?? null,
  };

  // --- 合规判定（全部基于许可当时的规则快照） ---
  const violations = stored.violations;

  if (record.collected_on < permit.valid_from || record.collected_on > permit.valid_to) {
    violations.push({ code: "PERMIT_EXPIRED", detail: "采集日期不在许可有效期内" });
  }
  if (!withinSeason(record.collected_on, rules.season)) {
    violations.push({ code: "OUT_OF_SEASON", detail: "不在获准季节窗口" });
  }
  if (record.tree_age_years < rules.min_tree_age_years) {
    violations.push({ code: "TREE_TOO_YOUNG", detail: "树龄低于规则要求" });
  }
  if (record.weight_kg > rules.per_tree_limit_kg + 1e-9) {
    violations.push({ code: "PER_TREE_LIMIT", detail: "超过单株采材上限" });
  }
  // 越界：模糊格网中心须落在林地边界内
  if (fl.boundary) {
    const center = record.location?.lat !== undefined
      ? blurLocation(record.location)._cell_center
      : null;
    if (center && !pointInPolygon([center.lon, center.lat], fl.boundary)) {
      violations.push({ code: "OUT_OF_BOUNDARY", detail: "采材格网落在获准地块之外" });
    }
  }
  // 证照核验：类型齐备且在采集当日未过期
  const creds = stored.credentials;
  for (const required of permit.required_credentials) {
    const cred = creds.find((c) => c.type === required);
    if (!cred) {
      violations.push({ code: "CREDENTIAL_MISSING", detail: `缺证照 ${required}` });
    } else if (!cred.expires_on || cred.expires_on < record.collected_on) {
      violations.push({ code: "CREDENTIAL_EXPIRED", detail: `证照 ${required} 已过期` });
    }
  }
  // 同一树重复占用：不同采集队/许可不得对同一 tree_id 重复采材（含隔离中的凭证）
  for (const other of [...ledger.records.values(), ...ledger.quarantined.values()]) {
    if (other.tree_id === stored.tree_id && other.permit_id !== stored.permit_id) {
      violations.push({ code: "TREE_ALREADY_CLAIMED", detail: "该树已被其他许可占用" });
      break;
    }
  }

  // 恢复观察任务：凭证先挂起，待 required_checks 全部完成且观察期届满才解除隔离
  const taskId = `rec-${stored.record_id}`;
  stored.recovery_task_id = taskId;
  ledger.recoveryTasks.set(taskId, {
    task_id: taskId,
    record_id: stored.record_id,
    forestland_id: fl.id,
    rule_version: permit.rule_version,
    observe_until: addDays(record.collected_on, rules.recovery.observe_days),
    required_checks: rules.recovery.required_checks.map((name) => ({
      name,
      done: false,
      done_on: null,
    })),
    created_at: ledger.clock(),
  });
  violations.push({
    code: "RECOVERY_PENDING",
    detail: "恢复观察尚未完成，材料先行隔离",
    releasable: true,
  });

  ledger.quarantined.set(stored.record_id, stored);
  ledger.permitsByRecord.set(stored.record_id, permit.id);
  audit(ledger, "harvest.submit", {
    record_id: stored.record_id,
    permit_id: permit.id,
    weight_kg: stored.weight_kg,
    quarantined: true,
  });
  return publicRecord(stored);
}

function withinSeason(dateStr, season) {
  const mmdd = dateStr.slice(5);
  const { start, end } = season;
  if (start <= end) return mmdd >= start && mmdd <= end;
  // 跨年窗口
  return mmdd >= start || mmdd <= end;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 恢复检查回填；当观察期届满且所有检查完成，凭证解除 RECOVERY_PENDING 隔离。
export function completeRecoveryCheck(ledger, { record_id, check_name, done_on }) {
  const task = [...ledger.recoveryTasks.values()].find((t) => t.record_id === record_id);
  if (!task) throw new Error(`找不到 ${record_id} 的恢复任务`);
  const check = task.required_checks.find((c) => c.name === check_name);
  if (!check) throw new Error(`恢复检查项 ${check_name} 不存在`);
  check.done = true;
  check.done_on = done_on ?? todayDate();
  audit(ledger, "recovery.check", { record_id, check_name, done_on: check.done_on });
  return tryReleaseRecovery(ledger, record_id, check.done_on);
}

function tryReleaseRecovery(ledger, recordId, asOf) {
  const task = ledger.recoveryTasks.get(`rec-${recordId}`);
  const stored = ledger.quarantined.get(recordId);
  if (!stored) return { record_id: recordId, status: "released" };
  const allDone = task.required_checks.every((c) => c.done);
  const periodOver = asOf >= task.observe_until;
  if (allDone && periodOver) {
    stored.violations = stored.violations.filter((v) => v.code !== "RECOVERY_PENDING");
    if (stored.violations.length === 0) {
      stored.status = "released";
      ledger.quarantined.delete(recordId);
      ledger.records.set(recordId, stored);
      audit(ledger, "harvest.release", { record_id: recordId });
    } else {
      stored.status = "rejected";
      audit(ledger, "harvest.reject", {
        record_id: recordId,
        violations: stored.violations.map((v) => v.code),
      });
    }
  }
  return publicRecord(stored);
}

export function getRecord(ledger, recordId) {
  const r = ledger.records.get(recordId) ?? ledger.quarantined.get(recordId);
  if (!r) throw new Error(`采材凭证 ${recordId} 不存在`);
  return r;
}

// 管理端可见的凭证（含模糊定位，不含原始坐标）
export function publicRecord(r) {
  return {
    record_id: r.record_id,
    permit_id: r.permit_id,
    forestland_id: r.forestland_id,
    team_id: r.team_id,
    rule_version: r.rule_version,
    collected_on: r.collected_on,
    location_grid: r.location.grid,
    tree_id: r.tree_id,
    weight_kg: r.weight_kg,
    used_kg: round(r.used_kg),
    returned_kg: round(r.returned_kg),
    available_kg: round(r.weight_kg - r.used_kg - r.returned_kg),
    status: r.status,
    violations: r.violations,
    recovery_task_id: r.recovery_task_id,
  };
}

// ---------- 交接 ----------

// 采集队向工坊交接；仅合格（已解除隔离）凭证可交接，按清单核对。
export function handoff(ledger, { handoff_id, permit_id, to_workshop, record_ids, at }) {
  requireFields({ handoff_id, permit_id, to_workshop, record_ids }, [
    "handoff_id",
    "permit_id",
    "to_workshop",
    "record_ids",
  ], "交接单");
  if (!Array.isArray(record_ids) || record_ids.length === 0) throw new Error("交接清单为空");
  if (ledger.handoffs.has(handoff_id)) throw new Error("交接单编号已存在");
  const permit = requirePermit(ledger, permit_id);
  for (const rid of record_ids) {
    const r = ledger.records.get(rid);
    if (!r) throw new Error(`凭证 ${rid} 未通过隔离，不能交接`);
    if (r.permit_id !== permit_id) throw new Error(`凭证 ${rid} 不属于该许可`);
  }
  const doc = {
    handoff_id,
    permit_id,
    from_team: permit.team_id,
    to_workshop,
    record_ids: [...record_ids],
    at: at ?? ledger.clock(),
  };
  ledger.handoffs.set(handoff_id, doc);
  if (!ledger.workshops.has(to_workshop)) {
    ledger.workshops.set(to_workshop, { id: to_workshop, name: to_workshop });
  }
  audit(ledger, "handoff.create", { handoff_id, permit_id, count: record_ids.length });
  return doc;
}

// ---------- 工坊与作品（craft_record.json） ----------

// 登记作品制作者与份额（来自 craft_record.json 契约）。份额之和必须为 1。
export function registerCraft(ledger, { craft_id, makers, permissions = {} }) {
  requireFields({ craft_id, makers }, ["craft_id", "makers"], "作品");
  if (!Array.isArray(makers) || makers.length === 0) throw new Error("制作者列表为空");
  const sum = makers.reduce((s, m) => {
    assertNumber(m.share, "制作者份额");
    return s + m.share;
  }, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error("制作者份额之和必须为 1");
  ledger.craftMakers.set(craft_id, makers.map((m) => ({ maker_id: m.id, share: m.share })));
  audit(ledger, "craft.register", { craft_id, makers: makers.length });
  return { craft_id, makers: ledger.craftMakers.get(craft_id), permissions };
}

// 工坊用料批次：把合格凭证的材料分配到作品。
// input: { batch_id, workshop_id, craft_id, lines:[{record_id, kg}], scrap_kg }
// 守恒：Σ 领料 = 成品占用 product_kg + 边角料 scrap_kg；领料逐笔不得超过凭证可用量。
export function allocateMaterials(ledger, input) {
  requireFields(input, ["batch_id", "workshop_id", "craft_id", "lines"], "用料批次");
  if (ledger.allocations.has(input.batch_id)) throw new Error("批次编号已存在");
  if (!ledger.craftMakers.has(input.craft_id)) throw new Error(`作品 ${input.craft_id} 未登记制作者`);
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error("用料行为空");

  const totalIn = round(input.lines.reduce((s, l) => s + l.kg, 0));
  const scrap = input.scrap_kg ?? 0;
  assertNonNegative(scrap, "边角料重量");
  const product = input.product_kg ?? totalIn - scrap;
  assertNonNegative(product, "成品占用重量");
  if (Math.abs(totalIn - scrap - product) > 1e-6) {
    throw new Error("物料不守恒：领料量必须等于成品占用加边角料");
  }

  // 第一遍：校验所有凭证合格且有足够余量（同一凭证多笔合计）
  const demand = new Map();
  for (const line of input.lines) {
    const r = ledger.records.get(line.record_id);
    if (!r) throw new Error(`凭证 ${line.record_id} 不可用（可能仍在隔离）`);
    assertNumber(line.kg, "领料重量", { positive: true });
    demand.set(line.record_id, (demand.get(line.record_id) ?? 0) + line.kg);
  }
  for (const [rid, kg] of demand) {
    const r = ledger.records.get(rid);
    const available = r.weight_kg - r.used_kg - r.returned_kg;
    if (kg > available + 1e-9) {
      throw new Error(`凭证 ${rid} 可用量不足：需要 ${kg}，仅剩 ${round(available)}`);
    }
  }

  // 第二遍：提交扣减
  const batch = {
    batch_id: input.batch_id,
    workshop_id: input.workshop_id,
    craft_id: input.craft_id,
    lines: input.lines.map((l) => ({ record_id: l.record_id, kg: l.kg })),
    product_kg: product,
    scrap_kg: scrap,
    created_at: ledger.clock(),
  };
  ledger.allocations.set(batch.batch_id, batch);
  const list = ledger.craftBatches.get(input.craft_id) ?? [];
  list.push(batch.batch_id);
  ledger.craftBatches.set(input.craft_id, list);

  for (const [rid, kg] of demand) {
    const r = ledger.records.get(rid);
    r.used_kg = round(r.used_kg + kg);
    const idx = ledger.materialIndex.get(input.craft_id) ?? {};
    idx[rid] = round((idx[rid] ?? 0) + kg);
    ledger.materialIndex.set(input.craft_id, idx);
    const bs = ledger.batchIndex.get(rid) ?? new Set();
    bs.add(batch.batch_id);
    ledger.batchIndex.set(rid, bs);
  }
  audit(ledger, "allocation.create", {
    batch_id: batch.batch_id,
    craft_id: input.craft_id,
    total_in: totalIn,
    product_kg: product,
    scrap_kg: scrap,
  });
  return batchView(batch);
}

// 边角料回收再用：回收料作为新的输入投入另一批次时，由调用方以新批次 lines 引用；
// 这里登记回收凭据，使回收量可核对（回收料来自 scrap，不改变凭证已用量）。
export function recycleScrap(ledger, { batch_id, recycled_kg, into_batch_id }) {
  const batch = requireBatch(ledger, batch_id);
  assertNonNegative(recycled_kg, "回收重量");
  if (recycled_kg > batch.scrap_kg - (batch.recycled_kg ?? 0) + 1e-9) {
    throw new Error("回收量超过该批次边角料");
  }
  batch.recycled_kg = round((batch.recycled_kg ?? 0) + recycled_kg);
  batch.recycled_into = into_batch_id ?? batch.recycled_into ?? null;
  audit(ledger, "scrap.recycle", { batch_id, recycled_kg, into_batch_id });
  return batchView(batch);
}

// 退料：把批次中未实际消耗的材料退回凭证，恢复其可用量；退料守恒。
export function returnMaterials(ledger, { return_id, batch_id, lines, reason = "" }) {
  if (ledger.returns.has(return_id)) throw new Error("退料单编号已存在");
  const batch = requireBatch(ledger, batch_id);
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("退料行为空");
  const byRecord = new Map();
  for (const l of lines) byRecord.set(l.record_id, (byRecord.get(l.record_id) ?? 0) + l.kg);
  for (const [rid, kg] of byRecord) {
    const used = batch.lines.find((x) => x.record_id === rid);
    if (!used) throw new Error(`批次未使用凭证 ${rid}`);
    const already = batch.returns?.[rid] ?? 0;
    if (kg > used.kg - already + 1e-9) throw new Error(`凭证 ${rid} 退料超过批次领用量`);
  }
  const doc = {
    return_id,
    batch_id,
    craft_id: batch.craft_id,
    lines: lines.map((l) => ({ record_id: l.record_id, kg: l.kg })),
    reason,
    at: ledger.clock(),
  };
  ledger.returns.set(return_id, doc);
  batch.returns ??= {};
  for (const [rid, kg] of byRecord) {
    batch.returns[rid] = round((batch.returns[rid] ?? 0) + kg);
    const r = ledger.records.get(rid);
    r.used_kg = round(r.used_kg - kg);
    r.returned_kg = round(r.returned_kg + kg);
    const idx = ledger.materialIndex.get(batch.craft_id);
    idx[rid] = round(idx[rid] - kg);
    if (idx[rid] <= 1e-9) delete idx[rid];
  }
  audit(ledger, "allocation.return", { return_id, batch_id });
  return doc;
}

function requireBatch(ledger, id) {
  const b = ledger.allocations.get(id);
  if (!b) throw new Error(`批次 ${id} 不存在`);
  return b;
}

function batchView(b) {
  return {
    batch_id: b.batch_id,
    workshop_id: b.workshop_id,
    craft_id: b.craft_id,
    lines: b.lines,
    product_kg: b.product_kg,
    scrap_kg: b.scrap_kg,
    recycled_kg: b.recycled_kg ?? 0,
  };
}

// ---------- 公开验真（最小披露） ----------

// 公开验真只给出必要的来源结论：是否合规、林地大区/编号、季节年份、规则版本、制作者，
// 绝不返回格网、树号、队伍、许可编号、坐标等敏感林点信息。
export function publicVerification(ledger, craftId) {
  const makers = ledger.craftMakers.get(craftId);
  if (!makers) throw new Error(`作品 ${craftId} 不存在`);
  const batches = ledger.craftBatches.get(craftId) ?? [];
  const records = traceRecords(ledger, craftId);
  const forestlands = new Set();
  let seasonYears = new Set();
  let ruleVersions = new Set();
  let allCompliant = records.length > 0;
  for (const { record } of records) {
    forestlands.add(`${record.forestland_id}`);
    seasonYears.add(record.collected_on.slice(0, 4));
    ruleVersions.add(record.rule_version);
    if (record.status !== "released") allCompliant = false;
  }
  return {
    craft_id: craftId,
    verdict: allCompliant ? "COMPLIANT" : "INCOMPLETE",
    source_summary: {
      forestland_count: forestlands.size,
      source_years: [...seasonYears].sort(),
      rule_versions: [...ruleVersions].sort(),
      sourced_materials_kg: round(
        records.reduce((s, { consumed_kg }) => s + consumed_kg, 0)
      ),
      distinct_records: records.length,
    },
    makers: makers.map((m) => ({ maker_id: m.maker_id, share: m.share })),
    batches: batches.length,
    // 公开内容不含任何定位、树号、许可与采集队信息
  };
}

// ---------- 审计追溯 ----------

// 从作品追到全部去重后的采材凭证（同一凭证不会因多批次/合制被重复计算）。
export function traceRecords(ledger, craftId) {
  const index = ledger.materialIndex.get(craftId) ?? {};
  return Object.keys(index)
    .sort()
    .map((rid) => {
      const r = getRecord(ledger, rid);
      return { record: publicRecord(r), consumed_kg: round(index[rid]) };
    });
}

// 从任一凭证反向追溯到使用它的作品（防重复计算：每个作品只列一次净用量）。
export function traceRecordToCrafts(ledger, recordId) {
  getRecord(ledger, recordId); // 存在性
  const out = [];
  for (const [craftId, idx] of ledger.materialIndex.entries()) {
    if (idx[recordId]) out.push({ craft_id: craftId, consumed_kg: round(idx[recordId]) });
  }
  return out.sort((a, b) => a.craft_id.localeCompare(b.craft_id));
}

// ---------- 管理对账 ----------

// 按林地与月份核对：实际消耗、退料、隔离中重量、恢复任务、剩余额度。
export function reconciliationReport(ledger, { forestland_id, month } = {}) {
  const rows = [];
  for (const permit of ledger.permits.values()) {
    if (forestland_id && permit.forestland_id !== forestland_id) continue;
    const recs = [...ledger.records.values(), ...ledger.quarantined.values()].filter(
      (r) => r.permit_id === permit.id
    );
    for (const r of recs) {
      const m = r.collected_on.slice(0, 7);
      if (month && m !== month) continue;
      rows.push({
        month: m,
        forestland_id: permit.forestland_id,
        permit_id: permit.id,
        record_id: r.record_id,
        harvested_kg: r.weight_kg,
        consumed_kg: round(r.used_kg),
        returned_kg: round(r.returned_kg),
        stock_kg: round(r.weight_kg - r.used_kg - r.returned_kg),
        status: r.status,
      });
    }
  }
  const byMonthForest = new Map();
  for (const row of rows) {
    const key = `${row.forestland_id}|${row.month}`;
    const agg = byMonthForest.get(key) ?? {
      forestland_id: row.forestland_id,
      month: row.month,
      harvested_kg: 0,
      consumed_kg: 0,
      returned_kg: 0,
      stock_kg: 0,
      quarantined_kg: 0,
      records: 0,
    };
    agg.harvested_kg = round(agg.harvested_kg + row.harvested_kg);
    agg.consumed_kg = round(agg.consumed_kg + row.consumed_kg);
    agg.returned_kg = round(agg.returned_kg + row.returned_kg);
    agg.stock_kg = round(agg.stock_kg + row.stock_kg);
    if (row.status !== "released") agg.quarantined_kg = round(agg.quarantined_kg + row.stock_kg);
    agg.records += 1;
    byMonthForest.set(key, agg);
  }

  const openRecovery = [...ledger.recoveryTasks.values()]
    .filter((t) => {
      if (forestland_id && t.forestland_id !== forestland_id) return false;
      const r = ledger.quarantined.get(t.record_id);
      return Boolean(r); // 仍在隔离即任务未闭环
    })
    .map((t) => ({
      record_id: t.record_id,
      forestland_id: t.forestland_id,
      observe_until: t.observe_until,
      pending_checks: t.required_checks.filter((c) => !c.done).map((c) => c.name),
    }));

  const quota = [...ledger.permits.values()]
    .filter((p) => !forestland_id || p.forestland_id === forestland_id)
    .map(publicPermit);

  return {
    groups: [...byMonthForest.values()].sort((a, b) =>
      `${a.forestland_id}${a.month}`.localeCompare(`${b.forestland_id}${b.month}`)
    ),
    open_recovery_tasks: openRecovery,
    permits: quota,
  };
}

// ---------- 物料守恒自检 ----------

export function assertConservation(ledger) {
  // 1) 每张合格凭证：采材量 = 已用 + 退料 + 库存
  for (const r of ledger.records.values()) {
    const stock = r.weight_kg - r.used_kg - r.returned_kg;
    if (stock < -1e-6) throw new Error(`凭证 ${r.record_id} 用量超发`);
  }
  // 2) 作品物料索引合计 = 各批次领料净额（扣退料），且无凭证重复计入
  for (const [craftId, idx] of ledger.materialIndex.entries()) {
    let fromBatches = 0;
    for (const batchId of ledger.craftBatches.get(craftId) ?? []) {
      const b = ledger.allocations.get(batchId);
      for (const line of b.lines) fromBatches += line.kg;
    }
    for (const ret of ledger.returns.values()) {
      if (ret.craft_id !== craftId) continue;
      for (const l of ret.lines) fromBatches -= l.kg;
    }
    const fromIndex = Object.values(idx).reduce((s, v) => s + v, 0);
    if (Math.abs(fromBatches - fromIndex) > 1e-6) {
      throw new Error(`作品 ${craftId} 物料索引与批次台账不一致`);
    }
  }
  // 3) 许可：已申领额度不超过总量
  for (const p of ledger.permits.values()) {
    if (p.allocated_quota_kg > p.total_quota_kg + 1e-9) {
      throw new Error(`许可 ${p.id} 突破总量`);
    }
  }
  return true;
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

// ---------- 凭据指纹（防篡改，不暴露内容） ----------

export function fingerprintOf(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

export { randomUUID, timingSafeEqual };
