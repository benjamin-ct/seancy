// Génère les icônes PWA reprenant le logo Seancy (piste « Ticket », voir
// src/shared/components/TicketLogo/TicketLogo.tsx) en PNG brut, sans
// dépendance externe (juste zlib, déjà fourni par Node) : le ticket et sa
// perforation sont calculés analytiquement, le « S » vectorisé est rempli
// par balayage de lignes, le tout suréchantillonné 4×4 pour l'anticrénelage.
// Deux jeux : celui du site (public/, ticket corail) et celui du site de
// développement (develop-icons/, ticket bleu, copié par-dessus le premier au
// déploiement de develop, voir scripts/develop-assets.ts).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

type Rgba = readonly [number, number, number, number];

const BG_DARK: Rgba = [0x09, 0x16, 0x2b, 0xff]; // #09162B (fond de la maquette « Nouvelle DA »)
const BG_LIGHT: Rgba = [0xf5, 0xf8, 0xff, 0xff]; // #F5F8FF
const CORAL: Rgba = [0xaa, 0x38, 0x36, 0xff]; // oklch(0.505 0.15 25) en sRGB
// Site de développement : même bleu que le logo (TicketLogo.module.css, .dev).
const DEV_BLUE: Rgba = [0x17, 0x62, 0xb6, 0xff]; // oklch(0.5 0.15 255) en sRGB
const S_COLOR: Rgba = [0xf5, 0xf8, 0xff, 0xff]; // #F5F8FF

// Même tracé que TICKET_S_PATH (TicketLogo.tsx), repère viewBox 0 0 120 80.
const S_PATH =
  "M43.2 56.5Q41.2 56.5 39.9 56.1Q38.6 55.7 37.8 55.1Q37 54.6 36.6 54.1Q36.2 53.7 36 53.7Q35.7 53.7 35.3 54.1Q34.9 54.5 34.5 54.9Q34 55.4 33.6 55.8Q33.2 56.2 32.9 56.2Q32.5 56.2 32.4 55.9Q32.2 55.7 32.2 55.3L33.6 46.6Q33.6 46.1 33.8 45.9Q34.1 45.6 34.4 45.6Q34.7 45.6 34.9 45.9Q35.1 46.1 35.2 46.5L35.7 49.4Q36.1 52.2 37.9 53.6Q39.6 55.1 42 55.1Q43.7 55.1 44.9 54.4Q46.2 53.8 47 52.7Q47.7 51.5 47.9 50.1Q48.3 48 47.3 46.2Q46.3 44.4 43.4 42.4Q40.1 40.1 38.7 37.9Q37.4 35.7 37.7 32.8Q37.9 30.3 39.4 28.1Q40.9 26 43.6 24.6Q46.3 23.2 50 23.2Q53.1 23.2 55.1 24.2Q57.2 25.2 58.2 26.8Q59.2 28.4 59.1 30.2Q59 31.5 58.4 32.2Q57.9 33 56.9 33Q56.1 33 55.6 32.5Q55.2 32 54.9 30.9L54.5 29Q54 26.6 52.7 25.5Q51.5 24.5 49.6 24.5Q47.7 24.5 46.2 25.3Q44.8 26.1 43.9 27.4Q43.1 28.7 42.9 30.3Q42.6 32.6 43.7 34.4Q44.8 36.3 47.6 38.4Q50.2 40.2 51.5 41.9Q52.9 43.5 53.3 45.1Q53.7 46.7 53.5 48.4Q53.3 50.9 51.8 52.7Q50.4 54.5 48.2 55.5Q45.9 56.5 43.2 56.5Z";

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

type Point = readonly [number, number];

// Aplatit le tracé (M/L/Q/Z uniquement) en segments.
function flattenPath(d: string): [Point, Point][] {
  const tokens = d.match(/[MLQZ]|-?[\d.]+/g) ?? [];
  const edges: [Point, Point][] = [];
  let i = 0;
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      cur = start = [num(), num()];
    } else if (cmd === "L") {
      const next: Point = [num(), num()];
      edges.push([cur, next]);
      cur = next;
    } else if (cmd === "Q") {
      const c: Point = [num(), num()];
      const end: Point = [num(), num()];
      const steps = 8;
      let prev = cur;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        const pt: Point = [
          u * u * cur[0] + 2 * u * t * c[0] + t * t * end[0],
          u * u * cur[1] + 2 * u * t * c[1] + t * t * end[1],
        ];
        edges.push([prev, pt]);
        prev = pt;
      }
      cur = end;
    } else if (cmd === "Z") {
      edges.push([cur, start]);
      cur = start;
    }
  }
  return edges;
}

const S_EDGES = flattenPath(S_PATH);

// Vrai si (x, y), en unités du viewBox 120×80, est dans le ticket : rectangle
// moins les deux encoches demi-rondes (rayon 10, centrées à mi-hauteur).
function inTicket(x: number, y: number): boolean {
  if (x < 0 || x > 120 || y < 0 || y > 80) {
    return false;
  }
  const dy = y - 40;
  if (x * x + dy * dy < 100) {
    return false;
  }
  if ((x - 120) * (x - 120) + dy * dy < 100) {
    return false;
  }
  return true;
}

// Ligne de perforation : x=86, trait 3, pointillés 5/5 de y=8 à y=72.
function inPerforation(x: number, y: number): boolean {
  return Math.abs(x - 86) <= 1.5 && y >= 8 && y <= 72 && (y - 8) % 10 < 5;
}

// Abscisses où la ligne horizontale y croise le « S » (règle pair-impair).
function sCrossings(y: number): number[] {
  const xs: number[] = [];
  for (const [[x1, y1], [x2, y2]] of S_EDGES) {
    if (y1 <= y !== y2 <= y) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  return xs.sort((a, b) => a - b);
}

function inS(x: number, crossings: number[]): boolean {
  let inside = false;
  for (const cx of crossings) {
    if (cx > x) {
      break;
    }
    inside = !inside;
  }
  return inside;
}

function blend(dst: number[], src: Rgba, alpha: number): void {
  for (let c = 0; c < 3; c++) {
    dst[c] = dst[c] * (1 - alpha) + src[c] * alpha;
  }
}

const SUPERSAMPLE = 4;

type IconOptions = {
  rounded?: boolean;
  ticketWidthRatio?: number;
  bg?: Rgba | null;
  ticketColor?: Rgba;
};

function drawIcon(
  size: number,
  { rounded = true, ticketWidthRatio = 0.72, bg = BG_DARK, ticketColor = CORAL }: IconOptions = {}
): Buffer {
  const cornerR = rounded ? size * 0.18 : 0;
  // Pixels → unités du viewBox du ticket, centré sur le canevas.
  const scale = 120 / (ticketWidthRatio * size);
  const originX = (size - 120 / scale) / 2;
  const originY = (size - 80 / scale) / 2;
  const n = SUPERSAMPLE;
  const samples = n * n;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type 0 (none) for this scanline
    const rows: { py: number; v: number; crossings: number[] }[] = [];
    for (let sy = 0; sy < n; sy++) {
      const py = y + (sy + 0.5) / n;
      const v = (py - originY) * scale;
      rows.push({ py, v, crossings: sCrossings(v) });
    }
    for (let x = 0; x < size; x++) {
      let ticket = 0;
      let perforation = 0;
      let letter = 0;
      let mask = 0;
      for (const { py, v, crossings } of rows) {
        for (let sx = 0; sx < n; sx++) {
          const px = x + (sx + 0.5) / n;
          const u = (px - originX) * scale;
          if (inTicket(u, v)) {
            ticket++;
            if (inPerforation(u, v)) {
              perforation++;
            } else if (inS(u, crossings)) {
              letter++;
            }
          }
          if (rounded) {
            // Coins arrondis : hors du rectangle à coins arrondis = transparent.
            const nearestX = Math.min(Math.max(px, cornerR), size - cornerR);
            const nearestY = Math.min(Math.max(py, cornerR), size - cornerR);
            const dx = px - nearestX;
            const dy = py - nearestY;
            if (dx * dx + dy * dy <= cornerR * cornerR) {
              mask++;
            }
          } else {
            mask++;
          }
        }
      }
      let alpha = mask / samples;
      const color = [ticketColor[0], ticketColor[1], ticketColor[2]];
      if (bg) {
        color.splice(0, 3, bg[0], bg[1], bg[2]);
        blend(color, ticketColor, ticket / samples);
        blend(color, bg, perforation / samples);
      } else {
        // Fond transparent (favicon) : la perforation est découpée dans le
        // ticket, qui porte seul l'opacité.
        alpha = (ticket - perforation) / samples;
      }
      if (ticket - perforation > 0) {
        blend(color, S_COLOR, letter / (ticket - perforation));
      }
      raw[offset++] = Math.round(color[0]);
      raw[offset++] = Math.round(color[1]);
      raw[offset++] = Math.round(color[2]);
      raw[offset++] = Math.round(255 * alpha);
    }
  }
  return raw;
}

function writePng(filePath: string, size: number, opts?: IconOptions): void {
  const raw = drawIcon(size, opts);
  const idat = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  fs.writeFileSync(filePath, png);
  console.log(`Écrit ${filePath} (${size}x${size})`);
}

const rootDir = path.join(import.meta.dirname, "..");
const publicDir = path.join(rootDir, "public");
const developDir = path.join(rootDir, "develop-icons");

function writeIcons(dir: string, ticketColor: Rgba): void {
  fs.mkdirSync(dir, { recursive: true });
  // Android (manifest PWA) : le standard `icons` du Web App Manifest ne permet
  // pas de varier selon le thème système, donc un seul jeu, sur le thème
  // sombre (par défaut de l'app).
  writePng(path.join(dir, "icon-192.png"), 192, { rounded: true, ticketColor });
  writePng(path.join(dir, "icon-512.png"), 512, { rounded: true, ticketColor });
  // Icône maskable : le motif doit rester dans la zone de sécurité (cercle de
  // 80% de diamètre centré) du masque adaptatif Android, qui gère lui-même la
  // forme — donc pas de coins arrondis ici, et un motif plus petit (demi-
  // diagonale du ticket ≈ 0,6 × sa largeur, à garder sous 0,4 × la taille).
  writePng(path.join(dir, "icon-maskable-512.png"), 512, {
    rounded: false,
    ticketWidthRatio: 0.58,
    ticketColor,
  });
  // iOS ("Ajouter à l'écran d'accueil") : Safari choisit entre ces deux icônes
  // au moment de l'ajout selon le thème système (voir les deux
  // <link rel="apple-touch-icon"> dans index.html).
  writePng(path.join(dir, "apple-touch-icon.png"), 180, {
    rounded: true,
    bg: BG_LIGHT,
    ticketColor,
  });
  writePng(path.join(dir, "apple-touch-icon-dark.png"), 180, {
    rounded: true,
    bg: BG_DARK,
    ticketColor,
  });
  // Favicon PNG (repli des navigateurs sans favicon SVG) : ticket seul, sur
  // fond transparent.
  writePng(path.join(dir, "favicon-32.png"), 32, {
    rounded: false,
    ticketWidthRatio: 1,
    bg: null,
    ticketColor,
  });
}

writeIcons(publicDir, CORAL);
writeIcons(developDir, DEV_BLUE);
// Favicon SVG de develop : celui du site (public/favicon.svg, écrit à la main),
// ticket recoloré en bleu.
const hex = (c: Rgba) =>
  "#" +
  c
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const faviconSvg = fs.readFileSync(path.join(publicDir, "favicon.svg"), "utf8");
if (!faviconSvg.includes(`fill="${hex(CORAL)}"`)) {
  throw new Error(`public/favicon.svg : couleur du ticket (${hex(CORAL)}) introuvable.`);
}
fs.writeFileSync(
  path.join(developDir, "favicon.svg"),
  faviconSvg.replace(`fill="${hex(CORAL)}"`, `fill="${hex(DEV_BLUE)}"`)
);
console.log(`Écrit ${path.join(developDir, "favicon.svg")}`);
