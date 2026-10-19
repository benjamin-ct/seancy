// Gate CI preprod (ticket Trello "Épique git-flow : CI preprod avancée sur
// develop", gate proposée par Benjy_CT le 2026-10-10 : "tests anti PII").
// Les jeux de données fictives rejoués sur l'environnement develop
// persistant (scripts/fixtures/) ne doivent contenir que des identités de
// démo, jamais une vraie donnée personnelle collée par erreur (copier-coller
// d'un export, d'un ticket support...). Portée volontairement restreinte à
// ces fichiers : ce sont les seuls à contenir des données plutôt que du
// code, et donc les seuls où un faux positif sur du code légitime (un
// numéro dans un commentaire, un id TMDB...) n'est pas un risque.
//
// Convention existante (voir scripts/fixtures/develop-seed.sql) : les
// emails de démo utilisent le TLD .test, réservé aux tests par la RFC 2606
// (jamais un vrai domaine enregistrable) — example.com/.org/.net, réservés
// par la même RFC, sont acceptés en plus pour les fragments ajoutés
// ailleurs (migrations/).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCANNED_DIRS = ["scripts/fixtures", "migrations"];

const ALLOWED_EMAIL_SUFFIXES = [".test", "@example.com", "@example.org", "@example.net"];

// Email : repli volontairement simple (pas la RFC complète) — suffisant
// pour repérer une adresse plausible dans un fichier de données.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Téléphone français (mobile/fixe, avec ou sans indicatif, séparateurs
// optionnels) : 0X XX XX XX XX ou +33 X XX XX XX XX.
const FR_PHONE_RE = /(?:\+33|0)\s?[1-9](?:[\s.-]?\d{2}){4}\b/g;

// IBAN français (FR + 2 chiffres de clé + 23 caractères), espacé ou non.
const FR_IBAN_RE = /\bFR\d{2}(?:\s?[0-9A-Z]{4}){5}\s?[0-9A-Z]{3}\b/gi;

interface Finding {
  file: string;
  line: number;
  kind: string;
  value: string;
}

function listFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function scanFile(path: string): Finding[] {
  const findings: Finding[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(EMAIL_RE)) {
      const email = match[0];
      if (!ALLOWED_EMAIL_SUFFIXES.some((suffix) => email.toLowerCase().endsWith(suffix))) {
        findings.push({ file: path, line: i + 1, kind: "email", value: email });
      }
    }
    for (const match of line.matchAll(FR_PHONE_RE)) {
      findings.push({ file: path, line: i + 1, kind: "téléphone FR", value: match[0] });
    }
    for (const match of line.matchAll(FR_IBAN_RE)) {
      findings.push({ file: path, line: i + 1, kind: "IBAN FR", value: match[0] });
    }
  });
  return findings;
}

const findings = SCANNED_DIRS.flatMap(listFiles).flatMap(scanFile);

if (findings.length > 0) {
  console.error(
    "Données personnelles plausibles trouvées dans des fichiers de fixtures/migrations :"
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} — ${f.kind} : ${f.value}`);
  }
  console.error(
    `\nSi c'est une vraie donnée de démo, utilisez un email en .test/.example (voir scripts/fixtures/develop-seed.sql) ` +
      "plutôt qu'un domaine réel, et évitez tout numéro de téléphone/IBAN réaliste même fictif."
  );
  process.exit(1);
}

console.log(`OK : aucune donnée personnelle plausible dans ${SCANNED_DIRS.join(", ")}.`);
