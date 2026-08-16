import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STANDARD_LIBRARY,
  changedElementNames,
  compareElementInventories,
  compareFeatureScriptVersions,
  importReleases,
  matchChangelogRelease,
  parseChangelog,
  releaseFilename,
  validateFeatureStudioSource,
} from "../tools/import.mjs";

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Mirror Test",
      GIT_AUTHOR_EMAIL: "mirror@example.com",
      GIT_COMMITTER_NAME: "Mirror Test",
      GIT_COMMITTER_EMAIL: "mirror@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function inventory(version, commonMicroversion) {
  return [
    { id: `common-${version}`, name: "common.fs", elementType: "FEATURESTUDIO", dataType: "onshape/featurestudio", microversionId: commonMicroversion },
    ...Array.from({ length: 249 }, (_, index) => ({
      id: `file-${index}`,
      name: `file${String(index).padStart(3, "0")}.fs`,
      elementType: "FEATURESTUDIO",
      dataType: "onshape/featurestudio",
      microversionId: `unchanged-${index}`,
    })),
    { id: "readme", name: "README", elementType: "BLOB", dataType: "application/pdf", microversionId: "readme" },
    { id: "license", name: "LICENSE", elementType: "BLOB", dataType: "application/pdf", microversionId: "license" },
  ];
}

async function mirrorFixture() {
  const repo = await mkdtemp(join(tmpdir(), "stdlib-import-test-"));
  git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await writeFile(join(repo, "common.fs"), "FeatureScript 1999;\n");
  for (let index = 0; index < 249; index += 1) {
    await writeFile(join(repo, `file${String(index).padStart(3, "0")}.fs`), "FeatureScript 1999;\n");
  }
  await writeFile(join(repo, "README.pdf"), "readme");
  await writeFile(join(repo, "LICENSE.pdf"), "license");
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-m", "Version 1999.0\n\nversion id: version-1999"]);
  return repo;
}

function fakeClient({ failDownload = false, workspaceDrift = false } = {}) {
  const previous = inventory("1999", "common-1999");
  const current = inventory("2000", "common-2000");
  const versions = Array.from({ length: 100 }, (_, index) => {
    const number = 1901 + index;
    return {
      name: `${number}.0`,
      id: `version-${number}`,
      parent: `version-${number - 1}`,
      microversion: `microversion-${number}`,
      createdAt: number === 2000 ? "2026-08-07T11:21:42Z" : "2020-01-01T00:00:00Z",
    };
  });
  const calls = [];
  return {
    calls,
    async request(path) {
      calls.push(path);
      if (path.endsWith("/versions")) return versions;
      if (path.endsWith("/v/version-2000/elements")) return current;
      if (path.endsWith("/v/version-1999/elements")) return previous;
      if (path.endsWith("/workspaces")) {
        return [{ id: STANDARD_LIBRARY.workspaceId, parent: "version-2000", modifiedAt: "2026-08-07T11:21:42Z" }];
      }
      if (path.endsWith(`/w/${STANDARD_LIBRARY.workspaceId}/elements`)) {
        return workspaceDrift
          ? current.map((element) => element.name === "common.fs" ? { ...element, microversionId: "workspace-only" } : element)
          : current;
      }
      if (workspaceDrift && path.includes(`/w/${STANDARD_LIBRARY.workspaceId}/`) && path.endsWith("/e/common-2000")) {
        return { contents: "FeatureScript 2001;\n" };
      }
      if (path.includes("/featurestudios/") && path.endsWith("/e/common-2000")) {
        if (failDownload) throw new Error("simulated download failure");
        return { contents: "FeatureScript 2000;\n" };
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    },
  };
}

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

test("accepts exact 21-day releases and a 28-day holiday gap", () => {
  const entries = [
    { release: "1.219", date: "2026-08-07" },
    { release: "1.218", date: "2026-07-17" },
    { release: "1.217", date: "2026-06-26" },
    { release: "1.216", date: "2026-05-29" },
  ];
  assert.equal(matchChangelogRelease({ createdAt: "2026-07-17T11:00:00Z" }, entries).release, "1.218");
  assert.equal(matchChangelogRelease({ createdAt: "2026-05-29T11:00:00Z" }, entries).release, "1.216");
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

test("downloads only added or microversion-changed elements", () => {
  const previous = [
    { name: "common.fs", elementType: "FEATURESTUDIO", dataType: "onshape/featurestudio", microversionId: "a" },
    { name: "query.fs", elementType: "FEATURESTUDIO", dataType: "onshape/featurestudio", microversionId: "b" },
    { name: "README", elementType: "BLOB", dataType: "application/pdf", microversionId: "c" },
  ];
  const current = [
    { ...previous[0], microversionId: "d" },
    previous[1],
    previous[2],
    { name: "new.fs", elementType: "FEATURESTUDIO", dataType: "onshape/featurestudio", microversionId: "e" },
  ];
  assert.deepEqual(changedElementNames(previous, current), ["common.fs", "new.fs"]);
});

test("incremental import is idempotent and fetches only changed content", async (context) => {
  const repo = await mirrorFixture();
  context.after(() => rm(repo, { recursive: true, force: true }));
  const client = fakeClient();
  const html = changelogHtml(historicalEntries);
  const first = await importReleases({ repo, client, changelogHtml: html });
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].downloadedElements, 1);
  assert.equal(first.imported[0].reusedElements, 251);
  assert.equal(await readFile(join(repo, "common.fs"), "utf8"), "FeatureScript 2000;\n");
  const firstHead = git(repo, ["rev-parse", "HEAD"]);
  const advancedChangelog = changelogHtml([{ release: "1.220", date: "2026-08-28" }, ...historicalEntries]);
  const second = await importReleases({ repo, client, changelogHtml: advancedChangelog });
  assert.deepEqual(second.imported, []);
  assert.equal(second.latestChangelog.release, "1.220");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), firstHead);
  assert.equal(client.calls.filter((path) => path.includes("/featurestudios/")).length, 1);
});

test("a named version without changelog confirmation requires attention", async (context) => {
  const repo = await mirrorFixture();
  context.after(() => rm(repo, { recursive: true, force: true }));
  const unrelated = historicalEntries.map((entry) => ({ ...entry, date: entry.date.replace("2026", "2024") }));
  await assert.rejects(
    importReleases({ repo, client: fakeClient(), changelogHtml: changelogHtml(unrelated) }),
    /not confirmed by the Onshape changelog/,
  );
});

test("workspace-only drift requires attention and is never imported", async (context) => {
  const repo = await mirrorFixture();
  context.after(() => rm(repo, { recursive: true, force: true }));
  const head = git(repo, ["rev-parse", "HEAD"]);
  await assert.rejects(
    importReleases({ repo, client: fakeClient({ workspaceDrift: true }), changelogHtml: changelogHtml(historicalEntries) }),
    /workspace differs from the latest named standard-library version/,
  );
  assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
});

test("a partial download failure leaves the mirror checkout untouched", async (context) => {
  const repo = await mirrorFixture();
  context.after(() => rm(repo, { recursive: true, force: true }));
  const head = git(repo, ["rev-parse", "HEAD"]);
  await assert.rejects(
    importReleases({ repo, client: fakeClient({ failDownload: true }), changelogHtml: changelogHtml(historicalEntries) }),
    /simulated download failure/,
  );
  assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(await readFile(join(repo, "common.fs"), "utf8"), "FeatureScript 1999;\n");
});
