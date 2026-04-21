/**
 * Auth.js (next-auth v5) configuration for PingOne OIDC.
 *
 * TOKEN ARCHITECTURE — Person Token (Subject Token)
 * ──────────────────────────────────────────────────
 * The browser performs a plain OIDC authorization code flow. The resulting
 * access token is the RFC 8693 subject_token — it proves WHO the user is.
 *
 * RFC 8707 resource indicator (AUTH_AGENT_RESOURCE) scopes the token to the
 * Agent's audience. This means:
 *   - aud = Agent URL  → token can only be used as a subject_token by the Agent
 *   - Possession of this token alone cannot call any MCP server
 *   - An attacker who steals it from the browser still can't access MCP tools
 *     (they'd also need the Agent's client credentials to perform the exchange)
 *
 * The Agent independently obtains its own token via client_credentials, then
 * performs RFC 8693 Token Exchange combining both:
 *   subject_token = person token  (WHO — from browser via agent state)
 *   actor_token   = agent CC token (WHICH component — held server-side only)
 *   audience      = MCP server URL (per server from MCP_SERVERS config)
 * → MCP token: aud=<mcp-server>, act=<agent>, sub=<user>
 *
 * SCOPES: Plain identity only (openid profile email). MCP tool scopes
 * are NOT requested here — the Agent specifies them at exchange time.
 * This keeps the login flow decoupled from the MCP server topology.
 */

import NextAuth from "next-auth";

declare module "next-auth" {
  interface Session {
    /**
     * Person token — aud = Agent (AUTH_AGENT_RESOURCE).
     * RFC 8693 subject_token. Passed to Agent via useCoAgent state
     * as userTokens._subject for use in Token Exchange.
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
          // Plain identity scopes — no MCP-specific scopes.
          // MCP tool scopes are requested by the Agent at Token Exchange time,
          // scoped to the specific MCP server being accessed.
          scope: "openid profile email",
          response_type: "code",
          // RFC 8707: bind person token aud to the Agent.
          // Set AUTH_AGENT_RESOURCE in .env to the Agent's registered resource URL.
          resource: process.env.AUTH_AGENT_RESOURCE ?? "http://localhost:8123",
        },
      },
      token: {
        params: {
          // Also set on the token endpoint so the code-exchange sets aud correctly.
          resource: process.env.AUTH_AGENT_RESOURCE ?? "http://localhost:8123",
        },
      },
    },
  ],

  callbacks: {
    /**
     * Persist the person token in the Auth.js JWT cookie.
     * aud = AUTH_AGENT_RESOURCE (the Agent), set by RFC 8707 above.
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
