"use client";

import { useEffect } from "react";

/**
 * Landing page for the PingOne login popup.
 * Auth.js redirects here after a successful callback.
 * This page closes the popup — the main tab stays intact.
 */
export default function AuthClosePage() {
  useEffect(() => {
    // Signal the opener that login succeeded, then close.
    if (window.opener) {
      window.opener.postMessage("auth:complete", window.location.origin);
    }
    window.close();
  }, []);

  return (
    <div className="flex items-center justify-center h-screen bg-sky-950 text-white text-sm">
      Logged in — closing…
    </div>
  );
}
