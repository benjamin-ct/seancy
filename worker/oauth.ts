// Connexion avec Google et Apple (OpenID Connect, flux « authorization
// code »), en plus du lien magique — voir migrations/0017_oauth_identities.sql.
//
// Flux :
//  1. GET /api/auth/oauth/start?provider=…&mode=login|link : crée un parcours
//     (state, PKCE, nonce) en base et redirige vers le fournisseur.
//  2. Le fournisseur revient sur /api/auth/oauth/callback/<provider> (GET
//     pour Google, POST « form_post » pour Apple) avec un code, échangé ici
//     contre un id_token.
//  3. Connexion : l'identité mène au compte qui l'a déjà associée, sinon au
//     compte de même email vérifié (créé au besoin). La session n'est pas
//     ouverte directement ici : on émet un lien magique interne et on
//     redirige vers /auth/verify, qui l'ouvre comme pour un lien reçu par
//     email (même code côté client, reCAPTCHA compris). Un cookie posé en
//     réponse au POST inter-sites d'Apple risquerait en plus d'être refusé
//     (SameSite).
//     Association : l'identité est rattachée au compte qui a lancé le
//     parcours (user_id du state), jamais à celui de même email.
import { hashToken } from "./auth.ts";
import type { Env } from "./types.ts";

export const OAUTH_PROVIDERS = ["google", "apple"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

const STATE_TTL_MS = 10 * 60 * 1000;

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return OAUTH_PROVIDERS.includes(value as OAuthProvider);
}

// Un fournisseur n'est proposé que si tous ses identifiants sont configurés
// (secrets absents en dev local et sur les previews : boutons masqués).
export function configuredProviders(env: Env): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((provider) =>
    provider === "google"
      ? !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
      : !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY)
  );
}

export function redirectUri(origin: string, provider: OAuthProvider): string {
  return `${origin}/api/auth/oauth/callback/${provider}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlString(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function randomString(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// Chemin interne uniquement (« /… » mais pas « //hôte » ni « /\hôte ») :
// sinon le retour après connexion deviendrait une redirection ouverte.
export function sanitizeReturnTo(value: string | null | undefined): string | null {
  return value && /^\/(?![/\\])/.test(value) ? value : null;
}

// Crée le parcours et renvoie l'URL d'autorisation du fournisseur.
export async function startOAuth(
  db: D1Database,
  env: Env,
  origin: string,
  provider: OAuthProvider,
  userId: number | null,
  returnTo: string | null
): Promise<string> {
  const state = randomString();
  const verifier = randomString();
  const nonce = randomString();
  await db
    .prepare(
      `INSERT INTO oauth_states (state, provider, user_id, code_verifier, nonce, return_to, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      await hashToken(state),
      provider,
      userId,
      verifier,
      nonce,
      returnTo,
      Date.now() + STATE_TTL_MS
    )
    .run();

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri(origin, provider),
    state,
    nonce,
  });
  if (provider === "google") {
    params.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
    params.set("code_challenge", await codeChallenge(verifier));
    params.set("code_challenge_method", "S256");
    params.set("scope", "openid email");
    params.set("prompt", "select_account");
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  // Apple ne documente pas PKCE (le code y est de toute façon lié au secret
  // client) et impose le retour en POST (form_post) dès qu'un scope est
  // demandé.
  params.set("client_id", env.APPLE_CLIENT_ID ?? "");
  params.set("scope", "email");
  params.set("response_mode", "form_post");
  return `https://appleid.apple.com/auth/authorize?${params}`;
}

export interface OAuthState {
  provider: OAuthProvider;
  userId: number | null;
  codeVerifier: string;
  nonce: string;
  returnTo: string | null;
}

// Consomme le parcours (usage unique, DELETE … RETURNING atomique) : null
// s'il est inconnu, expiré, déjà utilisé ou lancé pour un autre fournisseur.
export async function consumeOAuthState(
  db: D1Database,
  provider: OAuthProvider,
  state: string | null
): Promise<OAuthState | null> {
  if (!state) {
    return null;
  }
  const row = await db
    .prepare(
      `DELETE FROM oauth_states WHERE state = ?
       RETURNING provider, user_id, code_verifier, nonce, return_to, expires_at`
    )
    .bind(await hashToken(state))
    .first<{
      provider: string;
      user_id: number | null;
      code_verifier: string;
      nonce: string;
      return_to: string | null;
      expires_at: number;
    }>();
  if (!row || row.provider !== provider || row.expires_at < Date.now()) {
    return null;
  }
  return {
    provider,
    userId: row.user_id,
    codeVerifier: row.code_verifier,
    nonce: row.nonce,
    returnTo: row.return_to,
  };
}

// Secret client Apple : un JWT ES256 signé avec la clé privée « Sign in with
// Apple » (.p8, PKCS#8 en PEM), valable 5 minutes. WebCrypto produit
// directement la signature au format r||s attendu par JWS.
async function appleClientSecret(env: Env): Promise<string> {
  const pem = (env.APPLE_PRIVATE_KEY ?? "")
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64UrlString(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID })),
    base64UrlString(
      JSON.stringify({
        iss: env.APPLE_TEAM_ID,
        iat: now,
        exp: now + 300,
        aud: "https://appleid.apple.com",
        sub: env.APPLE_CLIENT_ID,
      })
    ),
  ].join(".");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export interface OAuthIdentity {
  subject: string;
  /** Email vérifié par le fournisseur, en minuscules ; null sinon. */
  email: string | null;
}

const ISSUERS: Record<OAuthProvider, string[]> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};

// Échange le code contre un id_token et en extrait l'identité. La signature
// de l'id_token n'est pas vérifiée : il vient directement du point d'accès
// « token » du fournisseur, en TLS, authentifié par notre secret client
// (OpenID Connect Core § 3.1.3.7, point 6). Émetteur, audience, expiration
// et nonce le sont.
export async function exchangeCode(
  env: Env,
  origin: string,
  provider: OAuthProvider,
  code: string,
  state: OAuthState
): Promise<OAuthIdentity> {
  const clientId = (provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_CLIENT_ID) ?? "";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin, provider),
    client_id: clientId,
    client_secret:
      provider === "google" ? (env.GOOGLE_CLIENT_SECRET ?? "") : await appleClientSecret(env),
  });
  if (provider === "google") {
    body.set("code_verifier", state.codeVerifier);
  }
  const res = await fetch(
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://appleid.apple.com/auth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    }
  );
  if (!res.ok) {
    throw new Error(`Échange du code ${provider} refusé (${res.status}) : ${await res.text()}`);
  }
  const { id_token: idToken } = (await res.json()) as { id_token?: unknown };
  const payload = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
  if (!payload) {
    throw new Error(`Réponse ${provider} sans id_token.`);
  }
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    nonce?: unknown;
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
  };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !ISSUERS[provider].includes(String(claims.iss)) ||
    !audiences.includes(clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 < Date.now() ||
    claims.nonce !== state.nonce ||
    typeof claims.sub !== "string" ||
    !claims.sub
  ) {
    throw new Error(`id_token ${provider} invalide.`);
  }
  // Apple renvoie email_verified sous forme de chaîne ("true").
  const verified = claims.email_verified === true || claims.email_verified === "true";
  return {
    subject: claims.sub,
    email: verified && typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null,
  };
}

export async function findIdentityUser(
  db: D1Database,
  provider: OAuthProvider,
  subject: string
): Promise<{ id: number; email: string } | null> {
  return db
    .prepare(
      `SELECT users.id, users.email FROM auth_identities
       JOIN users ON users.id = auth_identities.user_id
       WHERE auth_identities.provider = ? AND auth_identities.subject = ?`
    )
    .bind(provider, subject)
    .first<{ id: number; email: string }>();
}

export type LinkResult = "linked" | "already-linked" | "used-elsewhere" | "provider-taken";

export async function linkIdentity(
  db: D1Database,
  userId: number,
  provider: OAuthProvider,
  identity: OAuthIdentity
): Promise<LinkResult> {
  const owner = await findIdentityUser(db, provider, identity.subject);
  if (owner) {
    return owner.id === userId ? "already-linked" : "used-elsewhere";
  }
  const { meta } = await db
    .prepare(
      `INSERT OR IGNORE INTO auth_identities (provider, subject, user_id, email, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(provider, identity.subject, userId, identity.email, Date.now())
    .run();
  // Ignoré : le compte a déjà un autre compte de ce fournisseur (index
  // unique user_id + provider).
  return meta.changes > 0 ? "linked" : "provider-taken";
}

export async function listIdentities(
  db: D1Database,
  userId: number
): Promise<Array<{ provider: OAuthProvider; email: string | null; createdAt: number }>> {
  const { results } = await db
    .prepare(
      "SELECT provider, email, created_at FROM auth_identities WHERE user_id = ? ORDER BY created_at"
    )
    .bind(userId)
    .all<{ provider: string; email: string | null; created_at: number }>();
  return results
    .filter((row) => isOAuthProvider(row.provider))
    .map((row) => ({
      provider: row.provider as OAuthProvider,
      email: row.email,
      createdAt: row.created_at,
    }));
}

// Toujours possible : le lien magique vers l'email du compte reste un moyen
// de connexion, on ne peut donc jamais se retrouver sans aucun.
export async function unlinkIdentity(
  db: D1Database,
  userId: number,
  provider: OAuthProvider
): Promise<void> {
  await db
    .prepare("DELETE FROM auth_identities WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .run();
}
