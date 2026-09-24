BILL CROPPER – LANDSCAPE A5  (v1.2.0)
======================================

GitHub : https://github.com/Siddesh2004/bill_crop_extension

Reads the billing PDF that is currently open in Chrome, dynamically detects
the invoice boundaries using text extraction, crops the invoice from the TAX
INVOICE heading down to the "Amount In Words / For: NAMRTA AGENCIES" row, and
opens a print-ready A5 landscape PDF in a new tab. Nothing is printed
automatically; you use Chrome's own Print button.

The original PDF is never modified or uploaded. All processing happens locally
in your browser.


REQUIREMENTS
────────────
• Chrome (any recent version)
• Node.js ≥ 18  ← only needed IF you want to rebuild the bundle yourself
• You must be logged in to the billing website before using the extension.


══════════════════════════════════════════════════════════
  INSTALL ON ANOTHER LAPTOP  (no zip file, no Node.js)
══════════════════════════════════════════════════════════

Step 1 – Make sure Git is installed on the other laptop.
         Download from: https://git-scm.com/downloads
         (Accept all defaults during install.)

Step 2 – Open a terminal / command prompt and run:

         git clone https://github.com/Siddesh2004/bill_crop_extension.git

         This downloads the extension folder to wherever your terminal is
         currently open (e.g. C:\Users\YourName\bill_crop_extension).

Step 3 – Open Chrome and go to:   chrome://extensions

Step 4 – Turn on  Developer mode  (toggle in the top-right corner).

Step 5 – Click  Load unpacked.
         In the folder picker, select the  bill_crop_extension  folder
         that was just downloaded in Step 2.

Step 6 – "Bill Cropper – Landscape A5" now appears in the extension list. ✓

Step 7 – Pin it to the Chrome toolbar:
         Click the puzzle-piece icon → click the pin next to Bill Cropper.

Done!  Node.js and npm are NOT required on the other laptop because the
built file (popup.bundle.js) is already included in the repository.

──────────────────────────────────────────────────────────
  Getting future updates on the other laptop
──────────────────────────────────────────────────────────
When the extension is updated, run this inside the bill_crop_extension folder:

    git pull

Then go to chrome://extensions and click the  ↺  (refresh) icon on the
Bill Cropper card.  No rebuild needed.

══════════════════════════════════════════════════════════


BUILD  (only needed when changing source code)
──────────────────────────────────────────────
Run these commands once from the extension folder:

    npm install
    node build.js

After the build you should see:

    popup.bundle.js  (~2 MB)   – bundled extension script
    pdf.worker.min.mjs         – PDF.js worker

Commit and push the rebuilt files so other laptops get the update:

    git add .
    git commit -m "describe what changed"
    git push


INSTALL / RELOAD IN CHROME  (on the development laptop)
────────────────────────────────────────────────────────
1. Open  chrome://extensions
2. Enable  Developer mode  (toggle, top right).
3. Click  Load unpacked  and select this folder (the one containing
   manifest.json).
4. The "Bill Cropper – Landscape A5" extension card appears.

After any code change, rebuild with  node build.js  and then click the
circular refresh icon on the extension card in chrome://extensions.



USAGE
─────
1. Log in to the billing website in Chrome.
2. Open the invoice PDF directly in a Chrome tab
   (e.g. https://maricodms.botreesoftware.com/reports/Billing.pdf).
3. Click the Bill Cropper icon in the Chrome toolbar.
4. Click  Crop current PDF.
5. Watch the status messages:
     Reading current PDF…
     Detecting invoice boundaries…
     Cropping invoice…
     Preparing A5 landscape output…
     Opening cropped PDF…
6. A new tab opens with the cropped A5 landscape PDF.
7. Use  Ctrl+P  (or Chrome's Print button) to print.
   In the print dialog, confirm paper size is A5 and orientation is Landscape.


OUTPUT FORMAT
─────────────
• Page size : A5 landscape  (210 × 148 mm / 595 × 420 pt)
• The invoice is scaled to fit the A5 canvas while preserving its aspect ratio.
• The invoice is centred on the page.
• Content below the "Amount In Words / For: NAMRTA AGENCIES" row is excluded.
• The output PDF is self-contained (data: URI). It is safe to close the
  extension popup after the new tab opens.


TROUBLESHOOTING
───────────────
"The active tab does not appear to be a PDF."
→ Make sure the billing PDF is open in the active Chrome tab and that the
  extension popup was opened from that tab.

"Could not download the PDF (HTTP 4xx)."
→ Your session may have expired. Reload the billing website, log in again,
  then try the extension.

"Invoice boundary detection failed: Could not find TAX INVOICE…"
→ The PDF may not contain a searchable text layer (it might be a scanned image).
  Open the extension popup, right-click inside it, choose Inspect, then open
  the Console tab and look for the "[Bill Cropper] Extracted text lines" group.
  Share the console output so the detection logic can be adjusted.

"Could not find Amount In Words."
→ Same as above. The detection is case-insensitive and handles phrases split
  across text items, but if the PDF spells the phrase differently it will fail.
  Check the console dump as described above.

The cropped content is cut off or the invoice is incomplete.
→ The MARGIN_PX constant in findInvoiceBounds.js (default: 8 px) controls
  padding around the detected boundaries. Increase it and rebuild if needed.

The print dialog shows the wrong paper size.
→ In Chrome's Print dialog, under "More settings", change Paper size to A5
  and Layout to Landscape manually.


NOTES AND LIMITATIONS
──────────────────────
• The extension uses Chrome's existing authenticated session (cookies) to
  fetch the PDF. No credentials are stored or transmitted by the extension.

• Host access is intentionally limited to  https://maricodms.botreesoftware.com/*
  in manifest.json. If the PDF is served from a different host, update
  host_permissions and rebuild.

• Chrome's built-in PDF viewer cannot be replaced in place by a toolbar
  extension popup, so the output always opens in a new tab.

• If the billing site uses JavaScript-generated or URL-redirect-based PDF
  delivery (not a direct PDF URL), the extension may not be able to detect
  the active PDF. Contact the developer in that case.

• The extension does not work with scanned/image-only PDFs (no text layer).


FILES IN THIS FOLDER
─────────────────────
manifest.json          Extension manifest (MV3)
popup.html             Extension popup UI
popup.bundle.js        Bundled extension script (built by node build.js)
pdf.worker.min.mjs     PDF.js background worker (required at runtime)
popup.js               Source: popup main logic
findInvoiceBounds.js   Source: PDF.js text detection and coordinate mapping
build.js               Build script (esbuild)
package.json           Node.js dependencies
node_modules/          Installed packages (pdf-lib, pdfjs-dist, esbuild)
