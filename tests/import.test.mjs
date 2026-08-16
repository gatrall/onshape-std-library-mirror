import assert from "node:assert/strict";
import test from "node:test";

import {
  compareElementInventories,
  compareFeatureScriptVersions,
  matchChangelogRelease,
  parseChangelog,
  releaseFilename,
  validateFeatureStudioSource,
} from "../tools/import.mjs";

function changelogHtml(entries) {
  return entries.map(({ release, date }) => `<h2>${release}<span> - released ${date}</span></h2>`).join("\n");
}

const historicalEntries = Array.from({ length: 20 }, (_, index) => ({
  release: `1.${219 - index}`,
  date: new Date(Date.UTC(2026, 7, 7 - index * 21)).toISOString().slice(0, 10),
}));

test("parses a structurally valid changelog", () => {
  const parsed = parseChangelog(changelogHtml(historicalEntries));
  assert.equal(parsed.length, 20);
  assert.deepEqual(parsed[0], historicalEntries[0]);
});

test("rejects a malformed or unexpectedly short changelog", () => {
  assert.throws(() => parseChangelog("<h1>Onshape Changelog</h1>"), /only 0 releases/);
});

test("matches same-day Friday releases", () => {
  const match = matchChangelogRelease({ createdAt: "2026-08-07T11:21:42Z" }, historicalEntries);
  assert.equal(match.release, "1.219");
  assert.equal(match.distanceDays, 0);
});

test("matches Thursday and delayed changelog releases within seven days", () => {
  const entries = [{ release: "1.197", date: "2025-04-29" }];
  const match = matchChangelogRelease({ createdAt: "2025-04-25T20:00:00Z" }, entries);
  assert.equal(match.release, "1.197");
  assert.equal(match.distanceDays, 4);
  assert.equal(matchChangelogRelease({ createdAt: "2025-04-18T20:00:00Z" }, entries), undefined);
});

test("compares FeatureScript versions numerically", () => {
  assert.ok(compareFeatureScriptVersions("3044.0", "2960.0") > 0);
  assert.equal(compareFeatureScriptVersions("3044", "3044.0"), 0);
});

test("validates source and import versions", () => {
  validateFeatureStudioSource('FeatureScript 3044;\nimport(path : "onshape/std/query.fs", version : "3044.0");', "3044.0", "fixture.fs");
  validateFeatureStudioSource('FeatureScript 2985;\nimport(path : "onshape/std/query.fs", version : "2985.0");', "3044.0", "unchanged.fs");
  assert.throws(
    () => validateFeatureStudioSource('FeatureScript 3044;\nimport(path : "onshape/std/query.fs", version : "3050.0");', "3044.0", "fixture.fs"),
    /imports future standard library 3050.0/,
  );
});

test("maps only safe supported element names", () => {
  assert.equal(releaseFilename({ name: "query.fs", elementType: "FEATURESTUDIO" }), "query.fs");
  assert.equal(releaseFilename({ name: "README", elementType: "BLOB", dataType: "application/pdf" }), "README.pdf");
  assert.throws(() => releaseFilename({ name: "../query.fs", elementType: "FEATURESTUDIO" }), /Unsafe/);
  assert.throws(() => releaseFilename({ name: "image", elementType: "BLOB", dataType: "image/png" }), /Unsupported blob/);
});

test("detects workspace-only changes by element microversion", () => {
  const version = [{ name: "query.fs", elementType: "FEATURESTUDIO", dataType: "onshape/featurestudio", microversionId: "a" }];
  assert.deepEqual(compareElementInventories(version, version), []);
  const workspace = [{ ...version[0], microversionId: "b" }, { name: "new.fs", elementType: "FEATURESTUDIO", microversionId: "c" }];
  assert.deepEqual(compareElementInventories(workspace, version).map((entry) => entry.name), ["new.fs", "query.fs"]);
});
