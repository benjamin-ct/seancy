// Assets du site de développement (Worker `seancy-develop`) : copie de dist/
// où le favicon, les icônes d'écran d'accueil et de l'appli installée sont
// remplacés par la version au ticket bleu (develop-icons/, générées par
// scripts/generate-icons.ts), le nom de l'appli devient « Seancy Dev » et le
// titre de l'onglet commence par « [Dev] » : impossible de confondre develop
// avec la prod, dans un onglet comme sur l'écran d'accueil. La prod garde
// dist/ tel quel. Appelé par `node scripts/preview-d1.ts provision-develop`,
// après le build (job deploy-develop de la CI), qui fait pointer la config
// générée de develop sur ce dossier.
//
// Le service worker (dist/sw.js) précache ces fichiers avec, pour chacun, le
// md5 de son contenu (`revision`) : il est recalculé pour chaque fichier
// remplacé, sinon un service worker déjà installé garderait l'ancienne
// version (même révision = rien à retélécharger).
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.join(import.meta.dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const ICONS_DIR = path.join(ROOT_DIR, "develop-icons");
export const DEVELOP_DIST_DIR = "dist-develop";

const APP_NAME = "Seancy";
const DEV_APP_NAME = "Seancy Dev";
// Même préfixe que DEV_TITLE_PREFIX (src/core/lib/devSite.ts), repris par
// useDocumentTitle une fois React chargé.
const DEV_TITLE_PREFIX = "[Dev] ";

const md5 = (content: Buffer | string) => createHash("md5").update(content).digest("hex");

export function buildDevelopAssets(): void {
  if (!existsSync(path.join(DIST_DIR, "index.html"))) {
    throw new Error("dist/ introuvable : lancer `npm run build` avant les assets de develop.");
  }
  if (!existsSync(ICONS_DIR)) {
    throw new Error("develop-icons/ introuvable : lancer `node scripts/generate-icons.ts`.");
  }
  const outDir = path.join(ROOT_DIR, DEVELOP_DIST_DIR);
  rmSync(outDir, { recursive: true, force: true });
  cpSync(DIST_DIR, outDir, { recursive: true });

  const replaced = new Map<string, string>();
  const replace = (file: string, content: Buffer | string) => {
    const target = path.join(outDir, file);
    if (!existsSync(target)) {
      throw new Error(`${DEVELOP_DIST_DIR}/${file} introuvable dans le build.`);
    }
    replaced.set(file, md5(readFileSync(target)));
    writeFileSync(target, content);
  };

  for (const file of readdirSync(ICONS_DIR)) {
    replace(file, readFileSync(path.join(ICONS_DIR, file)));
  }

  const manifestPath = path.join(outDir, "manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.short_name = DEV_APP_NAME;
  if (typeof manifest.name === "string") {
    manifest.name = manifest.name.replace(APP_NAME, DEV_APP_NAME);
  }
  replace("manifest.webmanifest", JSON.stringify(manifest));

  const html = readFileSync(path.join(outDir, "index.html"), "utf8");
  if (!html.includes("<title>")) {
    throw new Error(`${DEVELOP_DIST_DIR}/index.html : balise <title> introuvable.`);
  }
  replace(
    "index.html",
    html
      .replace("<title>", `<title>${DEV_TITLE_PREFIX}`)
      // Nom sous l'icône quand iOS ne lit pas le manifeste.
      .replace(
        "</title>",
        `</title>\n    <meta name="apple-mobile-web-app-title" content="${DEV_APP_NAME}" />`
      )
  );

  const swPath = path.join(outDir, "sw.js");
  let sw = readFileSync(swPath, "utf8");
  for (const [file, oldRevision] of replaced) {
    const before = `"revision":"${oldRevision}","url":"${file}"`;
    if (!sw.includes(before)) {
      // Fichier non précaché (ou format du précache changé) : rien à mettre à jour.
      console.warn(`sw.js : pas de révision précachée pour ${file}.`);
      continue;
    }
    const content = readFileSync(path.join(outDir, file));
    sw = sw.replace(before, `"revision":"${md5(content)}","url":"${file}"`);
  }
  writeFileSync(swPath, sw);
  console.log(
    `Assets de develop écrits dans ${DEVELOP_DIST_DIR}/ (${replaced.size} fichiers remplacés).`
  );
}

if (import.meta.main) {
  buildDevelopAssets();
}
