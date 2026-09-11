/*
 * api.js - pure, side-effect-free Tuneps API layer.
 *
 * This file is loaded twice:
 *   1. by the extension, as the first real content script (isolated world);
 *   2. by tools/verify-api.mjs, which evaluates it in a Node vm sandbox so the
 *      live verification exercises exactly the same URL builders and parsers
 *      the browser uses. Keep it free of DOM and chrome.* references.
 *
 * Every request shape below was verified live against www.tuneps.tn on
 * 2026-09-11 with no Authorization header at all. See README.md.
 */

var TDX_BASE = "https://www.tuneps.tn";

var TDX_TYPE_AO = "AO";
var TDX_TYPE_CONSULTATION = "CONSULTATION";

/* A tender number is 11 digits, optionally prefixed with S for consultations.
 * The bound is loosened to 9..13 digits so a future numbering change does not
 * silently stop the panel from appearing. Internal row ids on the portal
 * (epBidMasterId, spShopMasterId) are 4..6 digits and therefore never match. */
var TDX_TENDER_SEGMENT_RE = /^(S?)(\d{9,13})$/i;

/* ------------------------------------------------------------------ *
 * Tender identification
 * ------------------------------------------------------------------ */

/**
 * Pull the tender number and type out of a portal URL.
 *
 * Verified Angular routes (extracted from the portal's own bundle):
 *   /portail/offres/details/:epBidMasterId/:bidNo[/listSoumissionaires|/resultatouverture]
 *   /portail/offerdetails/:epBidMasterId/:bidNo
 *   /portail/consultations/consultationdetails/:spShopMasterId/:shopNo[/...]
 *
 * Matching is deliberately permissive: any path segment that looks like a
 * tender number is accepted, so supplier-side and future routes keep working.
 *
 * @param {string} href - a full URL (location.href).
 * @returns {{tenderNo: string, type: string, confident: boolean}|null}
 */
function tdxParseLocation(href) {
  var path;
  try {
    var u = new URL(href, TDX_BASE);
    // The portal is a hash-free Angular app, but tolerate a hash route anyway.
    path = u.pathname + (u.hash || "").replace(/^#/, "/");
  } catch (err) {
    return null;
  }

  var segments = path.split("/").filter(Boolean).map(decodeTdxSegment);
  var tenderNo = null;
  for (var i = segments.length - 1; i >= 0; i--) {
    var m = TDX_TENDER_SEGMENT_RE.exec(segments[i]);
    if (m) {
      tenderNo = (m[1] ? "S" : "") + m[2];
      break;
    }
  }
  if (!tenderNo) return null;

  var lower = path.toLowerCase();
  var type;
  var confident = true;

  if (tenderNo.charAt(0) === "S") {
    // The leading S is the strongest signal: consultation shop numbers carry it.
    type = TDX_TYPE_CONSULTATION;
  } else if (lower.indexOf("consultationdetails") !== -1 || lower.indexOf("/consultation") !== -1) {
    type = TDX_TYPE_CONSULTATION;
  } else if (
    lower.indexOf("/offres") !== -1 ||
    lower.indexOf("offerdetails") !== -1 ||
    lower.indexOf("aodetail") !== -1 ||
    lower.indexOf("/avisao") !== -1
  ) {
    type = TDX_TYPE_AO;
  } else {
    // Unknown route: assume AO but let the caller retry the other endpoint.
    type = TDX_TYPE_AO;
    confident = false;
  }

  return { tenderNo: tenderNo, type: type, confident: confident };
}

function decodeTdxSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (err) {
    return segment;
  }
}

/** The type to fall back to when the first manifest lookup comes back empty. */
function tdxOtherType(type) {
  return type === TDX_TYPE_CONSULTATION ? TDX_TYPE_AO : TDX_TYPE_CONSULTATION;
}

/* ------------------------------------------------------------------ *
 * URL builders
 * ------------------------------------------------------------------ */

/**
 * Candidate manifest URLs for a tender, in the order they should be tried.
 *
 * The AO endpoint is published by the portal with a double slash
 * (/api2/ged//vAttachFile/...). Both forms were verified live and return
 * identical payloads, so the clean single-slash form is tried first and the
 * portal's literal double-slash form is kept as a fallback in case a future
 * proxy rule only recognises the exact path the portal itself uses.
 *
 * @param {string} tenderNo
 * @param {string} type - TDX_TYPE_AO or TDX_TYPE_CONSULTATION
 * @returns {string[]}
 */
function tdxManifestUrls(tenderNo, type) {
  var no = encodeURIComponent(tenderNo);
  if (type === TDX_TYPE_CONSULTATION) {
    return [TDX_BASE + "/api2/ged-shop/spShopAttachFile/getByShopNo?shopNo=" + no];
  }
  return [
    TDX_BASE + "/api2/ged/vAttachFile/getByBidNo?bidNo=" + no,
    TDX_BASE + "/api2/ged//vAttachFile/getByBidNo?bidNo=" + no
  ];
}

/**
 * Build a file download URL.
 *
 * Two details are load bearing and were both confirmed by live testing:
 *   - the query parameter is lowercase "noderef"; the camelCase "nodeRef"
 *     returns HTTP 400;
 *   - "fileName" is mandatory; omitting it returns HTTP 400.
 *
 * @param {string} nodeRef - e.g. "db0153fe-...-55aaac5eb4b4;1.0"
 * @param {string} fileName - raw filename, may contain spaces/accents/Arabic
 * @returns {string}
 */
function tdxDownloadUrl(nodeRef, fileName) {
  return (
    TDX_BASE +
    "/api2/ged/document/downloadFile?noderef=" +
    encodeURIComponent(nodeRef) +
    "&fileName=" +
    encodeURIComponent(fileName)
  );
}

/* ------------------------------------------------------------------ *
 * Response parsing
 * ------------------------------------------------------------------ */

/**
 * Turn a manifest response body into a list of normalised file rows.
 *
 * Both tender types return {"code": 200, "payload": [...]}, but the node
 * reference lives under a different key per type:
 *   - consultation rows: nodeRef
 *   - AO rows:           bidAttNodeRef
 * A bare array and a {data: [...]} envelope are also tolerated so an upstream
 * response-shape change degrades into "0 files" rather than an exception.
 *
 * @param {*} body - already-parsed JSON
 * @returns {{files: Array, warnings: string[]}}
 * @throws {Error} when the body is not a recognisable envelope
 */
function tdxNormalizeManifest(body) {
  var rows = tdxExtractRows(body);
  var files = [];
  var warnings = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== "object") {
      warnings.push("Entry " + (i + 1) + " was not an object and was skipped.");
      continue;
    }
    var nodeRef = tdxPickString(row, ["nodeRef", "bidAttNodeRef", "noderef", "attNodeRef"]);
    var fileName = tdxPickString(row, ["fileNm", "fileName", "fileNom"]);
    var label = tdxPickString(row, ["cdNmFr", "cdNm", "cdNmEn", "cdNmAr"]);

    if (!fileName) {
      fileName = nodeRef ? "document-" + (i + 1) : "";
      warnings.push("Entry " + (i + 1) + " has no filename; a placeholder was used.");
    }

    files.push({
      index: i,
      seqNo: row.seqNo != null ? row.seqNo : i + 1,
      fileName: fileName,
      nodeRef: nodeRef || null,
      category: label || "",
      categoryAr: tdxPickString(row, ["cdNmAr"]) || "",
      docCd: tdxPickString(row, ["docCd"]) || "",
      fileLoc: tdxPickString(row, ["fileLoc"]) || "",
      downloadable: Boolean(nodeRef && fileName),
      problem: nodeRef ? null : "No node reference in this entry, so it cannot be downloaded."
    });
  }

  files.sort(function (a, b) {
    var sa = Number(a.seqNo);
    var sb = Number(b.seqNo);
    if (isFinite(sa) && isFinite(sb) && sa !== sb) return sa - sb;
    return a.index - b.index;
  });

  return { files: files, warnings: warnings };
}

function tdxExtractRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") {
    throw new Error("The portal returned something that is not JSON data.");
  }
  if (body.code != null && Number(body.code) !== 200) {
    var msg = tdxPickString(body, ["message", "error"]);
    throw new Error(
      "The portal rejected the request (code " + body.code + (msg ? ": " + msg : "") + ")."
    );
  }
  var candidates = [body.payload, body.data, body.result, body.list];
  for (var i = 0; i < candidates.length; i++) {
    if (Array.isArray(candidates[i])) return candidates[i];
  }
  // An envelope with a null/absent payload legitimately means "no attachments".
  if ("payload" in body || "data" in body) return [];
  throw new Error("The portal returned an unexpected JSON shape (no file list found).");
}

function tdxPickString(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** Best-effort human readable size. */
function tdxFormatBytes(n) {
  if (!isFinite(n) || n < 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/* Export for the Node verifier. Harmless no-op inside the browser. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TDX_BASE: TDX_BASE,
    TDX_TYPE_AO: TDX_TYPE_AO,
    TDX_TYPE_CONSULTATION: TDX_TYPE_CONSULTATION,
    tdxParseLocation: tdxParseLocation,
    tdxOtherType: tdxOtherType,
    tdxManifestUrls: tdxManifestUrls,
    tdxDownloadUrl: tdxDownloadUrl,
    tdxNormalizeManifest: tdxNormalizeManifest,
    tdxFormatBytes: tdxFormatBytes
  };
}
