import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe portion of the Auth.js config.
 *
 * The middleware runs in Edge runtime and can't import Node-only modules
 * (better-sqlite3, node:crypto, bcryptjs). This file holds only what the
 * middleware needs: page routing, session strategy, and auth callbacks.
 *
 * The full config (with the Credentials provider that hits the DB) lives
 * in `auth.ts` and is used by route handlers and server components.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.uid = (user as { id?: string }).id;
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) {
        (session.user as { id?: string }).id = token.uid as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
