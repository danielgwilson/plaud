import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateBody, buildUpdateBody, findFolder, FolderInputError, normalizeColor } from "../src/folders.js";

const folders = [
  { id: "a1", name: "Interviews", icon: "e675", color: "#c149eb" },
  { id: "b2", name: "Board", icon: "e64a", color: "#ffaa5c" },
  { id: "c3", name: "board", icon: "e64a", color: "#ffaa5c" },
  { id: "x9", name: "b2", icon: "e64a", color: "#ffaa5c" },
];

test("create body trims the name and applies web app defaults", () => {
  assert.deepEqual(buildCreateBody("  Hiring "), { name: "Hiring", icon: "e674", color: "#c149eb" });
  assert.deepEqual(buildCreateBody("X", "e600", "#AABBCC"), { name: "X", icon: "e600", color: "#aabbcc" });
  assert.throws(() => buildCreateBody(" "), FolderInputError);
  assert.throws(() => buildCreateBody("X", undefined, "blue"), /#c149eb/);
  assert.equal(normalizeColor("#FFAA5C"), "#ffaa5c");
  assert.throws(() => normalizeColor("#fff"), FolderInputError);
});

test("update body keeps whatever the caller did not change", () => {
  assert.deepEqual(buildUpdateBody(folders[0], { name: "Hiring" }), { name: "Hiring", icon: "e675", color: "#c149eb" });
  assert.deepEqual(buildUpdateBody(folders[0], { color: "#000000" }), { name: "Interviews", icon: "e675", color: "#000000" });
  assert.throws(() => buildUpdateBody(folders[0], {}), /Nothing to change/);
  assert.deepEqual(buildUpdateBody({ id: "z", name: "N" }, { name: "M" }), { name: "M", icon: "e674", color: "#c149eb" });
});

test("findFolder resolves by id or exact name and refuses ambiguity", () => {
  assert.equal(findFolder(folders, "a1").name, "Interviews");
  assert.equal(findFolder(folders, "interviews").id, "a1");
  assert.throws(() => findFolder(folders, "board"), /More than one/);
  assert.equal(findFolder(folders, "b2").id, "b2", "an id always wins over a folder named like that id");
  assert.throws(() => findFolder(folders, "nope"), /No folder/);
});
