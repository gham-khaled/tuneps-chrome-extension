#!/usr/bin/env node
/*
 * test-api.mjs - offline unit tests for content/api.js.
 *
 *   node --test tools/test-api.mjs tools/test-panel.mjs
 *   node tools/test-api.mjs
 *
 * No network, no dependencies. Covers URL parsing, endpoint building, and the
 * manifest shapes that differ between AO and consultation tenders, plus the
 * malformed payloads the panel must survive.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { module: { exports: {} }, console, URL, URLSearchParams };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(readFileSync(join(here, "..", "content", "api.js"), "utf8"), sandbox);

const {
  tdxParseLocation,
  tdxOtherType,
  tdxManifestUrls,
  tdxDownloadUrl,
  tdxNormalizeManifest,
  TDX_TYPE_AO,
  TDX_TYPE_CONSULTATION
} = sandbox.module.exports;

/* ---------------- URL parsing ---------------- */

test("AO detail route yields an AO tender number", () => {
  const r = tdxParseLocation(
    "https://www.tuneps.tn/portail/offres/details/37466/20230701022/resultatouverture"
  );
  assert.equal(r.tenderNo, "20230701022");
  assert.equal(r.type, TDX_TYPE_AO);
  assert.equal(r.confident, true);
});

test("AO offerdetails route is recognised", () => {
  const r = tdxParseLocation("https://www.tuneps.tn/portail/offerdetails/37466/20260800201");
  assert.equal(r.tenderNo, "20260800201");
  assert.equal(r.type, TDX_TYPE_AO);
});

test("consultation route yields a consultation tender number", () => {
  const r = tdxParseLocation(
    "https://www.tuneps.tn/portail/consultations/consultationdetails/9001/S20260703054"
  );
  assert.equal(r.tenderNo, "S20260703054");
  assert.equal(r.type, TDX_TYPE_CONSULTATION);
});

test("a leading S wins over an AO-looking path", () => {
  const r = tdxParseLocation("https://www.tuneps.tn/portail/offres/details/1/S20260703054");
  assert.equal(r.type, TDX_TYPE_CONSULTATION);
});

test("a short numeric id is not mistaken for a tender number", () => {
  assert.equal(tdxParseLocation("https://www.tuneps.tn/portail/offres/details/37466"), null);
});

test("listing pages produce no tender", () => {
  assert.equal(tdxParseLocation("https://www.tuneps.tn/portail/offres"), null);
  assert.equal(tdxParseLocation("https://www.tuneps.tn/"), null);
});

test("an unknown route still yields a tender but is flagged unconfident", () => {
  const r = tdxParseLocation("https://www.tuneps.tn/fournisseur/something/20260800201");
  assert.equal(r.tenderNo, "20260800201");
  assert.equal(r.confident, false);
});

test("a garbage href does not throw", () => {
  assert.doesNotThrow(() => tdxParseLocation("::::"));
});

test("tdxOtherType flips the type", () => {
  assert.equal(tdxOtherType(TDX_TYPE_AO), TDX_TYPE_CONSULTATION);
  assert.equal(tdxOtherType(TDX_TYPE_CONSULTATION), TDX_TYPE_AO);
});

/* ---------------- URL building ---------------- */

test("consultation manifest URL uses the shop endpoint", () => {
  assert.deepEqual([...tdxManifestUrls("S20260703054", TDX_TYPE_CONSULTATION)], [
    "https://www.tuneps.tn/api2/ged-shop/spShopAttachFile/getByShopNo?shopNo=S20260703054"
  ]);
});

test("AO manifest URL tries the clean path then the portal's double slash", () => {
  const urls = tdxManifestUrls("20260800201", TDX_TYPE_AO);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes("/api2/ged/vAttachFile/getByBidNo?bidNo=20260800201"));
  assert.ok(urls[1].includes("/api2/ged//vAttachFile/getByBidNo?bidNo=20260800201"));
});

test("download URL uses lowercase noderef and always sends fileName", () => {
  const url = tdxDownloadUrl("db0153fe-b0af-41a2-a485-55aaac5eb4b4;1.0", "fiche technique - 1.pdf");
  assert.ok(url.includes("?noderef="));
  assert.ok(!url.includes("nodeRef="));
  assert.ok(url.includes("%3B1.0"));
  assert.ok(url.includes("&fileName=fiche%20technique%20-%201.pdf"));
});

test("download URL encodes accented and Arabic filenames", () => {
  const url = tdxDownloadUrl("abc;1.0", "Cahier des charges éèà كراس.pdf");
  assert.ok(!/[éèàك ]/.test(url));
  assert.equal(decodeURIComponent(url.split("&fileName=")[1]), "Cahier des charges éèà كراس.pdf");
});

/* ---------------- manifest normalisation ---------------- */

const CONSULT_ROW = {
  fileNm: "Annexe 1.pdf",
  seqNo: 1,
  nodeRef: "e18c3b9c-ce4d-4064-b0e3-906b334cf5ef;1.0",
  cdNmAr: "اخر",
  cdNmFr: "Autres",
  docCd: "B03",
  fileLoc: "/EDOCS/attach/shop/...",
  shopNo: "S20260703054"
};

const AO_ROW = {
  fileNm: "CCAP  GEI.25.4.0035.pdf",
  seqNo: 1,
  bidAttNodeRef: "34cbe235-0396-4b14-b38a-5838cb5a6026;1.0",
  cdNmFr: "Cahier des charges_francais",
  docCd: "B02",
  bidNo: "20260800201"
};

test("consultation rows read nodeRef", () => {
  const { files } = tdxNormalizeManifest({ code: 200, payload: [CONSULT_ROW] });
  assert.equal(files.length, 1);
  assert.equal(files[0].nodeRef, CONSULT_ROW.nodeRef);
  assert.equal(files[0].category, "Autres");
  assert.equal(files[0].downloadable, true);
});

test("AO rows read bidAttNodeRef", () => {
  const { files } = tdxNormalizeManifest({ code: 200, payload: [AO_ROW] });
  assert.equal(files[0].nodeRef, AO_ROW.bidAttNodeRef);
  assert.equal(files[0].category, "Cahier des charges_francais");
  assert.equal(files[0].downloadable, true);
});

test("rows are ordered by seqNo", () => {
  const { files } = tdxNormalizeManifest({
    code: 200,
    payload: [
      { ...CONSULT_ROW, seqNo: 3, fileNm: "c.pdf" },
      { ...CONSULT_ROW, seqNo: 1, fileNm: "a.pdf" },
      { ...CONSULT_ROW, seqNo: 2, fileNm: "b.pdf" }
    ]
  });
  assert.deepEqual(
    [...files.map((f) => f.fileName)],
    ["a.pdf", "b.pdf", "c.pdf"]
  );
});

test("a row without any node reference is listed but not downloadable", () => {
  const { files } = tdxNormalizeManifest({ code: 200, payload: [{ fileNm: "x.pdf", seqNo: 1 }] });
  assert.equal(files[0].downloadable, false);
  assert.match(files[0].problem, /node reference/i);
});

test("a row without a filename gets a placeholder and a warning", () => {
  const { files, warnings } = tdxNormalizeManifest({
    code: 200,
    payload: [{ nodeRef: "abc;1.0", seqNo: 1 }]
  });
  assert.equal(files[0].fileName, "document-1");
  assert.equal(warnings.length, 1);
});

test("an empty payload is zero files, not an error", () => {
  assert.equal(tdxNormalizeManifest({ code: 200, payload: [] }).files.length, 0);
  assert.equal(tdxNormalizeManifest({ code: 200, payload: null }).files.length, 0);
});

test("a bare array payload is accepted", () => {
  assert.equal(tdxNormalizeManifest([CONSULT_ROW]).files.length, 1);
});

test("a non-200 envelope raises a readable error", () => {
  assert.throws(
    () => tdxNormalizeManifest({ code: 500, message: "boom" }),
    /rejected the request \(code 500: boom\)/
  );
});

test("an unrecognised shape raises a readable error", () => {
  assert.throws(() => tdxNormalizeManifest({ something: "else" }), /unexpected JSON shape/);
  assert.throws(() => tdxNormalizeManifest("not json data"), /not JSON data/);
});

test("junk entries inside the payload are skipped with a warning", () => {
  const { files, warnings } = tdxNormalizeManifest({ code: 200, payload: [null, CONSULT_ROW] });
  assert.equal(files.length, 1);
  assert.equal(warnings.length, 1);
});
