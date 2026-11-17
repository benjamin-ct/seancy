// Vérification du nettoyage des clés VAPID (worker/vapid.ts) : une vraie paire
// générée par web-push, abîmée comme un secret mal collé, doit être acceptée
// par web-push une fois nettoyée ; une clé fausse est signalée sans être montrée.

import webpush from "web-push";
import { cleanVapidKey, vapidProblem } from "../worker/vapid.ts";

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

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const accepted = (priv: string) => {
  try {
    webpush.setVapidDetails(
      "mailto:test@exemple.test",
      cleanVapidKey(publicKey),
      cleanVapidKey(priv)
    );
    return true;
  } catch {
    return false;
  }
};
const classic = Buffer.from(privateKey, "base64url").toString("base64"); // base64 classique, avec « = » éventuels
const damaged: [string, string][] = [
  ["telle quelle", privateKey],
  ["retour à la ligne final", `${privateKey}\n`],
  ["espaces autour", `  ${privateKey} `],
  ["entre guillemets", `"${privateKey}"`],
  ["base64 classique (+ / =)", classic],
  ["« = » final", `${privateKey}=`],
];
for (const [name, key] of damaged) {
  check(`Clé privée ${name} : acceptée par web-push une fois nettoyée`, accepted(key), true);
  check(
    `Clé privée ${name} : pas de problème signalé`,
    vapidProblem({
      VAPID_PUBLIC_KEY: publicKey,
      VAPID_PRIVATE_KEY: key,
      VAPID_SUBJECT: "mailto:a@b.c",
    }),
    null
  );
}
const wrong = vapidProblem({
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: publicKey, // clé publique collée à la place de la privée
  VAPID_SUBJECT: "mailto:a@b.c",
});
check(
  "Clé publique à la place de la privée : signalée",
  /87 caractères, une clé privée VAPID en fait 43/.test(wrong ?? ""),
  true
);
check(
  "La clé n'apparaît jamais dans le message",
  (wrong ?? "").includes(publicKey.slice(0, 10)),
  false
);
check(
  "Clés manquantes : signalées",
  vapidProblem({ VAPID_PUBLIC_KEY: publicKey, VAPID_SUBJECT: "mailto:a@b.c" }),
  "clés VAPID manquantes (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)"
);
check(
  "Sujet sans mailto ni https : signalé",
  vapidProblem({
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: "moi@exemple.test",
  }),
  "VAPID_SUBJECT doit commencer par « mailto: » ou « https:// »"
);

console.log(`\n${passed} OK, ${failed} en échec`);
process.exit(failed ? 1 : 0);
