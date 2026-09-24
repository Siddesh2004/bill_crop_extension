import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extract text positions from the first page of the invoice.
 *
 * PDF.js viewport coordinates have their origin at the top-left.
 */
export async function findInvoiceBounds(bytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false
  });

  const pdf = await loadingTask.promise;

  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items = content.items
      .filter(item => item.str && item.str.trim())
      .map(item => {
        const tx = pdfjsLib.Util.transform(
          viewport.transform,
          item.transform
        );

        const height = Math.hypot(tx[2], tx[3]);

        return {
          text: item.str.trim(),
          x: tx[4],
          y: tx[5],
          height: height || 10,
          width: item.width || 0
        };
      });

    if (!items.length) {
      throw new Error("No readable text found in the PDF.");
    }

    // Find the TAX INVOICE heading.
    const heading = items.find(item =>
      item.text.toUpperCase().includes("TAX INVOICE")
    );

    // Find Amount In Words.
    const amount = items.find(item =>
      /AMOUNT\s*IN\s*WORDS/i.test(item.text)
    );

    if (!heading) {
      throw new Error("Could not find TAX INVOICE.");
    }

    if (!amount) {
      throw new Error("Could not find Amount In Words.");
    }

    /*
     * The sender information near the top also contains
     * NAMRTA AGENCIES. Choose the occurrence closest to
     * Amount In Words, not the first occurrence on the page.
     */
    const agencyItems = items.filter(item =>
      /NAMRTA\s+AGENCIES/i.test(item.text)
    );

    if (!agencyItems.length) {
      throw new Error("Could not find NAMRTA AGENCIES.");
    }

    const agency = agencyItems.reduce((best, item) => {
      const distance = Math.abs(item.y - amount.y);
      const bestDistance = Math.abs(best.y - amount.y);

      return distance < bestDistance ? item : best;
    });

    /*
     * Find the nearest matching text baseline.
     * Amount and agency should normally be on the same line.
     */
    const lineY = (amount.y + agency.y) / 2;

    const lineItems = items.filter(item =>
      Math.abs(item.y - lineY) <=
      Math.max(4, Math.min(amount.height, agency.height))
    );

    const lineTop = Math.min(
      ...lineItems.map(item => item.y - item.height)
    );

    const lineBottom = Math.max(
      ...lineItems.map(item => item.y)
    );

    return {
      pageWidth: viewport.width,
      pageHeight: viewport.height,

      heading: {
        text: heading.text,
        x: heading.x,
        y: heading.y,
        height: heading.height
      },

      amount: {
        text: amount.text,
        x: amount.x,
        y: amount.y,
        height: amount.height
      },

      agency: {
        text: agency.text,
        x: agency.x,
        y: agency.y,
        height: agency.height
      },

      targetLine: {
        top: lineTop,
        bottom: lineBottom
      }
    };
  } finally {
    await pdf.destroy();
  }
}