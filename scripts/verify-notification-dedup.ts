// Tests unitaires des règles anti-doublon du cron des notifications
// (worker/notify-dedup.ts) : une plateforme qui disparaît un jour de la
// réponse TMDB puis revient ne renotifie pas le titre, et une sortie annoncée
// pour un motif (genre favori, tendance, rappel) ne l'est plus pour un autre.
//
// Script autonome, sur le modèle des autres scripts verify:* :
// `node scripts/verify-notification-dedup.ts`.

import {
  hasNewProvider,
  mergeKnownProviders,
  notifiedKey,
  releaseAlreadyAnnounced,
} from "../worker/notify-dedup.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu: ${JSON.stringify(expected)}`);
    console.log(`     obtenu : ${JSON.stringify(actual)}`);
  }
  if (ok) {
    passed++;
  } else {
    failed++;
  }
}

check("première observation : pas de notification", hasNewProvider(null, [8, 119]), false);
check("nouvelle plateforme : notification", hasNewProvider([8], [8, 119]), true);
check("mêmes plateformes : pas de notification", hasNewProvider([8, 119], [119, 8]), false);
check("plateforme retirée : pas de notification", hasNewProvider([8, 119], [8]), false);

// Scénario du bug : jour 1 la plateforme 8 arrive (notifiée), jour 2 la
// réponse TMDB est vide, jour 3 elle revient.
{
  let known: number[] | null = [];
  const notifications: boolean[] = [];
  for (const current of [[8], [], [8], [], [8]]) {
    notifications.push(hasNewProvider(known, current));
    known = mergeKnownProviders(known, current);
  }
  check("plateforme absente un jour puis de retour : une seule notification", notifications, [
    true,
    false,
    false,
    false,
    false,
  ]);
  check("référence conservée malgré les réponses vides", known, [8]);
}

check("fusion sans doublon", mergeKnownProviders([8, 119], [119, 337]), [8, 119, 337]);
check("fusion depuis aucune référence", mergeKnownProviders(null, [8]), [8]);

{
  const history = new Set([notifiedKey("movie", 1, "genre"), notifiedKey("tv", 2, "trending")]);
  check(
    "annoncé pour un genre : plus annoncé en tendance",
    releaseAlreadyAnnounced(history, "movie", 1),
    true
  );
  check(
    "annoncé en tendance : plus annoncé pour un genre",
    releaseAlreadyAnnounced(history, "tv", 2),
    true
  );
  check(
    "même id, autre type de média : pas encore annoncé",
    releaseAlreadyAnnounced(history, "tv", 1),
    false
  );
  check("jamais annoncé", releaseAlreadyAnnounced(history, "movie", 3), false);
  check(
    "rappel de sortie : compte comme annoncé",
    releaseAlreadyAnnounced(new Set([notifiedKey("movie", 4, "reminder-release")]), "movie", 4),
    true
  );
}

console.log(`\n${passed} OK, ${failed} échec(s)`);
if (failed > 0) {
  process.exit(1);
}
