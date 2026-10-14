#!/usr/bin/env node
// Capture d'écran d'une page de l'app pour Claude (pas de navigateur dans le
// conteneur autrement) : Chromium headless via Playwright, installé dans
// l'image seancy-repo. Claude lit ensuite le PNG produit avec son outil Read.
//
//   seancy-screenshot <url> <sortie.png> [--mobile | --desktop | --both]
//                     [--full] [--wait <ms>] [--cookie nom=valeur]...
//                     [--click <sélecteur CSS>]... [--dark | --light]
//
// --both produit <sortie>-desktop.png et <sortie>-mobile.png. Les erreurs
// console et les requêtes en échec sont affichées sur la sortie standard.
//
// Previews Cloudflare (*.dev.seancy.com, et les anciennes *.workers.dev,
// derrière Cloudflare Access) : si
// CF_ACCESS_CLIENT_ID et CF_ACCESS_CLIENT_SECRET sont définis (jeton de
// service Access, voir infra/trello-claude/README.md), ils sont envoyés en
// en-têtes à chaque requête vers ces hôtes.
const { chromium, devices } = require("playwright");
const path = require("node:path");

function parseArgs(argv) {
  const opts = { mode: "desktop", full: false, wait: 1500, cookies: [], clicks: [], scheme: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mobile" || arg === "--desktop" || arg === "--both") {
      opts.mode = arg.slice(2);
    } else if (arg === "--full") {
      opts.full = true;
    } else if (arg === "--dark" || arg === "--light") {
      opts.scheme = arg.slice(2);
    } else if (arg === "--wait") {
      opts.wait = Number(argv[++i]);
    } else if (arg === "--cookie") {
      opts.cookies.push(argv[++i]);
    } else if (arg === "--click") {
      opts.clicks.push(argv[++i]);
    } else {
      rest.push(arg);
    }
  }
  [opts.url, opts.out] = rest;
  return opts;
}

async function capture(browser, opts, mode, out) {
  const url = new URL(opts.url);
  const accessHeaders =
    process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
      ? {
          "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
        }
      : null;
  const context = await browser.newContext({
    ...(mode === "mobile"
      ? devices["iPhone 13"]
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }),
    locale: "fr-FR",
    ...(opts.scheme ? { colorScheme: opts.scheme } : {}),
  });
  if (accessHeaders) {
    // Seulement vers les previews : pas de fuite du jeton vers TMDB & co.
    await context.route(
      (u) => u.hostname.endsWith(".dev.seancy.com") || u.hostname.endsWith(".workers.dev"),
      (route) => route.continue({ headers: { ...route.request().headers(), ...accessHeaders } })
    );
  }
  if (opts.cookies.length) {
    await context.addCookies(
      opts.cookies.map((c) => {
        const [name, ...value] = c.split("=");
        return { name, value: value.join("="), domain: url.hostname, path: "/" };
      })
    );
  }
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[${mode}] console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.log(`[${mode}] pageerror: ${err.message}`));
  page.on("requestfailed", (req) =>
    console.log(`[${mode}] requête en échec: ${req.url()} (${req.failure()?.errorText})`)
  );
  const response = await page.goto(opts.url, { waitUntil: "networkidle", timeout: 45_000 });
  console.log(`[${mode}] HTTP ${response?.status()} ${page.url()}`);
  for (const selector of opts.clicks) {
    await page.click(selector, { timeout: 10_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await page.waitForTimeout(opts.wait);
  await page.screenshot({ path: out, fullPage: opts.full });
  console.log(`[${mode}] capture : ${out}`);
  await context.close();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url || !opts.out) {
    console.error(
      "Usage : seancy-screenshot <url> <sortie.png> [--mobile|--desktop|--both] [--full] [--wait ms] [--cookie nom=valeur] [--click sélecteur] [--dark|--light]"
    );
    process.exit(2);
  }
  const browser = await chromium.launch();
  try {
    if (opts.mode === "both") {
      const { dir, name, ext } = path.parse(opts.out);
      await capture(browser, opts, "desktop", path.join(dir, `${name}-desktop${ext || ".png"}`));
      await capture(browser, opts, "mobile", path.join(dir, `${name}-mobile${ext || ".png"}`));
    } else {
      await capture(browser, opts, opts.mode, opts.out);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
