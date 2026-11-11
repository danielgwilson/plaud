import test from "node:test";
import assert from "node:assert/strict";
import { DeleteInputError, describePlanRefusal, planPermanentDelete } from "../src/delete.js";

const details = [
  { id: "a", filename: "In trash", is_trash: true },
  { id: "b", filename: "Active", is_trash: false },
  { id: "c", filename: "Flag missing" },
];

test("only files whose is_trash is exactly true are deletable", () => {
  const plan = planPermanentDelete(["a", "b", "c", "zzz", "a"], details);
  assert.deepEqual(plan.deletable, [{ id: "a", name: "In trash" }]);
  assert.deepEqual(plan.notInTrash.map((f) => f.id), ["b", "c"], "a missing flag counts as not in the trash");
  assert.deepEqual(plan.notFound, ["zzz"]);
  assert.throws(() => planPermanentDelete([], details), DeleteInputError);
  assert.throws(() => planPermanentDelete(["", "  "], details), DeleteInputError);
});

test("refusal text names what blocked the delete", () => {
  assert.equal(describePlanRefusal(planPermanentDelete(["a"], details)), null);
  assert.match(describePlanRefusal(planPermanentDelete(["a", "b"], details))!, /b \("Active"\) is not in the trash/);
  assert.match(describePlanRefusal(planPermanentDelete(["zzz"], details))!, /no recording found for zzz/);
});
