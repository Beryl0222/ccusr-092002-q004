import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { healthPayload, serviceId } from "../src/service.js";

test("服务身份稳定", () => {
  assert.equal(healthPayload().service, serviceId);
});

test("领域样例与服务一致", async () => {
  const raw = await readFile(new URL("../contracts/craft_record.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, serviceId);
  assert.ok(data.sample);
});
