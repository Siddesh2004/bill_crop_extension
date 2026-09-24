/**
 * build.js – esbuild configuration for Bill Cropper Chrome Extension
 *
 * Produces two output files:
 *   popup.bundle.js  – Everything the popup needs (popup logic + pdf-lib +
 *                      findInvoiceBounds + pdfjs-dist main library), as IIFE.
 *   pdf.worker.min.mjs is NOT bundled; it is already a static file copied
 *                      from node_modules during the copy step below.
 *
 * The pdf.js worker is referenced at runtime via chrome.runtime.getURL()
 * so esbuild must NOT inline it.
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// ─── 1. Copy pdf.worker.min.mjs from node_modules if not present ─────────────
const workerSrc = path.join(
  __dirname,
  "node_modules",
  "pdfjs-dist",
  "legacy",
  "build",
  "pdf.worker.min.mjs"
);
const workerDst = path.join(__dirname, "pdf.worker.min.mjs");

if (!fs.existsSync(workerDst)) {
  fs.copyFileSync(workerSrc, workerDst);
  console.log("Copied pdf.worker.min.mjs");
} else {
  console.log("pdf.worker.min.mjs already present");
}

// ─── 2. Bundle popup.js (includes pdf-lib + pdfjs-dist + findInvoiceBounds) ──
esbuild
  .build({
    entryPoints: ["popup.js"],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: "popup.bundle.js",
    logLevel: "info",

    // pdf.js v6 uses dynamic import() for its worker internally.
    // Mark it as external so esbuild does not try to bundle it.
    // The runtime sets GlobalWorkerOptions.workerSrc explicitly.
    external: [],

    // Some pdfjs-dist internals reference Node globals; polyfill them.
    define: {
      "process.env.NODE_ENV": '"production"',
      global: "globalThis"
    },

    // Allow newer syntax in the pdfjs-dist ESM source.
    target: ["chrome120"],

    // Silence "CommonJS or AMD" warnings from pdf-lib.
    banner: {
      js: "/* Bill Cropper popup bundle */"
    }
  })
  .then(() => {
    console.log("popup.bundle.js built successfully.");
  })
  .catch(() => process.exit(1));