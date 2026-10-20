// Limitation de débit à fenêtre fixe, sur D1 (pas de dépendance à une
// fonctionnalité Workers séparée type "Rate Limiting binding" — un simple
// compteur en base suffit très largement pour le volume d'une app perso).
//
// `checkRateLimit` incrémente atomiquement le compteur de la fenêtre en
// cours pour `key` et renvoie `true` tant que le total reste sous `limit`.
// Un même appelant peut être soumis à plusieurs fenêtres/clés en parallèle
// (ex. par email ET par IP) — voir les usages dans index.ts.
export async function checkRateLimit(
  db: D1Database,
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number }
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

// Variante sans écriture D1 (routes à très fort volume, ex. le proxy TMDB) :
// voir worker/rate-limit-memory.ts, importé directement là où nécessaire
// (fichier séparé pour rester importable depuis les scripts verify:*, qui
// n'ont pas accès aux types Workers utilisés ci-dessus).

// Binding natif « Rate Limiting » de Workers (voir worker/types.ts,
// AVATAR_RATE_LIMITER/PUBLIC_SLUG_RATE_LIMITER/LIBRARY_WRITE_RATE_LIMITER) :
// absent sur les previews de PR (`wrangler preview`), limitation Cloudflare
// constatée en prod — cf. Sentry "Cannot read properties of undefined
// (reading 'limit')" sur handleLibrarySync et consorts, reproduit sur
// plusieurs previews depuis le 2026-10-08, bien avant cette branche. On
// n'applique alors aucun plafond plutôt que de planter la requête : le vrai
// plafond (D1, prod/develop) reste en place partout où le binding existe.
export async function checkBindingRateLimit(
  limiter: RateLimit | undefined,
  key: string
): Promise<boolean> {
  if (!limiter) {
    return true;
  }
  return (await limiter.limit({ key })).success;
}

export function getClientIp(request: Request): string {
  // En-tête posé par Cloudflare lui-même sur toute requête passant par son
  // réseau — pas falsifiable par le client (contrairement à X-Forwarded-For).
  return request.headers.get("cf-connecting-ip") || "unknown";
}

// Secondes restantes avant la fin de la fenêtre fixe courante de `windowMs`
// (voir checkRateLimit), pour dire au client combien de temps attendre.
export function secondsUntilWindowEnd(windowMs: number): number {
  return Math.ceil((windowMs - (Date.now() % windowMs)) / 1000);
}
