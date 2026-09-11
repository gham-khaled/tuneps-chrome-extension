/*
 * styles.js - the panel stylesheet, kept as a string so it can be injected
 * into a closed-ish shadow root instead of the host page.
 *
 * Nothing here is a content_scripts "css" entry on purpose: a normal CSS
 * injection would land in the portal's own document and could collide with
 * Bootstrap/Angular Material rules. Inside a shadow root the rules cannot
 * leak out, and the host page's rules cannot leak in.
 */

var TDX_PANEL_CSS = `
:host {
  all: initial;
}

* {
  box-sizing: border-box;
}

.tdx-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  width: 400px;
  max-width: calc(100vw - 32px);
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: #0f172a;
  background: #ffffff;
  border: 2px solid #0f766e;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.28);
  overflow: hidden;
}

.tdx-panel[data-collapsed="true"] {
  max-height: none;
}

.tdx-panel[data-collapsed="true"] .tdx-body,
.tdx-panel[data-collapsed="true"] .tdx-footer {
  display: none;
}

/* ---------- header ---------- */

.tdx-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #0f766e;
  color: #f0fdfa;
  cursor: pointer;
  user-select: none;
}

.tdx-badge {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: #f59e0b;
  color: #451a03;
  padding: 2px 6px;
  border-radius: 4px;
}

.tdx-title {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.tdx-title-main {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tdx-title-sub {
  font-size: 11px;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tdx-header-actions {
  flex: none;
  display: flex;
  gap: 4px;
}

.tdx-icon-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 5px 7px;
  border: 1px solid rgba(240, 253, 250, 0.4);
  border-radius: 5px;
  background: transparent;
  color: #f0fdfa;
  cursor: pointer;
}

.tdx-icon-btn:hover:not(:disabled) {
  background: rgba(240, 253, 250, 0.16);
}

.tdx-icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ---------- body ---------- */

.tdx-body {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  background: #f8fafc;
}

.tdx-message {
  padding: 10px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #334155;
}

.tdx-message.tdx-error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

.tdx-message.tdx-warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  margin-bottom: 8px;
  font-size: 12px;
}

.tdx-message-detail {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
  opacity: 0.8;
}

.tdx-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tdx-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
}

.tdx-item-seq {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #e2e8f0;
  color: #475569;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tdx-item-main {
  flex: 1 1 auto;
  min-width: 0;
}

.tdx-item-name {
  font-weight: 600;
  word-break: break-word;
}

.tdx-item-meta {
  font-size: 11px;
  color: #64748b;
  word-break: break-word;
}

.tdx-item-status {
  font-size: 11px;
  margin-top: 2px;
}

.tdx-item-status.tdx-ok {
  color: #15803d;
}

.tdx-item-status.tdx-bad {
  color: #b91c1c;
}

.tdx-item-status.tdx-busy {
  color: #b45309;
}

.tdx-btn {
  flex: none;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 10px;
  border: 1px solid #0f766e;
  border-radius: 5px;
  background: #0f766e;
  color: #ffffff;
  cursor: pointer;
}

.tdx-btn:hover:not(:disabled) {
  background: #115e59;
}

.tdx-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.tdx-btn-secondary {
  background: #ffffff;
  color: #0f766e;
}

.tdx-btn-secondary:hover:not(:disabled) {
  background: #ccfbf1;
}

/* ---------- footer ---------- */

.tdx-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid #e2e8f0;
  background: #ffffff;
}

.tdx-footer-note {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tdx-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`;
