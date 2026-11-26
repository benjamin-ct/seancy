// Règles anti-doublon des notifications du cron (worker/scheduled.ts), sans
// accès à D1 ni à TMDB pour rester testables seules
// (scripts/verify-notification-dedup.ts).

// Clé d'une notification déjà envoyée dans l'historique chargé par le cron
// (getNotifiedKeys, worker/db.ts).
export function notifiedKey(mediaType: string, tmdbId: number, reason: string): string {
  return `${mediaType}:${tmdbId}:${reason}`;
}

// Plateformes de streaming d'un titre (watchlist, rappels « Me prévenir ») :
// la référence enregistrée est l'ensemble des plateformes vues au moins une
// fois, elle ne fait que grossir. Une plateforme absente un jour de la
// réponse TMDB (données JustWatch incomplètes, région manquante, qui
// renvoient une liste vide) puis de retour le lendemain n'est donc plus
// « nouvelle » : avant, le même titre était renotifié à chaque retour.
export function mergeKnownProviders(known: number[] | null, current: number[]): number[] {
  return [...new Set([...(known ?? []), ...current])];
}

// Première observation (known === null) : on enregistre sans notifier, sinon
// tout ce qui était déjà disponible au moment de l'ajout notifierait.
export function hasNewProvider(known: number[] | null, current: number[]): boolean {
  return known !== null && current.some((id) => !known.includes(id));
}

// Motifs qui annoncent la sortie d'un titre : un titre déjà annoncé pour l'un
// ne l'est plus pour un autre (un film récent à la fois dans un genre favori
// et dans les tendances ne donne qu'une notification, ce jour-là comme les
// suivants).
const RELEASE_REASONS = ["genre", "trending", "reminder-release"] as const;

export function releaseAlreadyAnnounced(
  history: ReadonlySet<string>,
  mediaType: string,
  tmdbId: number
): boolean {
  return RELEASE_REASONS.some((reason) => history.has(notifiedKey(mediaType, tmdbId, reason)));
}
