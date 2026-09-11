# Tuneps Document Downloader

A Chrome (Manifest V3) extension that lists and downloads every document attached to a
tender on [www.tuneps.tn](https://www.tuneps.tn), with **no eToken, no Java signing proxy,
and no login**.

Open any tender detail page (appel d'offres or consultation) and a panel appears in the
bottom right with one row per attached file: the filename, the French document category,
and a Download button. A "Download all" button fetches the whole set.

---

## Why no authentication is needed

The Tuneps **read** path is public. The SafeNet eToken and the local Java CAdES proxy are
only required to **sign bid submissions**, not to read published documents.

This was verified against the live portal by fetching the same files with a real JWT and
with no `Authorization` header at all, then comparing SHA-256 hashes of the returned
bytes. They are byte identical, up to 8.2 MB files. The portal also ignores a deliberately
malformed bearer token and returns the same bytes. The verification in this repo
(`tools/verify-api.mjs`) sends no `Authorization` header of any kind, and passes.

Practically: you can pull a Cahier des Charges at 02:00 with the eToken in a drawer.

---

## Install (Load unpacked)

1. Clone or copy this directory somewhere permanent. Chrome reads the files from disk on
   every load, so do not delete or move the folder afterwards.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select this directory (the one containing `manifest.json`).
5. The extension appears as "Tuneps Document Downloader". No options, no sign-in.
6. Open a tender detail page on www.tuneps.tn. The panel appears once the file list loads.

There is no build step and no dependency to install. Plain HTML, CSS and JS.

To pick up code changes: click the reload arrow on the extension's card in
`chrome://extensions`, then reload the Tuneps tab.

---

## Verify it works

Two live tenders with real attachments:

| Type | Number | Expect |
| --- | --- | --- |
| CONSULTATION | `S20260703054` | 16 files (1 "Autres", 1 "Documents financiers", 13 "Documents techniques", plus the avis) |
| AO | `20260800201` | 2 files, both "Cahier des charges_francais" |

Find them through the portal's search, or navigate directly if you know the internal row
id, for example
`https://www.tuneps.tn/portail/offres/details/<epBidMasterId>/20260800201/resultatouverture`.

You can also check the API layer without a browser at all:

```bash
node tools/verify-api.mjs          # live: hits www.tuneps.tn, downloads real files
node --test tools/test-api.mjs tools/test-panel.mjs   # offline: 37 checks, no network
```

If `verify-api.mjs` fails with a certificate error, the Tuneps TLS chain is incomplete for
your trust store. Point Node at a bundle containing the QuoVadis roots rather than
disabling verification:

```bash
NODE_EXTRA_CA_CERTS=/path/to/chain.pem node tools/verify-api.mjs
```

Chrome is unaffected: it completes the chain itself.

---

## Permissions rationale

`manifest.json` requests **no `permissions` and no `host_permissions` at all**. The only
capability granted is a content script on one origin:

| Entry | Why |
| --- | --- |
| `content_scripts.matches: ["https://www.tuneps.tn/*"]` | The panel has to run inside the portal's own pages. Restricted to HTTPS and to the single host that serves both the portal and its API. `www.tuneps.tn` is the only host that resolves; the apex `tuneps.tn` does not. |
| `content_scripts.all_frames: false` | The tender view is the top-level document. Staying out of iframes avoids duplicate panels and needless execution in embedded frames. |
| (no `host_permissions`) | Every request the extension makes goes to `www.tuneps.tn`, which is the same origin as the page it runs in, so no cross-origin grant is needed. The download endpoint additionally returns `Access-Control-Allow-Origin: *`. |
| (no `downloads` permission) | Files are saved by handing a `Blob` to an `<a download>` element, which is a plain page capability. The privileged `chrome.downloads` API is not used. |
| (no `storage`, `tabs`, `scripting`, background service worker) | Nothing is persisted, no tab is inspected, no code is injected dynamically. |

Chrome will describe the extension as able to "read and change your data on
www.tuneps.tn". That is the content script, and it is the minimum that can work.

The extension sends no data anywhere except to www.tuneps.tn. There is no telemetry, no
analytics, no external script, no CDN load, and no credential of any kind in this repo.

---

## How it works

1. **Detect.** The content script reads `location.href` and takes the last path segment
   that looks like a tender number (`S` plus 11 digits, or 11 digits). Internal row ids on
   the portal are 4 to 6 digits and never match. If the URL has no tender number, the page
   text is searched for a labelled one. If nothing is found, no panel is shown.

   Routes confirmed from the portal's own Angular bundle:

   ```
   /portail/offres/details/:epBidMasterId/:bidNo[/listSoumissionaires|/resultatouverture]
   /portail/offerdetails/:epBidMasterId/:bidNo
   /portail/consultations/consultationdetails/:spShopMasterId/:shopNo[/...]
   ```

   Matching is deliberately looser than these exact routes so supplier-side and future
   pages keep working, and it fails quietly when no tender number is present.

2. **Classify.** A leading `S` means CONSULTATION. Otherwise the path decides
   (`consultationdetails` or `/consultation` versus `/offres`, `offerdetails`, `aodetail`).
   If the first endpoint returns nothing, the other one is tried before reporting "no
   documents", so a wrong guess cannot hide files.

3. **List.** One GET, no auth:

   ```
   CONSULTATION  /api2/ged-shop/spShopAttachFile/getByShopNo?shopNo=S20260703054
   AO            /api2/ged/vAttachFile/getByBidNo?bidNo=20260800201
   ```

   Both return `{"code":200,"payload":[...]}`.

   The portal itself calls the AO endpoint with a doubled slash (`/api2/ged//vAttachFile/`).
   Both forms were tested and return identical payloads, so the clean form is tried first
   and the portal's literal form is kept as a fallback.

4. **Read the rows.** The node reference field name **differs by tender type**, which is
   the single easiest thing to get wrong here:

   | Tender type | Node reference field |
   | --- | --- |
   | CONSULTATION | `nodeRef` |
   | AO | `bidAttNodeRef` |

   Both row shapes also carry `fileNm`, `seqNo`, `docCd`, `cdNmFr`, `cdNmAr`, `fileLoc`.

5. **Download.**

   ```
   /api2/ged/document/downloadFile?noderef=<nodeRef>&fileName=<fileNm>
   ```

   Two details are load bearing and both were confirmed by testing the failure cases:

   - the query parameter is lowercase **`noderef`**. The camelCase `nodeRef` returns HTTP 400.
   - **`fileName` is mandatory.** Omitting it returns HTTP 400.

   Both values are percent encoded, which matters because filenames contain spaces,
   accented French characters, and sometimes Arabic. The node reference itself contains a
   `;` version suffix (`<uuid>;1.0`).

   The panel fetches the file as a `Blob` and saves it through an `<a download>` element.
   That way an HTTP error becomes a readable message in the panel instead of a silent
   nothing. If that in-page fetch fails for a non-HTTP reason, the raw URL is handed to the
   browser's own downloader as a fallback; the portal sends
   `Content-Disposition: attachment`, so the browser downloads rather than navigating away.

### Single-page app handling

The portal is an Angular SPA: moving between tenders does not reload the page. A content
script runs in an isolated world, so patching `history.pushState` there would not observe
the page's own calls. The panel therefore polls `location.href` every 700 ms, and also
listens for `popstate` and `hashchange`. If the SPA removes the host element, the next
poll re-injects it. Navigating away from a tender removes the panel.

### Not breaking the portal

The UI lives in a **shadow root** attached to a fixed-position host element on
`document.documentElement`. Nothing is injected into the portal's own DOM tree, the
extension's CSS cannot leak into the page, and the portal's Bootstrap and Angular Material
rules cannot leak in. Every entry point is wrapped, so a failure renders a message in the
panel rather than throwing into the portal's error handling.

---

## Troubleshooting

**The panel does not appear.**
Confirm the URL is a tender *detail* page and contains the tender number (a listing or
search page has none, and the panel stays hidden on purpose). Then reload the tab. If it
still does not appear, open DevTools (F12), Console, and look for `[tuneps-downloader]`.
Check the extension is enabled at `chrome://extensions` and that you are on
`https://www.tuneps.tn` and not a different host.

**The panel says "No documents are attached to this tender".**
Both endpoints were tried and both returned an empty list. Either the buyer has not
published documents yet, or the tender number was misread. Check the number in the panel
header against the page.

**The panel says "Could not reach the Tuneps server".**
A network failure or a timeout (45 s for the list, 180 s for a file). The portal is
frequently slow. Click **Reload** in the panel header.

**A download says "The portal answered HTTP 400 (the file reference was rejected)".**
The manifest row's node reference was not accepted. This is the failure mode you would see
if the wrong field name were used for the tender type. Reload the list; if it persists,
report the tender number.

**Chrome asks to "allow multiple downloads".**
Expected for **Download all**. Allow it once for www.tuneps.tn.

**Downloads land with the wrong name or as `.htm`.**
Should not happen: filenames come from `fileNm` and the server also sends
`Content-Disposition: attachment`. If it does, check whether a download manager extension
is intercepting.

**Files download but will not open.**
Check the file size in the panel's "Saved (...)" status. A near-zero size means the portal
returned a stub. Retry later.

---

## Repository layout

```
manifest.json            MV3 manifest (no permissions, one content script)
content/styles.js        panel stylesheet as a string, injected into the shadow root
content/api.js           pure API layer: URL builders, route parsing, manifest parsing
content/panel.js         DOM, rendering, downloads, SPA lifecycle
icons/                   generated PNGs
tools/verify-api.mjs     LIVE verification against www.tuneps.tn (no auth header)
tools/test-api.mjs       offline unit tests for content/api.js
tools/test-panel.mjs     runs content/panel.js against a fake DOM
tools/fake-dom.mjs       the minimal DOM the panel needs
tools/make-icons.py      regenerates icons/ without an image library
```

`content/api.js` is loaded both by Chrome and, through a Node `vm` sandbox, by the test
and verification scripts, so the tests exercise exactly the code the browser runs.

---

## What was verified live, and what still needs your browser

Verified live against www.tuneps.tn on 2026-09-11, with no `Authorization` header
(`node tools/verify-api.mjs`, all checks green):

- Consultation manifest for `S20260703054` returns HTTP 200 and 16 rows, each with `nodeRef`.
- AO manifest for `20260800201` returns HTTP 200 and 2 rows, each with `bidAttNodeRef`.
- The AO endpoint works with **both** `/api2/ged/vAttachFile/` and `/api2/ged//vAttachFile/`,
  returning identical payloads.
- Real file downloads: `Annexe 1.pdf` (204,302 bytes) and `CCAP  GEI.25.4.0035.pdf`
  (1,147,069 bytes), both valid PDFs, both with `Content-Disposition: attachment`.
- Byte-identical results with no auth header, with a garbage bearer token, and with a real
  JWT (SHA-256 compared).
- `nodeRef` in camelCase returns HTTP 400; omitting `fileName` returns HTTP 400.
- Space encoding does not matter: `+` and `%20` both return identical bytes.
- The API sends `Access-Control-Allow-Origin: *`.
- The portal's Angular route table, read out of its own JS bundle, giving the exact AO and
  consultation detail routes listed above.

Verified offline (`node --test tools/test-api.mjs tools/test-panel.mjs`, 37 checks green): URL parsing and classification,
endpoint selection, encoding of accented and Arabic filenames, manifest parsing for both
row shapes plus malformed and empty payloads, panel rendering, download wiring, error
rendering for HTTP errors / network failures / non-JSON responses, type-guess fallback,
SPA navigation between tenders, and panel re-injection after the SPA removes it.

**Only your browser can confirm** (none of this could be driven from a terminal here):

- That the extension loads cleanly via Load unpacked with no manifest warnings.
- That the panel visually appears, is readable, and does not disturb the portal's layout
  at your window size.
- That a real Chrome download lands in your Downloads folder with the right filename.
- That "Download all" behaves acceptably with Chrome's multiple-downloads prompt.
- That the panel updates when you navigate between tenders inside the SPA (this is tested
  against a fake DOM, but real Angular is the real test).
- Behaviour while logged in to the portal (requests use `credentials: "same-origin"`, so a
  session is sent if one exists, but none is required).
