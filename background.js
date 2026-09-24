/**
 * background.js – Bill Cropper Background Service Worker
 *
 * PROBLEM THIS SOLVES
 * ───────────────────
 * The billing server always serves the PDF at the same URL
 * (e.g. /reports/Billing.pdf). When multiple bills are open in different
 * tabs, a fresh fetch() from the popup would return whatever the server
 * currently has – which may be a different bill than the one displayed
 * in the active tab.
 *
 * SOLUTION
 * ────────
 * 1. When any billing-PDF tab finishes loading, this service worker
 *    immediately fetches the PDF bytes and caches them in
 *    chrome.storage.session, keyed by tabId.
 * 2. The popup asks this service worker for the cached bytes for the
 *    active tab. It gets the exact bill that was loaded when the tab
 *    opened, regardless of what the server currently serves.
 * 3. When a tab closes, its cached bytes are cleaned up.
 */

"use strict";

const BILLING_PDF_PATTERN =
  /maricodms\.botreesoftware\.com\/reports\/Billing\.pdf/i;

// ── 1. Cache PDF bytes whenever a billing-PDF tab finishes loading ────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !BILLING_PDF_PATTERN.test(tab.url)) return;

  console.log(
    `[Bill Cropper BG] Tab ${tabId} finished loading – caching PDF bytes…`
  );

  try {
    const response = await fetch(tab.url, { credentials: "include" });

    if (!response.ok) {
      console.warn(
        `[Bill Cropper BG] Server returned HTTP ${response.status} for tab ${tabId} – not cached.`
      );
      return;
    }

    const buffer = await response.arrayBuffer();
    const bytes  = new Uint8Array(buffer);

    if (bytes.length === 0) {
      console.warn(
        `[Bill Cropper BG] Server returned 0 bytes for tab ${tabId} – not caching.\n` +
        "The server may require the request to come from a browser tab context."
      );
      return;
    }

    // chrome.storage.session supports Uint8Array via structured clone.
    // Data survives service-worker termination (it lives in Chrome's
    // storage system, not in the worker's RAM).
    await chrome.storage.session.set({ [`pdf_${tabId}`]: bytes });

    console.log(
      `[Bill Cropper BG] Cached ${bytes.length} bytes for tab ${tabId}.`
    );
  } catch (err) {
    console.warn(
      `[Bill Cropper BG] Could not cache PDF for tab ${tabId}:`,
      err.message
    );
  }
});

// ── 2. Clean up cached bytes when a tab is closed ─────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`pdf_${tabId}`).catch(() => {});
});

// ── 3. Respond to popup messages requesting cached bytes ──────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_PDF_BYTES") return false;

  const key = `pdf_${message.tabId}`;
  chrome.storage.session
    .get(key)
    .then((result) => {
      sendResponse({ bytes: result[key] ?? null });
    })
    .catch((err) => {
      console.warn("[Bill Cropper BG] Storage read failed:", err.message);
      sendResponse({ bytes: null });
    });

  // Return true to keep the message channel open for the async sendResponse.
  return true;
});
