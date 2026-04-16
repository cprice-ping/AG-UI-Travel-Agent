/**
 * Auth.js (next-auth v5) configuration for PingOne OIDC.
 *
 * PingOne acts as a standard OIDC provider. The access_token issued by
 * PingOne is stored in the session and forwarded to the MCP server as a
 * Bearer token so the server can validate the caller's identity.
 */

import NextAuth from "next-auth";

declare module "next-auth" {
  interface Session {
    /** Raw access token from PingOne — used as the MCP server Bearer token. */
    accessToken?: string;
    /** PingOne preferred_username claim from the ID token. */
    preferredUsername?: string;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    {
      id: "pingone",
      name: "PingOne",
      type: "oidc",
      // PingOne OIDC discovery endpoint: https://auth.pingone.com/<ENV_ID>/as
      issuer: process.env.AUTH_PINGONE_ISSUER,
      clientId: process.env.AUTH_PINGONE_CLIENT_ID,
      clientSecret: process.env.AUTH_PINGONE_CLIENT_SECRET,
      authorization: {
        params: {
          // Request openid + profile + email scopes.
          // Add any PingOne custom scopes your app needs here.
          scope: "openid profile email",
          response_type: "code",
        },
      },
    },
  ],

  callbacks: {
    /**
     * Persist the PingOne access_token inside the Auth.js JWT cookie so it
     * survives across page reloads without a database.
     */
    async jwt({ token, account, profile }) {
      if (account?.access_token) {
        token.accessToken = account.access_token;
        token.accessTokenExpires = account.expires_at
          ? account.expires_at * 1000
          : undefined;
      }
      // Capture the display name from the OIDC profile on first sign-in.
      // PingOne may use preferred_username, username, name, or given_name
      // depending on the environment attribute mappings.
      if (profile) {
        const p = profile as Record<string, unknown>;
        token.preferredUsername =
          (p.preferred_username as string) ??
          (p.username as string) ??
          (p.name as string) ??
          (p.given_name as string) ??
          undefined;
      }
      return token;
    },

    /**
     * Expose the access_token on the client-side session object so
     * useSession() can forward it to the agent state.
     */
    async session({ session, token }) {
      session.accessToken = token.accessToken as string | undefined;
      session.preferredUsername = token.preferredUsername as string | undefined;
      return session;
    },
  },

  pages: {
    signIn: "/auth/signin",
  },
});
