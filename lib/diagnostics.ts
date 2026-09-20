/**
 * TEMPORARY. Remove once calls are confirmed working on a device.
 *
 * A way for the app to say what went wrong while it is running on a phone.
 *
 * Everything about this app is diagnosed from the server side, and the server sees only the requests
 * that arrive. A crash before a request, a render that throws, a promise that rejects with nothing to
 * catch it - all of those leave the screen blank and leave the server log untouched, which is how a
 * blank screen can be reported three times with nothing to act on.
 *
 * This closes that gap. Reports go to `diagnostics.report`, which writes them to the server log where
 * they can be read with `vercel logs`.
 */

type Report = (kind: string, detail: string) => void;

let reporter: Report | null = null;

/**
 * Everything is truncated hard before it leaves the device. A render stack from a React tree can be
 * tens of kilobytes, and a log line that large is unusable in a terminal and unhelpful in a report.
 */
function shorten(value: string, limit = 400): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/**
 * Tell the module where to send reports. Called once from the root layout with the tRPC mutation,
 * because this file cannot import React or the tRPC hooks.
 */
export function setDiagnosticsReporter(next: Report | null): void {
  reporter = next;
}

export function reportDiagnostic(kind: string, detail: string): void {
  try {
    if (typeof console !== "undefined") console.log(`[diag:${kind}]`, detail);
    reporter?.(kind, shorten(detail));
  } catch {
    // Reporting must never be the thing that breaks the app. If the report cannot be sent, the
    // original fault is still the one worth fixing.
  }
}

/**
 * Catches what an error boundary cannot: faults raised outside React's render, and promises that
 * reject with nobody waiting on them. Both are silent by default, and both end up looking like a
 * screen that simply stopped.
 */
export function installGlobalErrorReporting(): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => undefined;

  const onError = (event: ErrorEvent) => {
    const where = `${event.filename ?? "?"}${event.lineno ? `:${event.lineno}` : ""}`;
    reportDiagnostic("window-error", `${event.message ?? "unknown"} @ ${where}`);
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason instanceof Error ? `${reason.message} | ${reason.stack ?? ""}` : String(reason);
    reportDiagnostic("unhandled-rejection", message);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
