"use client";

import { useEffect } from "react";

/**
 * Landing page for the PingOne login popup.
 * Auth.js redirects here after a successful callback.
 * This page only closes the popup — the opener watches the popup handle and
 * refreshes its session when the window is closed.
 */
export default function AuthClosePage() {
  useEffect(() => {
    window.close();
  }, []);

  return (
    <div className="flex items-center justify-center h-screen bg-sky-950 text-white text-sm">
      Logged in — closing…
    </div>
  );
}
