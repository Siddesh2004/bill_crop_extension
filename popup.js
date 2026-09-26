/**
 * popup.js – Bill Cropper Chrome Extension
 *
 * Reads the billing PDF open in the current tab, dynamically detects the
 * invoice boundaries using PDF.js text extraction, crops the invoice region,
 * and opens the result as the best-fit print page in a new tab.
 *
 * Smart page selection: tries A5 landscape first; if the invoice has many
 * items and would be scaled too small to read, it automatically upgrades
 * to A4 landscape, then A4 portrait — always using the smallest format
 * that keeps text readable.
 *
 * Nothing is printed automatically. The original PDF is never modified.
 */

import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { findInvoiceBounds } from "./findInvoiceBounds.js";

// ── Page size definitions (PDF points; 1 pt = 1/72 inch) ─────────────────────
const PAGES = {
  A5_LANDSCAPE: { name: "A5 landscape", width: 595.28, height: 419.53 }, // 210×148 mm
  A4_LANDSCAPE: { name: "A4 landscape", width: 841.89, height: 595.28 }, // 297×210 mm
  A4_PORTRAIT:  { name: "A4 portrait",  width: 595.28, height: 841.89 }, // 210×297 mm
};

// Minimum scale considered "readable". Below this the extension upgrades format.
const MIN_READABLE_SCALE = 0.80;

// Items threshold: 6+ items → skip A5, use A4 sized pages.
const LARGE_INVOICE_ITEM_THRESHOLD = 6;

/**
 * Pick the best output page for the given crop dimensions.
 *
 * Key insight: the invoice content is PORTRAIT-shaped (full A4 width, tall with
 * many rows). Placing portrait content on a landscape page wastes horizontal
 * space and shrinks the text. We therefore match page orientation to content
 * orientation — portrait crop → try portrait page first, landscape crop →
 * landscape page first — so the content fills the page at maximum scale.
 *
 * For 6+ items A5 landscape is always skipped.
 *
 * @param {number} cropWidth  – crop width  in PDF points
 * @param {number} cropHeight – crop height in PDF points
 * @param {number} itemCount  – number of line items detected in the invoice
 * @returns {{ name:string, width:number, height:number, scale:number }}
 */
function choosePage(cropWidth, cropHeight, itemCount = 0) {
  const isLarge       = itemCount >= LARGE_INVOICE_ITEM_THRESHOLD;
  const cropIsPortrait = cropHeight >= cropWidth; // bill content taller than wide

  // Build candidate list with best-fit orientation first.
  // Portrait content → portrait page before landscape (fills width perfectly).
  // Landscape content → landscape page before portrait.
  let candidates;

  if (isLarge) {
    // 6+ items: A5 skipped entirely.
    candidates = cropIsPortrait
      ? [PAGES.A4_PORTRAIT, PAGES.A4_LANDSCAPE]
      : [PAGES.A4_LANDSCAPE, PAGES.A4_PORTRAIT];
  } else {
    candidates = cropIsPortrait
      ? [PAGES.A5_LANDSCAPE, PAGES.A4_PORTRAIT, PAGES.A4_LANDSCAPE]
      : [PAGES.A5_LANDSCAPE, PAGES.A4_LANDSCAPE, PAGES.A4_PORTRAIT];
  }

  for (const page of candidates) {
    const scale = Math.min(page.width / cropWidth, page.height / cropHeight);
    if (scale >= MIN_READABLE_SCALE) {
      return { ...page, scale };
    }
  }

  // Fallback: first candidate regardless of scale.
  const fallback = candidates[0];
  const scale = Math.min(fallback.width / cropWidth, fallback.height / cropHeight);
  return { ...fallback, scale };
}

// ── Wire up PDF.js worker ─────────────────────────────────────────────────────
// The worker file is in the extension root alongside manifest.json.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL("pdf.worker.min.mjs");

// ── UI elements ───────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status");
const button   = document.getElementById("go");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c0392b" : "#27ae60";
}

function setProgress(msg) {
  statusEl.textContent = msg;
  statusEl.style.color = "#333";
}

// ── Main handler ──────────────────────────────────────────────────────────────
button.addEventListener("click", async () => {
  button.disabled = true;
  setProgress("Reading current PDF…");

  try {
    // ── Stage 1: Identify the active tab PDF ─────────────────────────────────
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      throw new Error("Cannot read the current tab URL. Try reopening the PDF.");
    }

    const url = tab.url;
    const isLocalFile = url.startsWith("file://");
    const isPdfUrl = /\.pdf(\?.*)?$/i.test(url) ||
                     url.toLowerCase().includes("billing.pdf");

    if (!isPdfUrl && !isLocalFile) {
      throw new Error(
        "The active tab does not appear to be a PDF.\n" +
        "Please open the billing PDF in Chrome and try again."
      );
    }

    let pdfJsBytes, pdfLibBytes;

    // ── Path A: local file:// PDF ─────────────────────────────────────────────
    // fetch() cannot read file:// URLs from an extension popup context.
    // Instead inject a tiny script into the PDF tab itself, which CAN fetch
    // its own local URL, and return the bytes back to us.
    // REQUIRES: "Allow access to file URLs" enabled for this extension in
    //           chrome://extensions → Bill Cropper → Details.
    if (isLocalFile) {
      let scriptResult;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            try {
              const r = await fetch(location.href);
              const buf = await r.arrayBuffer();
              // Return as plain array – serialisable through the message channel.
              return { ok: true, bytes: Array.from(new Uint8Array(buf)) };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          }
        });
        scriptResult = results?.[0]?.result;
      } catch (injectionErr) {
        throw new Error(
          "Could not read the local PDF file.\n\n" +
          "Please enable 'Allow access to file URLs' for this extension:\n" +
          "1. Go to chrome://extensions\n" +
          "2. Click Details on Bill Cropper\n" +
          "3. Turn on 'Allow access to file URLs'\n" +
          "4. Try again."
        );
      }

      if (!scriptResult?.ok || !scriptResult.bytes?.length) {
        throw new Error(
          scriptResult?.error
            ? "Could not read local PDF: " + scriptResult.error
            : "The local PDF file appears to be empty or unreadable."
        );
      }

      const arr = new Uint8Array(scriptResult.bytes);
      pdfJsBytes  = arr.slice();
      pdfLibBytes = arr.slice();

    } else {
    // ── Path B: https:// billing URL ─────────────────────────────────────────
    // Prefer the background worker's cached bytes (per-tab), fall back to a
    // direct fetch if the cache is empty or returned 0 bytes.

    try {
      const bgResp = await chrome.runtime.sendMessage({
        type: "GET_PDF_BYTES",
        tabId: tab.id
      });

      // IMPORTANT: check length > 0. An empty Uint8Array is truthy but useless.
      // The background SW may get 0 bytes if the server restricts the SW context.
      if (bgResp?.bytes && bgResp.bytes.length > 0) {
        const arr = (bgResp.bytes instanceof Uint8Array)
          ? bgResp.bytes
          : new Uint8Array(Object.values(bgResp.bytes));

        pdfJsBytes  = arr.slice();   // independent copy for PDF.js
        pdfLibBytes = arr.slice();   // independent copy for pdf-lib
        console.log("[Bill Cropper] Using cached PDF bytes from background worker.");
      }
    } catch (_) {
      // Background service worker unavailable (e.g. extension just installed).
    }

    if (!pdfJsBytes) {
      // ── Fallback: direct fetch ───────────────────────────────────────────
      // The background worker couldn't cache the bytes for this tab.
      // Warn if multiple billing tabs are open (server returns whichever
      // bill is currently active, not the one this tab originally displayed).
      const allBillingTabs = await chrome.tabs.query({ url: url });

      if (allBillingTabs.length > 1) {
        setProgress(
          "⚠ Multiple billing tabs are open.\n" +
          "Close all other billing tabs so the server gives you\n" +
          "the correct bill, then click Crop again.\n\n" +
          "Attempting crop anyway…"
        );
        // Short pause so the user can read the warning before we proceed.
        await new Promise(r => setTimeout(r, 1500));
      }

      const response = await fetch(url, { credentials: "include" });

      if (!response.ok) {
        throw new Error(
          `Could not download the PDF (HTTP ${response.status}).\n` +
          "Make sure you are logged in and the billing page is open."
        );
      }

      const rawBuffer = await response.arrayBuffer();
      if (rawBuffer.byteLength === 0) {
        throw new Error(
          "The server returned an empty file.\n" +
          "Your session may have expired — please log in again and reopen the bill."
        );
      }

      pdfJsBytes  = new Uint8Array(rawBuffer).slice();
      pdfLibBytes = new Uint8Array(rawBuffer).slice();
    }

    } // end else (Path B: https://)

    // ── Stage 2: Text detection ──────────────────────────────────────────────
    setProgress("Detecting invoice boundaries…");

    let bounds;
    try {
      bounds = await findInvoiceBounds(pdfJsBytes);
    } catch (detectionErr) {
      // Re-throw with a user-friendly prefix.
      throw new Error(
        "Invoice boundary detection failed:\n" + detectionErr.message
      );
    }

    console.log("[Bill Cropper] Detected bounds:", bounds, "| items:", bounds.itemCount);

    // ── Stage 3: Load the PDF with pdf-lib ───────────────────────────────────
    setProgress("Cropping invoice…");

    const srcDoc   = await PDFDocument.load(pdfLibBytes);
    const srcPages = srcDoc.getPages();

    if (srcPages.length === 0) {
      throw new Error("The PDF has no pages.");
    }

    const srcPage = srcPages[0];

    // pdf-lib gives us the page size in PDF points (bottom-left origin).
    // These should match the PDF.js viewport dimensions at scale=1 because
    // PDF.js viewport at scale=1 maps 1 pt → 1 CSS px.
    const { width: pdfWidth, height: pdfHeight } = srcPage.getSize();

    // ── Stage 4: Coordinate translation ──────────────────────────────────────
    //
    // PDF.js viewport (scale=1, no rotation):
    //   Origin = top-left corner of page.
    //   Y increases downward.
    //   bounds.topViewport    = distance from TOP of page to start of invoice.
    //   bounds.bottomViewport = distance from TOP of page to end of invoice.
    //
    // pdf-lib coordinate system:
    //   Origin = bottom-left corner of page.
    //   Y increases upward.
    //
    // Translation:
    //   pdfLib_y = pdfHeight - viewportY
    //
    // CropBox is defined as [x, y, width, height] where (x,y) is the
    // BOTTOM-LEFT corner of the crop rectangle.

    const cropX      = 0;                                         // full width
    const cropY      = pdfHeight - bounds.bottomViewport;         // bottom of crop (pdf-lib)
    const cropWidth  = pdfWidth;
    const cropHeight = bounds.bottomViewport - bounds.topViewport; // height of crop region

    if (cropHeight <= 0) {
      throw new Error(
        "Computed crop height is zero or negative. " +
        "The invoice boundaries may have been detected incorrectly.\n" +
        `topViewport=${bounds.topViewport.toFixed(1)}, ` +
        `bottomViewport=${bounds.bottomViewport.toFixed(1)}`
      );
    }

    // ── Stage 5: Smart page selection & output document ──────────────────────
    //
    // choosePage() picks the smallest standard page (A5 landscape → A4 landscape
    // → A4 portrait) where the invoice fits at ≥ MIN_READABLE_SCALE so the text
    // is never squeezed unreadably small when there are many line items.

    const page = choosePage(cropWidth, cropHeight, bounds.itemCount);
    setProgress(`Preparing ${page.name} output…`);

    const outputDoc = await PDFDocument.create();

    // Embed the source page. pdf-lib embedPage() respects the CropBox if set,
    // but we specify our crop rectangle explicitly via the `sourceArea` option.
    const embeddedPage = await outputDoc.embedPage(srcPage, {
      left:   cropX,
      bottom: cropY,
      right:  cropX + cropWidth,
      top:    cropY + cropHeight
    });

    // Scale the embedded crop to fill the chosen page (preserve aspect ratio).
    const scaleX = page.width  / cropWidth;
    const scaleY = page.height / cropHeight;
    const scale  = Math.min(scaleX, scaleY);

    const scaledW = cropWidth  * scale;
    const scaledH = cropHeight * scale;

    // Centre the scaled invoice on the output page.
    const drawX = (page.width  - scaledW) / 2;
    const drawY = (page.height - scaledH) / 2;

    const outPage = outputDoc.addPage([page.width, page.height]);

    outPage.drawPage(embeddedPage, {
      x:      drawX,
      y:      drawY,
      width:  scaledW,
      height: scaledH
    });

    // ── Stage 6: Save and open in a new tab ──────────────────────────────────
    setProgress("Opening cropped PDF…");

    const outputBytes = await outputDoc.save();

    // Encode as base64 data URI so the PDF persists after the popup closes.
    const base64 = _uint8ToBase64(outputBytes);
    const dataUri = `data:application/pdf;base64,${base64}`;

    await chrome.tabs.create({ url: dataUri });

    const pct = Math.round(scale * 100);
    setStatus(
      `✓ Cropped PDF opened (${page.name}, ${pct}% scale).\n` +
      `Inspect the crop, then use Chrome's Print button.\n` +
      `Set paper size to "${page.name}" in the print dialog.`
    );

  } catch (err) {
    console.error("[Bill Cropper] Error:", err);
    setStatus(
      "Error: " + (err.message || "Something went wrong.\nSee the DevTools console for details."),
      true
    );
  } finally {
    button.disabled = false;
  }
});

/**
 * Convert a Uint8Array to a base64 string without hitting the call-stack
 * size limit that String.fromCharCode.apply() causes on large buffers.
 */
function _uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}