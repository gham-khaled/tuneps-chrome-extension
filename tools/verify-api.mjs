#!/usr/bin/env node
/*
 * verify-api.mjs - exercise the extension's API layer against the LIVE Tuneps
 * portal, with no Authorization header of any kind.
 *
 * It loads content/api.js into a vm sandbox, so the URLs it hits are built by
 * exactly the same code the browser runs. If this script passes, the request
 * shapes baked into the extension are correct.
 *
 *   node tools/verify-api.mjs
 *
 * If TLS fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE, the Tuneps chain is
 * incomplete for your trust store. Point Node at a bundle that contains the
 * QuoVadis roots instead of disabling verification:
 *
 *   NODE_EXTRA_CA_CERTS=/path/to/chain.pem node tools/verify-api.mjs
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const apiPath = join(here, "..", "content", "api.js");

const sandbox = { module: { exports: {} }, console, URL, URLSearchParams };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(readFileSync(apiPath, "utf8"), sandbox, { filename: apiPath });

const {
  TDX_TYPE_AO,
  TDX_TYPE_CONSULTATION,
  tdxParseLocation,
  tdxManifestUrls,
  tdxDownloadUrl,
  tdxNormalizeManifest
} = sandbox.module.exports;

const CASES = [
  {
    label: "CONSULTATION S20260703054",
    pageUrl: "https://www.tuneps.tn/portail/consultations/consultationdetails/12345/S20260703054",
    expectNo: "S20260703054",
    expectType: TDX_TYPE_CONSULTATION,
    expectMinFiles: 16,
    nodeRefField: "nodeRef"
  },
  {
    label: "AO 20260800201",
    pageUrl: "https://www.tuneps.tn/portail/offres/details/37466/20260800201/resultatouverture",
    expectNo: "20260800201",
    expectType: TDX_TYPE_AO,
    expectMinFiles: 1,
    nodeRefField: "bidAttNodeRef"
  }
];

let failures = 0;

function check(ok, message, detail) {
  if (ok) {
    console.log(`  PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${message}${detail ? `\n        ${detail}` : ""}`);
  }
  return ok;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, body, text };
}

async function run() {
  console.log("Tuneps API verification (no Authorization header is ever sent)\n");

  for (const c of CASES) {
    console.log(`== ${c.label} ==`);

    const parsed = tdxParseLocation(c.pageUrl);
    check(parsed !== null, "tender number extracted from the page URL");
    check(
      parsed && parsed.tenderNo === c.expectNo,
      `tender number is ${c.expectNo}`,
      parsed ? `got ${parsed.tenderNo}` : "got null"
    );
    check(
      parsed && parsed.type === c.expectType,
      `tender type is ${c.expectType}`,
      parsed ? `got ${parsed.type}` : "got null"
    );
    if (!parsed) {
      console.log("");
      continue;
    }

    const urls = tdxManifestUrls(parsed.tenderNo, parsed.type);
    let manifest = null;
    for (const url of urls) {
      const res = await getJson(url);
      check(res.status === 200, `manifest HTTP 200 from ${url}`, `got ${res.status}`);
      if (res.status === 200 && !manifest) manifest = res.body;
    }
    if (!manifest) {
      console.log("");
      continue;
    }

    let files = [];
    try {
      files = tdxNormalizeManifest(manifest).files;
      check(true, "manifest parsed by tdxNormalizeManifest");
    } catch (err) {
      check(false, "manifest parsed by tdxNormalizeManifest", err.message);
      console.log("");
      continue;
    }

    check(
      files.length >= c.expectMinFiles,
      `at least ${c.expectMinFiles} file(s) listed`,
      `got ${files.length}`
    );
    check(
      files.every((f) => f.downloadable),
      `every row exposes a node reference (${c.nodeRefField})`,
      files.filter((f) => !f.downloadable).map((f) => f.fileName).join(", ")
    );

    for (const f of files.slice(0, 3)) {
      console.log(`        - [${f.seqNo}] ${f.category} | ${f.fileName}`);
    }
    if (files.length > 3) console.log(`        - ... ${files.length - 3} more`);

    const first = files[0];
    const dlUrl = tdxDownloadUrl(first.nodeRef, first.fileName);
    const res = await fetch(dlUrl);
    check(res.status === 200, `download HTTP 200 for "${first.fileName}"`, `got ${res.status}`);
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      check(buf.length > 0, `downloaded ${buf.length} bytes`);
      check(
        buf.subarray(0, 4).toString("latin1") === "%PDF" || buf.length > 1024,
        "downloaded bytes look like a real document",
        `first bytes: ${buf.subarray(0, 8).toString("hex")}`
      );
      console.log(`        sha256 ${createHash("sha256").update(buf).digest("hex")}`);
      console.log(
        `        content-disposition: ${res.headers.get("content-disposition") || "(none)"}`
      );
    }
    console.log("");
  }

  // Negative checks: the two parameter mistakes that silently break downloads.
  console.log("== parameter contract ==");
  const sample = tdxDownloadUrl("db0153fe-b0af-41a2-a485-55aaac5eb4b4;1.0", "fiche technique - article 1.pdf");
  const okRes = await fetch(sample);
  check(okRes.status === 200, "lowercase noderef + fileName returns 200", `got ${okRes.status}`);

  const camel = sample.replace("noderef=", "nodeRef=");
  const camelRes = await fetch(camel);
  check(camelRes.status === 400, "camelCase nodeRef is rejected (400)", `got ${camelRes.status}`);

  const noName = sample.replace(/&fileName=.*$/, "");
  const noNameRes = await fetch(noName);
  check(noNameRes.status === 400, "missing fileName is rejected (400)", `got ${noNameRes.status}`);

  console.log("");
  if (failures === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failures} check(s) failed.`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("\nVerification aborted:", err && err.message ? err.message : err);
  if (String(err && err.message).includes("certificate")) {
    console.error(
      "Hint: the Tuneps TLS chain may be incomplete for your trust store. Retry with\n" +
        "  NODE_EXTRA_CA_CERTS=/path/to/chain.pem node tools/verify-api.mjs"
    );
  }
  process.exitCode = 1;
});
