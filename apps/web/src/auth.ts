/**
 * Auth.js (next-auth v5) configuration for PingOne OIDC.
 *
 * TOKEN ARCHITECTURE — Person Token (Subject Token)
 * ──────────────────────────────────────────────────
 * The browser performs a plain OIDC authorization code flow. The resulting
 * access token is a standard OIDC token — it proves WHO the user is.
 *   aud   = api.pingone.com  (PingOne's own API audience, no resource binding)
 *   scope = openid profile email  (identity only — no MCP scopes)
 *   sub   = the authenticated user
 *
 * This is a 1st-party flow with implied consent. MCP tool scopes are NOT
 * requested at login — the Agent specifies them at Token Exchange time.
 * This keeps the login flow completely decoupled from MCP server topology.
 *
 * The Agent independently obtains its own token via client_credentials, then
 * performs RFC 8693 Token Exchange combining both tokens with the MCP scope:
 *   subject_token = person token     (WHO — from browser via agent state)
 *   actor_token   = agent CC token   (WHICH component — held server-side only)
 *   scope         = mcp:<server>_tools  (requested at exchange time)
 * → TX token: aud=<mcp-server>, act={sub: agent-client-id}, sub=<user>
 *
 * Security: the person token alone cannot call any MCP server — the Agent's
 * client secret (held only server-side) is required to complete the exchange.
 */

import NextAuth from "next-auth";

declare module "next-auth" {
  interface Session {
    /**
     * Person token — plain OIDC access token (aud = api.pingone.com).
     * Passed to Agent via useCoAgent state as userTokens._subject.
     * Agent uses it as the RFC 8693 subject_token in Token Exchange.
     */
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
          // Plain identity scopes only — no MCP-specific scopes.
          // MCP tool scopes are requested by the Agent at Token Exchange time.
          scope: "openid profile email",
          response_type: "code",
        },
      },

    },
  ],

  callbacks: {
    /**
     * Persist the person token in the Auth.js JWT cookie.
     * aud = api.pingone.com (standard PingOne OIDC token).
     */
    async jwt({ token, account, profile }) {
      if (account?.access_token) {
        token.accessToken = account.access_token;
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
     * Expose the person token on the client-side session so useSession()
     * can forward it to the Agent via useCoAgent state (userTokens._subject).
     * The Agent treats this as an opaque subject token for later exchange.
     */
    async session({ session, token }) {
      session.accessToken = (token.accessToken as string | undefined) ?? "";
      session.preferredUsername = token.preferredUsername as string | undefined;
      return session;
    },
  },

  pages: {
    signIn: "/auth/signin",
  },
});
