/**
 * findInvoiceBounds.js
 *
 * Accepts a pdfjs-dist library object and raw PDF bytes.
 * Returns the crop boundaries in PDF.js VIEWPORT coordinates
 * (top-left origin, scale 1 = 1 CSS/device px per PDF point at 96dpi /72dpi).
 *
 * Coordinate system returned
 * ──────────────────────────
 *  (0,0) ─────────────────── pageWidth
 *    │                            │
 *    │   topViewport              │
 *    │   ↓                        │
 *    │   [  invoice content  ]    │
 *    │   ↑                        │
 *    │   bottomViewport           │
 *    │                            │
 *  pageHeight ──────────────────────
 *
 *  topViewport    – distance from the TOP of the page to the top of the
 *                   TAX INVOICE heading (pixels).
 *  bottomViewport – distance from the TOP of the page to the BOTTOM of the
 *                   Amount In Words / NAMRTA AGENCIES row (pixels).
 *
 * The caller (popup.js) converts these to pdf-lib bottom-left coordinates:
 *   pdfLibY_bottom = mediaBoxHeight - bottomViewport
 *   pdfLibY_top    = mediaBoxHeight - topViewport
 */

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const MARGIN_PX = 8; // extra padding added around detected bounds

export async function findInvoiceBounds(bytes) {
  // ── 1. Load document ────────────────────────────────────────────────────────
  const loadingTask = pdfjsLib.getDocument({
    data: bytes, // Uint8Array – caller must pass a dedicated copy
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    // We only extract text; we don't render. useSystemFonts suppresses
    // the "standardFontDataUrl not provided" warning from pdfjs-dist v6.
    useSystemFonts: true
  });

  const pdf = await loadingTask.promise;

  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });

    // ── 2. Map every text item to viewport-space coordinates ─────────────────
    const rawItems = content.items
      .filter((item) => item.str && item.str.trim().length > 0)
      .map((item) => {
        // item.transform is a 6-element PDF CTM [a,b,c,d,e,f].
        // Util.transform(viewport.transform, item.transform) gives us the
        // viewport-space position of the text baseline.
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);

        // tx[4] = x, tx[5] = y (viewport baseline y from TOP)
        // item font size is sqrt(a²+b²) in viewport units
        const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);

        return {
          text: item.str.trim(),
          x: tx[4],
          y: tx[5],                          // baseline from top
          height: fontSize || item.height || 10,
          width: item.width || 0
        };
      });

    if (rawItems.length === 0) {
      throw new Error(
        "No readable text found in the PDF. The PDF may be image-based (scanned)."
      );
    }

    // ── 3. Group items into visual lines ──────────────────────────────────────
    // Items on the same visual row share a similar baseline y.
    // Tolerance: 4 px (handles sub-pixel differences in PDF matrices).
    const Y_TOLERANCE = 4;
    const lines = [];

    for (const item of rawItems) {
      let line = lines.find((l) => Math.abs(l.baselineY - item.y) <= Y_TOLERANCE);
      if (!line) {
        line = { baselineY: item.y, items: [] };
        lines.push(line);
      }
      line.items.push(item);
    }

    // Sort items within each line left-to-right, then build the full line text.
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      // Join with a space; normalise whitespace; uppercase for matching.
      line.text = line.items
        .map((i) => i.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
    }

    // Sort lines top-to-bottom (increasing y in viewport = increasing distance from top).
    lines.sort((a, b) => a.baselineY - b.baselineY);

    // Diagnostic dump – always logged so you can inspect what the PDF contains.
    console.group("[Bill Cropper] Extracted text lines");
    lines.forEach((l, i) =>
      console.log(`  [${i}] y=${l.baselineY.toFixed(1)}  "${l.text}"`)
    );
    console.groupEnd();

    // ── 4. Find required text anchors ─────────────────────────────────────────
    // Helper: test if a line contains every token of a phrase (handles split items).
    function lineContains(line, phrase) {
      const tokens = phrase.toUpperCase().split(/\s+/);
      return tokens.every((t) => line.text.includes(t));
    }

    const headingLine = lines.find((l) => lineContains(l, "TAX INVOICE"));

    // "Amount In Words" may be split across items; look for "AMOUNT" + "WORDS".
    const amountLine = lines.find(
      (l) => lineContains(l, "AMOUNT") && lineContains(l, "WORDS")
    );

    // "NAMRTA AGENCIES" – the occurrence CLOSEST to amountLine (not the header).
    const agencyLines = lines.filter((l) => lineContains(l, "NAMRTA"));

    // Build a user-readable diagnostics string for error messages.
    const diagnosticText = lines.map((l) => `"${l.text}"`).join("\n");

    if (!headingLine) {
      throw new Error(
        `Could not find "TAX INVOICE" in the PDF text.\n\n` +
        `Extracted text lines:\n${diagnosticText}\n\n` +
        `Check the DevTools console for the full dump.`
      );
    }

    if (!amountLine) {
      throw new Error(
        `Could not find "Amount In Words" in the PDF text.\n\n` +
        `Extracted text lines:\n${diagnosticText}\n\n` +
        `Check the DevTools console for the full dump.`
      );
    }

    // Pick the agency occurrence nearest to amountLine (not the one in the letterhead).
    let agencyLine = null;
    if (agencyLines.length > 0) {
      agencyLine = agencyLines.reduce((best, l) => {
        const d = Math.abs(l.baselineY - amountLine.baselineY);
        const bd = Math.abs(best.baselineY - amountLine.baselineY);
        return d < bd ? l : best;
      });
    }

    // Top boundary: use the topmost text edge across ALL items on the page.
    // In viewport coords (Y from top, increasing downward), the top edge of a
    // text item is at  item.y - item.height  (baseline minus ascent height).
    // Taking the minimum of these gives us the very first pixel of text on the
    // page, eliminating any blank top margin from the original PDF.
    const TOP_MARGIN_PX = 4;  // tiny breathing room so the first character isn't clipped
    const topmostEdge = Math.min(...rawItems.map((i) => i.y - i.height));
    const topViewport = Math.max(0, topmostEdge - TOP_MARGIN_PX);


    // Bottom boundary: tight crop just below the Amount In Words / Agency row.
    // Use only 2 px below the baseline – enough for descenders but NOT enough
    // to pull in the next line ("E. & O.E. Declaration…").
    const BOTTOM_MARGIN_PX = 2;
    const rowY = agencyLine
      ? Math.max(amountLine.baselineY, agencyLine.baselineY)
      : amountLine.baselineY;

    // Add the font height below the baseline to capture descenders.
    const rowFontHeight = amountLine.items[0].height;
    const bottomViewport = Math.min(
      viewport.height,
      rowY + rowFontHeight + BOTTOM_MARGIN_PX
    );


    // Full page width (keep left/right intact; don't clip invoice columns).
    const leftViewport = 0;
    const rightViewport = viewport.width;

    return {
      topViewport,
      bottomViewport,
      leftViewport,
      rightViewport,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      // Human-readable info for debugging
      headingText: headingLine.text,
      amountText: amountLine.text,
      agencyText: agencyLine ? agencyLine.text : "(not found – using amount row only)"
    };
  } finally {
    // In pdfjs-dist v6, destroy() lives on the loadingTask, not the pdf proxy.
    await loadingTask.destroy();
  }
}