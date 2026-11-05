import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../../scripts/deploy-contract.ts";

test("SessionRoot compiles with record and rootOf", () => {
  const { abi, bytecode } = compile();
  const names = (abi as { name?: string }[]).map((x) => x.name);
  assert.ok(names.includes("record") && names.includes("rootOf") && names.includes("SessionRecorded"));
  assert.ok(bytecode.length > 100);
});
