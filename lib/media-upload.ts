// `/legacy` is the module that still has EncodingType; the v19 default export moved the read/write
// helpers and dropped it, which left this file failing to typecheck.
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

export type AttachmentPayload = {
  base64: string;
  contentType: string;
  fileName: string;
};

/** Base64-encodes a buffer without blowing the call stack on large attachments. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Shrinks an image to fit `maxSize` on its longest edge and re-encodes it as JPEG. Web only
 * (canvas); returns null when it cannot decode, so the caller can fall back to the original.
 */
async function downscaleImage(blob: Blob, maxSize: number, quality: number): Promise<string | null> {
  try {
    if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    return dataUrl.split(",")[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Turns a picked asset into something the media.upload endpoint accepts.
 *
 * On web the picked asset is a blob URL, which expo-file-system cannot read, so the bytes are
 * fetched directly; photos are also downscaled to 1280px JPEG so a camera photo does not land
 * in the database at several megabytes. Native keeps the file-system path.
 */
export async function prepareAttachment(
  asset: ImagePicker.ImagePickerAsset,
  kind: "image" | "video",
): Promise<AttachmentPayload | null> {
  const fallbackName = `${kind}-${Date.now()}`;
  const fileName = asset.fileName ?? fallbackName;
  const declaredType = asset.mimeType ?? (kind === "video" ? "video/mp4" : "image/jpeg");

  if (Platform.OS === "web" && typeof fetch === "function") {
    try {
      const response = await fetch(asset.uri);
      const blob = await response.blob();

      if (kind === "image") {
        const base64 = await downscaleImage(blob, 1280, 0.82);
        if (base64) {
          return { base64, contentType: "image/jpeg", fileName: `${fileName.replace(/\.[^.]+$/, "")}.jpg` };
        }
      }

      const buffer = await blob.arrayBuffer();
      return { base64: arrayBufferToBase64(buffer), contentType: blob.type || declaredType, fileName };
    } catch {
      return null;
    }
  }

  try {
    const base64 = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { base64, contentType: declaredType, fileName };
  } catch {
    return null;
  }
}

/** Media is stored in the database, which caps a single attachment at 4 MB (see mediaRoutes). */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export type PickedDocument = { uri: string; name: string; mimeType: string; size: number };

/**
 * Opens the file chooser and resolves with what was picked, or null if nothing was.
 *
 * Deliberately not expo-document-picker. Adding a dependency means regenerating pnpm-lock.yaml, and
 * the Vercel build installs with `--frozen-lockfile` - so a lockfile mistake takes the live site
 * down. This app ships as a web export inside a WebView, where a plain file input works everywhere
 * and accepts any type, so the native module would buy nothing but that risk.
 *
 * Resolves null on a runtime with no DOM, which the caller reports to the user.
 */
export function pickDocumentFile(): Promise<PickedDocument | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    // Any type on purpose: this is the "send a document" path, not the photo path.
    input.accept = "*/*";
    input.style.display = "none";

    let settled = false;
    const finish = (value: PickedDocument | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      finish({
        uri: URL.createObjectURL(file),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      });
    };
    // Fired by Chrome 113+ and Safari 16.4+. Older browsers fire nothing on cancel, which leaves
    // this promise unsettled - harmless, the dialog simply closes and nothing is sent.
    input.oncancel = () => finish(null);

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Turns a picked document into something media.upload accepts.
 *
 * Deliberately never re-encoded: downscaling a PDF or re-compressing a zip to fit would corrupt it,
 * so an oversize file is reported to the caller instead of being silently mangled. Typed
 * structurally rather than against expo-document-picker's asset type so this module stays free of
 * that dependency's types.
 */
export async function prepareDocument(asset: {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
}): Promise<AttachmentPayload | null> {
  const fileName = asset.name || `document-${Date.now()}`;
  const declaredType = asset.mimeType || "application/octet-stream";

  if (Platform.OS === "web" && typeof fetch === "function") {
    // The web picker hands back a blob URL, which expo-file-system cannot read.
    try {
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      return { base64: arrayBufferToBase64(buffer), contentType: blob.type || declaredType, fileName };
    } catch {
      return null;
    }
  }

  try {
    const base64 = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { base64, contentType: declaredType, fileName };
  } catch {
    return null;
  }
}
