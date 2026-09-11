/*
 * panel.js - injects the document panel into Tuneps tender detail pages.
 *
 * Design notes:
 *  - The UI lives in a shadow root so neither stylesheet can leak across.
 *  - The portal is an Angular SPA that swaps views without a page load, so the
 *    current URL is polled (plus popstate/hashchange) rather than read once.
 *    A content script runs in an isolated world, so patching history.pushState
 *    here would NOT see the page's own calls; polling is the reliable option.
 *  - Every entry point is wrapped so a failure shows in the panel instead of
 *    throwing into the portal's own error handling.
 */

(function () {
  "use strict";

  var HOST_ID = "tuneps-document-downloader-root";
  var POLL_MS = 700;
  var REQUEST_TIMEOUT_MS = 45000;
  var DOWNLOAD_TIMEOUT_MS = 180000;
  var DOWNLOAD_ALL_GAP_MS = 400;

  var state = {
    hostEl: null,
    shadow: null,
    refs: null,
    lastHref: null,
    currentKey: null,
    collapsed: false,
    loadToken: 0,
    abort: null,
    files: [],
    tender: null,
    usedType: null,
    warnings: [],
    error: null,
    loading: false,
    bulk: null
  };

  /* ---------------------------------------------------------------- *
   * Shadow host
   * ---------------------------------------------------------------- */

  function ensureHost() {
    if (state.hostEl && state.hostEl.isConnected) return true;

    var root = document.documentElement;
    if (!root) return false;

    var host = document.getElementById(HOST_ID);
    if (host && host.shadowRoot) {
      state.hostEl = host;
      state.shadow = host.shadowRoot;
      return true;
    }

    host = document.createElement("div");
    host.id = HOST_ID;
    // Keep the host itself inert so it cannot disturb the portal's layout.
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("z-index", "2147483000", "important");

    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = TDX_PANEL_CSS;
    shadow.appendChild(style);

    root.appendChild(host);
    state.hostEl = host;
    state.shadow = shadow;
    state.refs = null;
    return true;
  }

  function removePanel() {
    if (state.hostEl && state.hostEl.parentNode) {
      state.hostEl.parentNode.removeChild(state.hostEl);
    }
    state.hostEl = null;
    state.shadow = null;
    state.refs = null;
  }

  function buildSkeleton() {
    if (state.refs && state.refs.panel.isConnected) return state.refs;

    var panel = document.createElement("div");
    panel.className = "tdx-panel";
    panel.setAttribute("data-collapsed", String(state.collapsed));

    var header = document.createElement("div");
    header.className = "tdx-header";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.title = "Click to collapse or expand";

    var badge = document.createElement("span");
    badge.className = "tdx-badge";
    badge.textContent = "Docs";

    var title = document.createElement("div");
    title.className = "tdx-title";
    var titleMain = document.createElement("div");
    titleMain.className = "tdx-title-main";
    var titleSub = document.createElement("div");
    titleSub.className = "tdx-title-sub";
    title.appendChild(titleMain);
    title.appendChild(titleSub);

    var actions = document.createElement("div");
    actions.className = "tdx-header-actions";
    var refreshBtn = document.createElement("button");
    refreshBtn.className = "tdx-icon-btn";
    refreshBtn.type = "button";
    refreshBtn.textContent = "Reload";
    refreshBtn.title = "Reload the file list";
    var toggleBtn = document.createElement("button");
    toggleBtn.className = "tdx-icon-btn";
    toggleBtn.type = "button";
    toggleBtn.textContent = "-";
    toggleBtn.title = "Collapse or expand";
    actions.appendChild(refreshBtn);
    actions.appendChild(toggleBtn);

    header.appendChild(badge);
    header.appendChild(title);
    header.appendChild(actions);

    var body = document.createElement("div");
    body.className = "tdx-body";

    var footer = document.createElement("div");
    footer.className = "tdx-footer";
    var note = document.createElement("div");
    note.className = "tdx-footer-note";
    var allBtn = document.createElement("button");
    allBtn.className = "tdx-btn tdx-btn-secondary";
    allBtn.type = "button";
    allBtn.textContent = "Download all";
    footer.appendChild(note);
    footer.appendChild(allBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    state.shadow.appendChild(panel);

    header.addEventListener("click", function (ev) {
      if (ev.target === refreshBtn || ev.target === toggleBtn) return;
      setCollapsed(!state.collapsed);
    });
    header.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        setCollapsed(!state.collapsed);
      }
    });
    toggleBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setCollapsed(!state.collapsed);
    });
    refreshBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (state.tender) load(state.tender, true);
    });
    allBtn.addEventListener("click", function () {
      if (state.bulk) {
        state.bulk.cancelled = true;
      } else {
        downloadAll();
      }
    });

    state.refs = {
      panel: panel,
      titleMain: titleMain,
      titleSub: titleSub,
      body: body,
      footer: footer,
      note: note,
      allBtn: allBtn,
      refreshBtn: refreshBtn,
      toggleBtn: toggleBtn
    };
    return state.refs;
  }

  function setCollapsed(next) {
    state.collapsed = next;
    if (state.refs) {
      state.refs.panel.setAttribute("data-collapsed", String(next));
      state.refs.toggleBtn.textContent = next ? "+" : "-";
    }
  }

  /* ---------------------------------------------------------------- *
   * Tender detection
   * ---------------------------------------------------------------- */

  /* Fallback when the URL carries no tender number: look for one in the page.
   * Deliberately conservative, so a random number on a listing page does not
   * produce a bogus panel. */
  function detectFromDom() {
    var body = document.body;
    if (!body) return null;
    var text = body.innerText || "";
    if (text.length > 400000) text = text.slice(0, 400000);

    var labelled = /(?:num[eé]ro|n[°o]\.?|reference|r[eé]f[eé]rence)[^\S\n]*[:\-]?[^\S\n]*(S?\d{11})\b/i.exec(
      text
    );
    if (labelled) {
      return tdxParseLocation("/portail/x/" + labelled[1]);
    }
    return null;
  }

  function detectTender() {
    var fromUrl = tdxParseLocation(location.href);
    if (fromUrl) return fromUrl;
    return detectFromDom();
  }

  /* ---------------------------------------------------------------- *
   * Network
   * ---------------------------------------------------------------- */

  function fetchWithTimeout(url, options, timeoutMs, externalSignal) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);

    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else
        externalSignal.addEventListener("abort", function () {
          controller.abort();
        });
    }

    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).then(
      function (res) {
        clearTimeout(timer);
        return res;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  }

  function describeNetworkError(err) {
    if (err && err.name === "AbortError") {
      return "The request timed out or was cancelled.";
    }
    return (
      "Could not reach the Tuneps server. Check your connection, then use Reload. " +
      "(" + ((err && err.message) || "network error") + ")"
    );
  }

  /**
   * Fetch the manifest for one tender type, trying each candidate URL.
   * Resolves with {files, warnings, url} or rejects with a human readable Error.
   */
  async function fetchManifestFor(tenderNo, type, signal) {
    var urls = tdxManifestUrls(tenderNo, type);
    var lastError = null;

    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      try {
        var res = await fetchWithTimeout(
          url,
          { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" } },
          REQUEST_TIMEOUT_MS,
          signal
        );
        if (!res.ok) {
          lastError = annotate(
            new Error("The portal answered HTTP " + res.status + " " + (res.statusText || "") + "."),
            url
          );
          continue;
        }
        var text = await res.text();
        var body;
        try {
          body = JSON.parse(text);
        } catch (parseErr) {
          lastError = annotate(
            new Error(
              "The portal answered with something that is not JSON (" +
                text.slice(0, 80).replace(/\s+/g, " ") +
                ")."
            ),
            url
          );
          continue;
        }
        var normalized;
        try {
          normalized = tdxNormalizeManifest(body);
        } catch (shapeErr) {
          // A recognised-but-unhappy payload: report it verbatim, it is already
          // phrased for a human.
          lastError = annotate(shapeErr, url);
          continue;
        }
        return { files: normalized.files, warnings: normalized.warnings, url: url };
      } catch (err) {
        if (signal && signal.aborted) throw err;
        lastError = annotate(new Error(describeNetworkError(err)), url);
      }
    }

    throw lastError || new Error("No manifest endpoint responded.");
  }

  function annotate(err, url) {
    err.url = url;
    return err;
  }

  function load(tender, force) {
    var key = tender.type + ":" + tender.tenderNo;
    if (!force && key === state.currentKey && !state.error) return;

    if (state.abort) state.abort.abort();
    state.abort = new AbortController();
    var signal = state.abort.signal;
    var token = ++state.loadToken;

    state.currentKey = key;
    state.tender = tender;
    state.usedType = tender.type;
    state.files = [];
    state.warnings = [];
    state.error = null;
    state.loading = true;
    state.bulk = null;
    render();

    var primary = tender.type;
    var secondary = tdxOtherType(primary);

    fetchManifestFor(tender.tenderNo, primary, signal)
      .then(function (result) {
        // An empty list may simply mean the type guess was wrong, so try the
        // other endpoint before reporting "no documents".
        if (result.files.length === 0) {
          return fetchManifestFor(tender.tenderNo, secondary, signal).then(
            function (alt) {
              if (alt.files.length > 0) {
                state.usedType = secondary;
                return alt;
              }
              return result;
            },
            function () {
              return result;
            }
          );
        }
        return result;
      })
      .then(
        function (result) {
          if (token !== state.loadToken) return;
          state.loading = false;
          state.files = result.files;
          state.warnings = result.warnings;
          render();
        },
        function (err) {
          if (token !== state.loadToken) return;
          if (signal.aborted) return;
          // The primary type failed outright; give the other endpoint a chance.
          fetchManifestFor(tender.tenderNo, secondary, signal).then(
            function (alt) {
              if (token !== state.loadToken) return;
              state.loading = false;
              state.usedType = secondary;
              state.files = alt.files;
              state.warnings = alt.warnings;
              render();
            },
            function () {
              if (token !== state.loadToken) return;
              state.loading = false;
              state.error = err;
              render();
            }
          );
        }
      );
  }

  /* ---------------------------------------------------------------- *
   * Downloads
   * ---------------------------------------------------------------- */

  function setFileStatus(file, text, kind) {
    file.status = text;
    file.statusKind = kind || "";
    if (file.statusEl) {
      file.statusEl.textContent = text || "";
      file.statusEl.className = "tdx-item-status " + (kind ? "tdx-" + kind : "");
    }
  }

  function saveBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
  }

  /* Last resort: hand the raw URL to the browser. The portal sends
   * Content-Disposition: attachment, so this downloads rather than navigating. */
  function saveByDirectLink(url, fileName) {
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 5000);
  }

  function downloadFile(file) {
    if (!file.downloadable) {
      setFileStatus(file, file.problem || "This entry cannot be downloaded.", "bad");
      return Promise.resolve(false);
    }
    var url = tdxDownloadUrl(file.nodeRef, file.fileName);
    setFileStatus(file, "Downloading...", "busy");
    if (file.btn) file.btn.disabled = true;

    return fetchWithTimeout(
      url,
      { method: "GET", credentials: "same-origin" },
      DOWNLOAD_TIMEOUT_MS,
      null
    )
      .then(function (res) {
        if (!res.ok) {
          throw new Error(
            "The portal answered HTTP " +
              res.status +
              (res.status === 400 ? " (the file reference was rejected)" : "") +
              "."
          );
        }
        return res.blob();
      })
      .then(function (blob) {
        if (!blob || blob.size === 0) throw new Error("The portal returned an empty file.");
        saveBlob(blob, file.fileName);
        setFileStatus(file, "Saved (" + tdxFormatBytes(blob.size) + ")", "ok");
        if (file.btn) file.btn.disabled = false;
        return true;
      })
      .catch(function (err) {
        // If the in-page fetch failed for a reason other than an HTTP error,
        // let the browser fetch it directly before giving up.
        var msg = (err && err.message) || "Download failed.";
        if (!/HTTP \d/.test(msg)) {
          try {
            saveByDirectLink(url, file.fileName);
            setFileStatus(file, "Handed to the browser's downloader.", "ok");
            if (file.btn) file.btn.disabled = false;
            return true;
          } catch (linkErr) {
            /* fall through to the error below */
          }
        }
        setFileStatus(file, msg, "bad");
        if (file.btn) file.btn.disabled = false;
        return false;
      });
  }

  function downloadAll() {
    var queue = state.files.filter(function (f) {
      return f.downloadable;
    });
    if (queue.length === 0) return;

    var bulk = { cancelled: false, done: 0, failed: 0, total: queue.length };
    state.bulk = bulk;
    updateFooter();

    function step(i) {
      if (bulk.cancelled || i >= queue.length || state.bulk !== bulk) {
        state.bulk = null;
        updateFooter();
        return;
      }
      downloadFile(queue[i]).then(function (ok) {
        if (ok) bulk.done += 1;
        else bulk.failed += 1;
        updateFooter();
        setTimeout(function () {
          step(i + 1);
        }, DOWNLOAD_ALL_GAP_MS);
      });
    }

    step(0);
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function render() {
    if (!ensureHost()) return;
    var refs = buildSkeleton();

    var tender = state.tender;
    refs.titleMain.textContent = tender
      ? "Tuneps documents: " + tender.tenderNo
      : "Tuneps documents";

    var subParts = [];
    if (state.usedType) subParts.push(state.usedType);
    if (state.loading) subParts.push("loading...");
    else if (state.error) subParts.push("error");
    else subParts.push(state.files.length + " file" + (state.files.length === 1 ? "" : "s"));
    refs.titleSub.textContent = subParts.join("  |  ");

    refs.body.textContent = "";

    if (state.loading) {
      refs.body.appendChild(messageEl("Loading the document list...", ""));
      updateFooter();
      return;
    }

    if (state.error) {
      var box = messageEl(state.error.message || "Something went wrong.", "error");
      if (state.error.url) {
        var detail = document.createElement("span");
        detail.className = "tdx-message-detail";
        detail.textContent = state.error.url;
        box.appendChild(detail);
      }
      refs.body.appendChild(box);
      updateFooter();
      return;
    }

    for (var w = 0; w < state.warnings.length; w++) {
      refs.body.appendChild(messageEl(state.warnings[w], "warn"));
    }

    if (state.files.length === 0) {
      refs.body.appendChild(
        messageEl(
          "No documents are attached to this tender, or the portal has not published them yet.",
          ""
        )
      );
      updateFooter();
      return;
    }

    var list = document.createElement("ul");
    list.className = "tdx-list";

    state.files.forEach(function (file) {
      var li = document.createElement("li");
      li.className = "tdx-item";

      var seq = document.createElement("div");
      seq.className = "tdx-item-seq";
      seq.textContent = String(file.seqNo);

      var main = document.createElement("div");
      main.className = "tdx-item-main";

      var name = document.createElement("div");
      name.className = "tdx-item-name";
      name.textContent = file.fileName;

      var meta = document.createElement("div");
      meta.className = "tdx-item-meta";
      meta.textContent = file.category || file.docCd || "Uncategorised";

      var status = document.createElement("div");
      status.className = "tdx-item-status " + (file.statusKind ? "tdx-" + file.statusKind : "");
      status.textContent = file.status || (file.downloadable ? "" : file.problem || "");
      if (!file.downloadable && !file.statusKind) status.className = "tdx-item-status tdx-bad";

      main.appendChild(name);
      main.appendChild(meta);
      main.appendChild(status);

      var btn = document.createElement("button");
      btn.className = "tdx-btn";
      btn.type = "button";
      btn.textContent = "Download";
      btn.disabled = !file.downloadable;
      btn.addEventListener("click", function () {
        downloadFile(file);
      });

      file.statusEl = status;
      file.btn = btn;

      li.appendChild(seq);
      li.appendChild(main);
      li.appendChild(btn);
      list.appendChild(li);
    });

    refs.body.appendChild(list);
    updateFooter();
  }

  function updateFooter() {
    if (!state.refs) return;
    var refs = state.refs;
    var downloadable = state.files.filter(function (f) {
      return f.downloadable;
    }).length;

    if (state.bulk) {
      refs.allBtn.textContent = "Stop";
      refs.allBtn.disabled = false;
      refs.note.textContent =
        "Downloading " +
        (state.bulk.done + state.bulk.failed) +
        " of " +
        state.bulk.total +
        (state.bulk.failed ? " (" + state.bulk.failed + " failed)" : "");
      return;
    }

    refs.allBtn.textContent = "Download all";
    refs.allBtn.disabled = downloadable === 0 || state.loading || Boolean(state.error);
    if (state.loading) refs.note.textContent = "Working...";
    else if (state.error) refs.note.textContent = "Use Reload to try again.";
    else if (downloadable === 0) refs.note.textContent = "Nothing to download.";
    else refs.note.textContent = downloadable + " downloadable file" + (downloadable === 1 ? "" : "s");
  }

  function messageEl(text, kind) {
    var el = document.createElement("div");
    el.className = "tdx-message" + (kind ? " tdx-" + kind : "");
    el.appendChild(document.createTextNode(text));
    return el;
  }

  /* ---------------------------------------------------------------- *
   * SPA lifecycle
   * ---------------------------------------------------------------- */

  function tick() {
    try {
      var href = location.href;
      var hrefChanged = href !== state.lastHref;
      state.lastHref = href;

      var tender = detectTender();

      if (!tender) {
        if (state.hostEl) {
          if (state.abort) state.abort.abort();
          state.loadToken += 1;
          state.currentKey = null;
          state.tender = null;
          state.bulk = null;
          removePanel();
        }
        return;
      }

      var key = tender.type + ":" + tender.tenderNo;
      if (key !== state.currentKey) {
        load(tender, false);
      } else if (hrefChanged || !state.hostEl || !state.hostEl.isConnected) {
        // Same tender, but the SPA re-rendered or removed our host node.
        render();
      }
    } catch (err) {
      // Never let a detection failure escape into the portal.
      if (window.console && console.debug) {
        console.debug("[tuneps-downloader] tick failed", err);
      }
    }
  }

  function start() {
    tick();
    setInterval(tick, POLL_MS);
    window.addEventListener("popstate", tick);
    window.addEventListener("hashchange", tick);
    // Cheap safety net for full view swaps that land between polls.
    try {
      var mo = new MutationObserver(function () {
        if (state.hostEl && !state.hostEl.isConnected) tick();
      });
      if (document.documentElement) {
        mo.observe(document.documentElement, { childList: true });
      }
    } catch (err) {
      /* observer is optional */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
