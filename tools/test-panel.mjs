#!/usr/bin/env node
/*
 * test-panel.mjs - runs content/panel.js against a fake DOM.
 *
 *   node --test tools/test-panel.mjs
 *
 * This cannot replace loading the extension in Chrome, but it does prove the
 * panel renders the real manifest payloads, surfaces errors instead of
 * throwing, reacts to SPA navigation, and builds downloads from the verified
 * request shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { makeDom, settle } from "./fake-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const SOURCES = [read("content", "styles.js"), read("content", "api.js"), read("content", "panel.js")];

const CONSULT_PAYLOAD = {
  code: 200,
  payload: [
    {
      fileNm: "Annexe 1.pdf",
      seqNo: 1,
      nodeRef: "e18c3b9c-ce4d-4064-b0e3-906b334cf5ef;1.0",
      cdNmFr: "Autres",
      docCd: "B03"
    },
    {
      fileNm: "fiche technique - article 1.pdf",
      seqNo: 2,
      nodeRef: "db0153fe-b0af-41a2-a485-55aaac5eb4b4;1.0",
      cdNmFr: "Documents techniques",
      docCd: "B01"
    }
  ]
};

const AO_PAYLOAD = {
  code: 200,
  payload: [
    {
      fileNm: "CCAP  GEI.25.4.0035.pdf",
      seqNo: 1,
      bidAttNodeRef: "34cbe235-0396-4b14-b38a-5838cb5a6026;1.0",
      cdNmFr: "Cahier des charges_francais",
      docCd: "B02"
    }
  ]
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
    blob: async () => new Blob([JSON.stringify(body)]),
    headers: { get: () => null }
  };
}

function binaryResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: async () => "",
    blob: async () => new Blob([bytes]),
    headers: { get: () => null }
  };
}

/** Boot panel.js against a fake DOM and return the harness. */
function boot({ href, fetchImpl }) {
  const dom = makeDom({ href, fetchImpl });
  for (const src of SOURCES) vm.runInNewContext(src, dom.sandbox, { filename: "bundle.js" });
  return dom;
}

function routedFetch(calls, routes) {
  return async (url, opts) => {
    calls.push({ url, opts });
    for (const [pattern, responder] of routes) {
      if (url.includes(pattern)) return responder(url);
    }
    throw new TypeError("Failed to fetch");
  };
}

const CONSULT_URL = "https://www.tuneps.tn/portail/consultations/consultationdetails/9001/S20260703054";
const AO_URL = "https://www.tuneps.tn/portail/offres/details/37466/20260800201/resultatouverture";

test("a consultation page renders one row per attachment", async () => {
  const calls = [];
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch(calls, [["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)]])
  });
  await settle();

  const shadow = dom.shadow();
  assert.ok(shadow, "the panel host was injected");
  assert.equal(shadow.byClass("tdx-item").length, 2);
  assert.ok(shadow.byClass("tdx-title-main")[0].textContent.includes("S20260703054"));
  assert.ok(shadow.byClass("tdx-title-sub")[0].textContent.includes("CONSULTATION"));
  assert.ok(shadow.textContent.includes("Documents techniques"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://www.tuneps.tn/api2/ged-shop/spShopAttachFile/getByShopNo?"));
});

test("an AO page uses the bid endpoint and reads bidAttNodeRef", async () => {
  const calls = [];
  const dom = boot({
    href: AO_URL,
    fetchImpl: routedFetch(calls, [["getByBidNo", () => jsonResponse(AO_PAYLOAD)]])
  });
  await settle();

  const shadow = dom.shadow();
  assert.equal(shadow.byClass("tdx-item").length, 1);
  assert.ok(shadow.textContent.includes("Cahier des charges_francais"));
  assert.ok(calls[0].url.includes("/api2/ged/vAttachFile/getByBidNo?bidNo=20260800201"));
});

test("clicking Download fetches the verified download URL and saves a blob", async () => {
  const calls = [];
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch(calls, [
      ["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)],
      ["downloadFile", () => binaryResponse(Buffer.from("%PDF-1.7 hello"))]
    ])
  });
  await settle();

  const buttons = dom.shadow().byClass("tdx-btn").filter((b) => b.textContent === "Download");
  assert.equal(buttons.length, 2);
  buttons[0].click();
  await settle();

  const dl = calls.find((c) => c.url.includes("downloadFile"));
  assert.ok(dl, "a download request was made");
  assert.ok(dl.url.includes("?noderef=e18c3b9c-ce4d-4064-b0e3-906b334cf5ef%3B1.0"));
  assert.ok(dl.url.includes("&fileName=Annexe%201.pdf"));
  assert.equal(dom.objectUrls.length, 1, "the blob was handed to a download anchor");
  assert.ok(dom.shadow().textContent.includes("Saved"));
});

test("Download all walks every downloadable row", async () => {
  const calls = [];
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch(calls, [
      ["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)],
      ["downloadFile", () => binaryResponse(Buffer.from("%PDF-1.7 hello"))]
    ])
  });
  await settle();

  const allBtn = dom.shadow().find((el) => el.textContent === "Download all");
  allBtn.click();
  for (let i = 0; i < 10 && dom.objectUrls.length < 2; i++) await settle();

  assert.equal(dom.objectUrls.length, 2);
  assert.equal(calls.filter((c) => c.url.includes("downloadFile")).length, 2);
});

test("an HTTP error is shown in the panel and never thrown", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch([], [["getByShopNo", () => jsonResponse({}, 503)]])
  });
  await settle();

  const shadow = dom.shadow();
  assert.equal(shadow.byClass("tdx-error").length, 1);
  assert.ok(shadow.byClass("tdx-error")[0].textContent.includes("HTTP 503"));
});

test("a network failure is shown as a readable message", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    }
  });
  await settle();

  const err = dom.shadow().byClass("tdx-error")[0];
  assert.ok(err.textContent.includes("Could not reach the Tuneps server"));
});

test("an empty manifest says so instead of looking broken", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch(
      [],
      [
        ["getByShopNo", () => jsonResponse({ code: 200, payload: [] })],
        ["getByBidNo", () => jsonResponse({ code: 200, payload: [] })]
      ]
    )
  });
  await settle();

  assert.ok(dom.shadow().textContent.includes("No documents are attached"));
});

test("a wrong type guess falls back to the other endpoint", async () => {
  const calls = [];
  // A consultation reached through an AO-looking URL with no leading S.
  const dom = boot({
    href: "https://www.tuneps.tn/portail/offres/details/1/20260703054",
    fetchImpl: routedFetch(calls, [
      ["getByBidNo", () => jsonResponse({ code: 200, payload: [] })],
      ["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)]
    ])
  });
  await settle();
  await settle();

  assert.equal(dom.shadow().byClass("tdx-item").length, 2);
  assert.ok(dom.shadow().byClass("tdx-title-sub")[0].textContent.includes("CONSULTATION"));
});

test("no panel is injected on a listing page", async () => {
  const dom = boot({
    href: "https://www.tuneps.tn/portail/offres",
    fetchImpl: async () => {
      throw new Error("no request should be made");
    }
  });
  await settle();
  assert.equal(dom.shadow(), null);
});

test("SPA navigation between tenders reloads the panel", async () => {
  const calls = [];
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch(calls, [
      ["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)],
      ["getByBidNo", () => jsonResponse(AO_PAYLOAD)]
    ])
  });
  await settle();
  assert.equal(dom.shadow().byClass("tdx-item").length, 2);

  dom.location.href = AO_URL;
  dom.tick();
  await settle();

  assert.equal(dom.shadow().byClass("tdx-item").length, 1);
  assert.ok(dom.shadow().byClass("tdx-title-main")[0].textContent.includes("20260800201"));
});

test("navigating away from a tender removes the panel", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch([], [["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)]])
  });
  await settle();
  assert.ok(dom.shadow());

  dom.location.href = "https://www.tuneps.tn/portail/offres";
  dom.tick();
  await settle();
  assert.equal(dom.shadow(), null);
});

test("the panel is re-injected if the SPA rips it out of the DOM", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch([], [["getByShopNo", () => jsonResponse(CONSULT_PAYLOAD)]])
  });
  await settle();

  const host = dom.doc.getElementById("tuneps-document-downloader-root");
  host.parentNode.removeChild(host);
  dom.tick();
  await settle();

  assert.ok(dom.shadow(), "the panel came back");
  assert.equal(dom.shadow().byClass("tdx-item").length, 2);
});

test("a row with no node reference is listed but its button is disabled", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: routedFetch(
      [],
      [
        [
          "getByShopNo",
          () =>
            jsonResponse({
              code: 200,
              payload: [{ fileNm: "orphan.pdf", seqNo: 1, cdNmFr: "Autres" }]
            })
        ]
      ]
    )
  });
  await settle();

  const shadow = dom.shadow();
  const btn = shadow.byClass("tdx-btn").find((b) => b.textContent === "Download");
  assert.equal(btn.disabled, true);
  assert.ok(shadow.textContent.includes("No node reference"));
});

test("a non-JSON response is reported rather than crashing", async () => {
  const dom = boot({
    href: CONSULT_URL,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html>maintenance</html>",
      headers: { get: () => null }
    })
  });
  await settle();

  assert.ok(dom.shadow().byClass("tdx-error")[0].textContent.includes("not JSON"));
});
