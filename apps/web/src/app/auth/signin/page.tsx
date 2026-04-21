"use client";

import { useEffect } from "react";
import { signIn } from "next-auth/react";

/**
 * Intermediate page opened in the login popup.
 * Immediately calls signIn() — which issues the required POST to Auth.js —
 * then Auth.js redirects the popup to PingOne and back to /auth/close.
 * The main tab never navigates.
 */
export default function AuthSignInPage() {
  useEffect(() => {
    signIn("pingone", { callbackUrl: "/auth/close" });
  }, []);

  return (
    <div className="flex items-center justify-center h-screen bg-sky-950 text-white text-sm">
      Redirecting to PingOne…
    </div>
  );
}
