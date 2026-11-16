// Vérification du jeton Cloudflare Access de l'espace admin (admin.seancy.com,
// protégé par une application Access) : chaque requête qui a passé la porte
// d'Access porte l'en-tête Cf-Access-Jwt-Assertion, un jeton signé (RS256) par
// l'équipe Access. On vérifie sa signature avec les clés publiques de l'équipe,
// son audience (l'application) et sa date d'expiration : un en-tête recopié ou
// fabriqué ne passe pas. Réglages : secrets ACCESS_TEAM_DOMAIN
// (<équipe>.cloudflareaccess.com) et ACCESS_AUD (« Application Audience
// (AUD) Tag » de l'application Access). Sans eux, la vérification est
// signalée « non réglée » sur le tableau de bord (la connexion admin de
// Seancy reste exigée dans tous les cas).
//
// Logique pure (fetch injectable) : vérifiée par scripts/verify-access.ts.

export interface AccessJwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}
export type FetchKeys = (team: string) => Promise<AccessJwk[]>;

const KEYS_TTL_MS = 60 * 60 * 1000;
let cache: { team: string; at: number; keys: AccessJwk[] } | null = null;

const fetchKeys: FetchKeys = async (team) => {
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) {
    throw new Error(`Clés Access illisibles (HTTP ${r.status})`);
  }
  return ((await r.json()) as { keys?: AccessJwk[] }).keys ?? [];
};

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "=")
  );
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    out[i] = b.charCodeAt(i);
  }
  return out;
}
const json = (s: string) =>
  JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>;

async function keysFor(
  team: string,
  kid: string,
  load: FetchKeys,
  now: number
): Promise<AccessJwk | undefined> {
  // Clé inconnue (rotation des clés d'Access) : relues, mais au plus une fois par minute, pour qu'un jeton fabriqué
  // ne fasse pas lire les clés à chaque requête
  const unknown = !cache?.keys.some((k) => k.kid === kid) && now - (cache?.at ?? 0) > 60_000;
  if (!cache || cache.team !== team || now - cache.at > KEYS_TTL_MS || unknown) {
    cache = { team, at: now, keys: await load(team) };
  }
  return cache.keys.find((k) => k.kid === kid);
}

/** Vide le cache des clés (vérifications). */
export const resetAccessKeys = () => {
  cache = null;
};

/**
 * Adresse e-mail portée par un jeton Access valide (signature, audience,
 * émetteur, expiration), sinon null.
 */
export async function verifyAccessJwt(
  token: string,
  team: string,
  aud: string,
  { load = fetchKeys, now = Date.now() }: { load?: FetchKeys; now?: number } = {}
): Promise<string | null> {
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) {
      return null;
    }
    const header = json(h);
    const payload = json(p);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return null;
    }
    const jwk = await keysFor(team, header.kid, load, now);
    if (!jwk?.kty || !jwk.n || !jwk.e) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64url(sig),
      new TextEncoder().encode(`${h}.${p}`)
    );
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      !ok ||
      !auds.includes(aud) ||
      payload.iss !== `https://${team}` ||
      typeof payload.exp !== "number" ||
      payload.exp * 1000 <= now
    ) {
      return null;
    }
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return null;
  }
}
