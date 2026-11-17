// Génère une nouvelle paire de clés VAPID pour les notifications push, à lancer
// à la main sur ta machine : `npm run vapid:generate`. La clé privée n'est
// affichée que dans ton terminal (jamais écrite dans un fichier ni dans le dépôt).
// Procédure complète : README, section « Régénérer la paire VAPID ».

import webpush from "web-push";
import { vapidProblem } from "../worker/vapid.ts";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

// Garde-fou : la paire produite doit passer le même contrôle que le Worker.
const problem = vapidProblem({
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: privateKey,
  VAPID_SUBJECT: "mailto:test@exemple.test",
});
if (problem) {
  console.error(`Paire générée inutilisable : ${problem}`);
  process.exit(1);
}

console.log("Nouvelle paire VAPID générée.\n");
console.log("1. wrangler.jsonc → vars.VAPID_PUBLIC_KEY (publique, à commiter) :");
console.log(`   ${publicKey}\n`);
console.log(
  "2. Cloudflare → Worker seancy → Settings → Variables and Secrets → VAPID_PRIVATE_KEY (SECRET, ne jamais commiter) :"
);
console.log(`   ${privateKey}\n`);
console.log("Les deux clés vont ensemble : change-les dans le même déploiement.");
