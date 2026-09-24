/**
 * offscreen.js – Bill Cropper Offscreen Document
 *
 * This script runs in a hidden renderer page (offscreen document), NOT in the
 * service worker. Renderers have access to XMLHttpRequest, which can read
 * local file:// URLs when "Allow access to file URLs" is enabled for the
 * extension in chrome://extensions → Bill Cropper → Details.
 *
 * The background service worker creates this document on-demand and forwards
 * GET_LOCAL_PDF_BYTES messages here to do the actual file read.
 */

"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only handle messages targeted at the offscreen document.
  if (message.target !== "offscreen") return false;

  if (message.type === "READ_LOCAL_FILE") {
    const { url } = message;

    if (!url || !url.startsWith("file://")) {
      sendResponse({ ok: false, error: "Invalid file:// URL" });
      return true;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, /* async= */ true);
    xhr.responseType = "arraybuffer";

    xhr.onload = () => {
      // For file:// URLs the XHR status is 0 on success (not 200).
      if (xhr.status === 0 || xhr.status === 200) {
        const bytes = Array.from(new Uint8Array(xhr.response));
        if (bytes.length === 0) {
          sendResponse({ ok: false, error: "File is empty" });
        } else {
          sendResponse({ ok: true, bytes });
        }
      } else {
        sendResponse({ ok: false, error: `XHR status ${xhr.status}` });
      }
    };

    xhr.onerror = () => {
      sendResponse({
        ok: false,
        error:
          "Failed to read local file. Ensure \"Allow access to file URLs\" is " +
          "enabled for Bill Cropper in chrome://extensions → Details."
      });
    };

    xhr.send();

    // Return true so the message channel stays open for the async sendResponse.
    return true;
  }

  return false;
});
