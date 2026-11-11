import test from "node:test";
import assert from "node:assert/strict";
import { cleanIds, DeleteInputError, describePlanRefusal, planPermanentDelete } from "../src/delete.js";

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

test("is_trash must be the boolean true: strings, numbers and null never qualify", () => {
  for (const flag of ["true", "false", 1, 0, null, undefined, "1"]) {
    const plan = planPermanentDelete(["x"], [{ id: "x", filename: "f", is_trash: flag }]);
    assert.equal(plan.deletable.length, 0, `is_trash=${JSON.stringify(flag)} must not be deletable`);
    assert.equal(plan.notInTrash.length, 1);
  }
  assert.equal(planPermanentDelete(["x"], [{ id: "x", is_trash: true }]).deletable.length, 1);
});

test("ids are cleaned once; odd ids are refused; conflicting duplicate records are not deletable", () => {
  assert.deepEqual(cleanIds(["a", "", "  ", "a", "b"]), ["a", "b"]);
  for (const bad of [" a", "a ", "a b", "a,b", "a\n"]) assert.throws(() => cleanIds([bad]), DeleteInputError, JSON.stringify(bad));
  const plan = planPermanentDelete(["x"], [{ id: "x", filename: "f", is_trash: true }, { id: "x", filename: "f", is_trash: false }]);
  assert.equal(plan.deletable.length, 0, "disagreeing copies are refused");
  const plan2 = planPermanentDelete(["x"], [{ id: "x", filename: "f", is_trash: false }, { id: "x", filename: "f", is_trash: true }]);
  assert.equal(plan2.deletable.length, 0, "order does not matter");
});
