#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const STANDARD_LIBRARY = Object.freeze({
  documentId: "12312312345abcabcabcdeff",
  workspaceId: "a855e4161c814f2e9ab3698a",
  changelogUrl: "https://www.onshape.com/en/changelog/",
  apiBase: "https://cad.onshape.com/api/v13",
});

const IMPORTER_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "Onshape Standard Library Importer",
  GIT_AUTHOR_EMAIL: "automation@gatrall.dev",
  GIT_COMMITTER_NAME: "Onshape Standard Library Importer",
  GIT_COMMITTER_EMAIL: "automation@gatrall.dev",
});

export class AttentionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AttentionError";
    this.attention = true;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonce(length = 25) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export function signOnshapeRequest({ method, url, accessKey, secretKey, date, requestNonce }) {
  const timestamp = date ?? new Date().toUTCString();
  const onNonce = requestNonce ?? nonce();
  const contentType = "application/json";
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const signatureString = `${method.toUpperCase()}\n${onNonce}\n${timestamp}\n${contentType}\n${url.pathname}\n${query}\n`.toLowerCase();
  const signature = createHmac("sha256", secretKey).update(signatureString, "utf8").digest("base64");
  return {
    Date: timestamp,
    "On-Nonce": onNonce,
    "Content-Type": contentType,
    Authorization: `On ${accessKey}:HmacSHA256:${signature}`,
  };
}

export class OnshapeClient {
  constructor({ accessKey, secretKey, apiBase = STANDARD_LIBRARY.apiBase, retries = 3 }) {
    if (!accessKey || !secretKey) {
      throw new Error("Missing ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY.");
    }
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.apiBase = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
    this.retries = retries;
  }

  async request(path, { binary = false } = {}) {
    const url = new URL(path.replace(/^\//, ""), this.apiBase);
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        headers: signOnshapeRequest({
          method: "GET",
          url,
          accessKey: this.accessKey,
          secretKey: this.secretKey,
        }),
      });
      if (response.status === 429 && attempt < this.retries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
        await new Promise((accept) => setTimeout(accept, delay));
        continue;
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Onshape API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
      }
      if (binary) {
        return Buffer.from(await response.arrayBuffer());
      }
      return response.json();
    }
  }
}

export function parseChangelog(html) {
  const releases = [...html.matchAll(/<h2[^>]*>\s*(1\.\d+)\s*<span[^>]*>\s*- released (\d{4}-\d{2}-\d{2})<\/span>/g)]
    .map((match) => ({ release: match[1], date: match[2] }));
  if (releases.length < 20) {
    throw new Error(`Onshape changelog parse returned only ${releases.length} releases.`);
  }
  for (const release of releases) {
    if (Number.isNaN(Date.parse(`${release.date}T00:00:00Z`))) {
      throw new Error(`Invalid changelog date for ${release.release}: ${release.date}`);
    }
  }
  return releases;
}

function dateDistanceDays(left, right) {
  return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}

export function matchChangelogRelease(version, changelog, toleranceDays = 7) {
  const versionDate = version.createdAt.slice(0, 10);
  return changelog
    .map((release) => ({ ...release, distanceDays: dateDistanceDays(versionDate, release.date) }))
    .filter((release) => release.distanceDays <= toleranceDays)
    .sort((a, b) => a.distanceDays - b.distanceDays || b.date.localeCompare(a.date))[0];
}

export function compareFeatureScriptVersions(left, right) {
  const parse = (value) => value.split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function validateFeatureStudioSource(source, version, filename) {
  const major = Number(version.split(".")[0]);
  const declaration = /^FeatureScript\s+(\d+(?:\.\d+)?);/m.exec(source)?.[1];
  if (!declaration || Number(declaration) > major) {
    throw new Error(`${filename} declares future or missing FeatureScript ${declaration ?? "missing"}; release is ${version}.`);
  }
  for (const match of source.matchAll(/version\s*:\s*"(\d+\.\d+)"/g)) {
    if (compareFeatureScriptVersions(match[1], version) > 0) {
      throw new Error(`${filename} imports future standard library ${match[1]}; release is ${version}.`);
    }
  }
}

export function releaseFilename(element) {
  const name = element.name;
  if (typeof name !== "string" || name.length === 0 || basename(name) !== name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`Unsafe or empty Onshape element name: ${String(name)}`);
  }
  if (element.elementType === "FEATURESTUDIO") return name;
  if (element.elementType !== "BLOB") {
    throw new Error(`Unsupported Onshape element type for ${name}: ${element.elementType}`);
  }
  if (element.dataType === "application/pdf") return `${name}.pdf`;
  if (element.dataType === "text/plain") return `${name}.txt`;
  throw new Error(`Unsupported blob type for ${name}: ${element.dataType}`);
}

function elementArray(value, label) {
  const entries = Array.isArray(value) ? value : value?.items ?? value?.elements;
  if (!Array.isArray(entries)) throw new Error(`${label} response was not an array.`);
  return entries;
}

export function compareElementInventories(workspaceElements, versionElements) {
  const versionByName = new Map(versionElements.map((element) => [element.name, element]));
  const workspaceByName = new Map(workspaceElements.map((element) => [element.name, element]));
  const changed = [];
  for (const name of new Set([...workspaceByName.keys(), ...versionByName.keys()])) {
    const workspace = workspaceByName.get(name);
    const version = versionByName.get(name);
    if (!workspace || !version || workspace.elementType !== version.elementType || workspace.dataType !== version.dataType || workspace.microversionId !== version.microversionId) {
      changed.push({ name, workspace, version });
    }
  }
  return changed.sort((a, b) => a.name.localeCompare(b.name));
}

function runGit(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function currentMirrorVersion(repo) {
  const common = runGit(repo, ["show", "HEAD:common.fs"]);
  const match = /^FeatureScript\s+(\d+(?:\.\d+)?);/m.exec(common);
  if (!match) throw new Error("Unable to determine mirror version from common.fs.");
  return match[1].includes(".") ? match[1] : `${match[1]}.0`;
}

function currentMirrorVersionId(repo) {
  const body = runGit(repo, ["log", "-1", "--format=%B"]);
  const match = /^version id:\s*(\S+)/m.exec(body);
  if (!match) throw new Error("Unable to determine canonical version ID from the latest mirror commit.");
  return match[1];
}

function validateVersionChain(pending, currentVersionId) {
  let expectedParent = currentVersionId;
  for (const version of pending) {
    if (version.parent !== expectedParent) {
      throw new AttentionError(`Canonical version chain is not linear at ${version.name}.`, {
        version: version.name,
        expectedParent,
        actualParent: version.parent,
      });
    }
    expectedParent = version.id;
  }
}

async function mapConcurrent(values, concurrency, fn) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function fetchElementContent(client, selector, element) {
  const prefix = `/d/${STANDARD_LIBRARY.documentId}/${selector}/e/${element.id}`;
  if (element.elementType === "FEATURESTUDIO") {
    const response = await client.request(`/featurestudios${prefix}`);
    if (typeof response.contents !== "string") throw new Error(`Feature Studio ${element.name} has no contents.`);
    return Buffer.from(response.contents, "utf8");
  }
  return client.request(`/blobelements${prefix}`, { binary: true });
}

async function downloadRelease(client, version) {
  const selector = `v/${version.id}`;
  const rawElements = await client.request(`/documents/d/${STANDARD_LIBRARY.documentId}/${selector}/elements`);
  const elements = elementArray(rawElements, `${version.name} elements`);
  const featureStudios = elements.filter((element) => element.elementType === "FEATURESTUDIO");
  const blobs = elements.filter((element) => element.elementType === "BLOB");
  if (featureStudios.length < 250 || blobs.length !== 2 || elements.length !== featureStudios.length + blobs.length) {
    throw new Error(`${version.name} has unexpected inventory: ${featureStudios.length} Feature Studios, ${blobs.length} blobs, ${elements.length} total.`);
  }
  const filenames = elements.map(releaseFilename);
  if (new Set(filenames).size !== filenames.length) throw new Error(`${version.name} contains duplicate output filenames.`);
  const directory = await mkdtemp(join(tmpdir(), `onshape-stdlib-${version.name}-`));
  try {
    await mapConcurrent(elements, 8, async (element, index) => {
      const content = await fetchElementContent(client, selector, element);
      if (element.elementType === "FEATURESTUDIO") {
        validateFeatureStudioSource(content.toString("utf8"), version.name, filenames[index]);
      }
      await writeFile(join(directory, filenames[index]), content);
    });
    const common = await readFile(join(directory, "common.fs"), "utf8");
    const commonVersion = /^FeatureScript\s+(\d+(?:\.\d+)?);/m.exec(common)?.[1];
    const normalizedCommonVersion = commonVersion?.includes(".") ? commonVersion : `${commonVersion}.0`;
    if (normalizedCommonVersion !== version.name) {
      throw new Error(`${version.name} common.fs declares FeatureScript ${commonVersion ?? "missing"}.`);
    }
    return { directory, elements, featureStudios: featureStudios.length, blobs: blobs.length };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function replaceReleaseTree(repo, releaseDirectory) {
  const tracked = runGit(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of tracked) {
    if (path !== "README.md") await rm(join(repo, path), { force: true, recursive: false });
  }
  for (const name of await readdir(releaseDirectory)) {
    await copyFile(join(releaseDirectory, name), join(repo, name));
  }
}

async function commitRelease(repo, version, changelogRelease, release) {
  await replaceReleaseTree(repo, release.directory);
  runGit(repo, ["add", "--all"]);
  const message = [
    `Version ${version.name}`,
    "",
    `version id: ${version.id}`,
    `parent: ${version.parent}`,
    `microversion: ${version.microversion}`,
    `created at: ${version.createdAt}`,
    `changelog: ${changelogRelease.release} (${changelogRelease.date})`,
  ].join("\n");
  const date = version.createdAt;
  runGit(repo, ["commit", "-m", message], {
    env: {
      ...IMPORTER_IDENTITY,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

async function hashChangedElement(client, selector, element) {
  if (!element) return null;
  return sha256(await fetchElementContent(client, selector, element));
}

async function checkWorkspaceDrift(client, latestVersion) {
  const workspacesRaw = await client.request(`/documents/d/${STANDARD_LIBRARY.documentId}/workspaces`);
  const workspaces = elementArray(workspacesRaw, "workspaces");
  const workspace = workspaces.find((entry) => entry.id === STANDARD_LIBRARY.workspaceId);
  if (!workspace) throw new Error(`Canonical workspace ${STANDARD_LIBRARY.workspaceId} was not found.`);
  const [workspaceRaw, versionRaw] = await Promise.all([
    client.request(`/documents/d/${STANDARD_LIBRARY.documentId}/w/${STANDARD_LIBRARY.workspaceId}/elements`),
    client.request(`/documents/d/${STANDARD_LIBRARY.documentId}/v/${latestVersion.id}/elements`),
  ]);
  const workspaceElements = elementArray(workspaceRaw, "workspace elements");
  const versionElements = elementArray(versionRaw, "version elements");
  const changed = compareElementInventories(workspaceElements, versionElements);
  if (workspace.parent !== latestVersion.id || changed.length > 0) {
    const details = await mapConcurrent(changed, 4, async (entry) => ({
      name: entry.name,
      workspaceSha256: await hashChangedElement(client, `w/${STANDARD_LIBRARY.workspaceId}`, entry.workspace),
      versionSha256: await hashChangedElement(client, `v/${latestVersion.id}`, entry.version),
    }));
    throw new AttentionError("The canonical workspace differs from the latest named standard-library version.", {
      workspaceParent: workspace.parent,
      latestVersionId: latestVersion.id,
      workspaceModifiedAt: workspace.modifiedAt,
      changedElements: details,
    });
  }
  return {
    parent: workspace.parent,
    modifiedAt: workspace.modifiedAt,
    featureStudios: workspaceElements.filter((element) => element.elementType === "FEATURESTUDIO").length,
    blobs: workspaceElements.filter((element) => element.elementType === "BLOB").length,
  };
}

export async function importReleases({ repo, client, changelogHtml, dryRun = false }) {
  const absoluteRepo = resolve(repo);
  const status = runGit(absoluteRepo, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Mirror checkout must be clean before importing releases.");
  const branch = runGit(absoluteRepo, ["branch", "--show-current"]).trim();
  if (branch !== "main") throw new Error(`Mirror checkout must be on main, not ${branch || "detached HEAD"}.`);

  const changelog = parseChangelog(changelogHtml);
  const versionsRaw = await client.request(`/documents/d/${STANDARD_LIBRARY.documentId}/versions`);
  const versions = elementArray(versionsRaw, "versions").filter((version) => /^\d+\.0$/.test(version.name));
  if (versions.length < 100) throw new Error(`Canonical version list returned only ${versions.length} numeric releases.`);
  const latestVersion = versions.at(-1);
  const mirrorVersion = currentMirrorVersion(absoluteRepo);
  const mirrorVersionId = currentMirrorVersionId(absoluteRepo);
  const pending = versions.filter((version) => compareFeatureScriptVersions(version.name, mirrorVersion) > 0);
  validateVersionChain(pending, mirrorVersionId);

  const matched = pending.map((version) => ({ version, changelog: matchChangelogRelease(version, changelog) }));
  const unconfirmed = matched.filter((entry) => !entry.changelog);
  if (unconfirmed.length > 0) {
    throw new AttentionError("Named FeatureScript releases are not confirmed by the Onshape changelog.", {
      mirrorVersion,
      unconfirmed: unconfirmed.map((entry) => ({ name: entry.version.name, createdAt: entry.version.createdAt, id: entry.version.id })),
      latestChangelog: changelog[0],
    });
  }

  const workspace = await checkWorkspaceDrift(client, latestVersion);
  const imported = [];
  const downloads = [];
  try {
    for (const entry of matched) {
      const release = await downloadRelease(client, entry.version);
      downloads.push(release.directory);
      if (!dryRun) await commitRelease(absoluteRepo, entry.version, entry.changelog, release);
      imported.push({
        version: entry.version.name,
        versionId: entry.version.id,
        changelog: entry.changelog,
        featureStudios: release.featureStudios,
        blobs: release.blobs,
      });
    }
  } finally {
    await Promise.all(downloads.map((directory) => rm(directory, { recursive: true, force: true })));
  }

  return {
    ok: true,
    dryRun,
    mirrorVersionBefore: mirrorVersion,
    canonicalVersion: latestVersion.name,
    canonicalVersionId: latestVersion.id,
    latestChangelog: changelog[0],
    workspace,
    imported,
  };
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") args.repo = argv[++index];
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--json") args.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.repo) throw new Error("Usage: import.mjs --repo <main-checkout> [--dry-run] [--json]");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const changelogResponse = await fetch(STANDARD_LIBRARY.changelogUrl);
  if (!changelogResponse.ok) throw new Error(`Changelog request failed: ${changelogResponse.status} ${changelogResponse.statusText}`);
  const client = new OnshapeClient({
    accessKey: process.env.ONSHAPE_ACCESS_KEY,
    secretKey: process.env.ONSHAPE_SECRET_KEY,
  });
  return importReleases({
    repo: args.repo,
    client,
    changelogHtml: await changelogResponse.text(),
    dryRun: args.dryRun,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const result = {
      ok: false,
      attention: error?.attention === true,
      message: error instanceof Error ? error.message : String(error),
      details: error?.details ?? {},
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = error?.attention === true ? 2 : 1;
  }
}
