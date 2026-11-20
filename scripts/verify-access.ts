// Vérification du contrôle des jetons Cloudflare Access de l'espace admin
// (worker/access.ts) : signature, audience, émetteur, expiration. Clés RSA
// générées pour l'essai, aucun appel réseau. Script autonome comme les autres
// verify-*.

import { resetAccessKeys, verifyAccessJwt, type AccessJwk } from "../worker/access.ts";

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

const TEAM = "seancy.cloudflareaccess.com";
const AUD = "aud-tag-de-test";
const NOW = 1_800_000_000_000;
const b64 = (b: Uint8Array | string) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function keyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
}
async function sign(priv: CryptoKey, header: object, payload: object) {
  const h = b64(JSON.stringify(header));
  const p = b64(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`))
  );
  return `${h}.${p}.${b64(sig)}`;
}

const main = async () => {
  const good = await keyPair();
  const other = await keyPair();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1" } as AccessJwk;
  let loads = 0;
  const load = async () => {
    loads++;
    return [jwk];
  };
  const opts = { load, now: NOW };
  const payload = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: NOW / 1000 + 600,
    email: "admin@seancy.test",
  };
  const header = { alg: "RS256", kid: "k1" };

  resetAccessKeys();
  check(
    "Jeton valide : adresse rendue",
    await verifyAccessJwt(await sign(good.privateKey, header, payload), TEAM, AUD, opts),
    "admin@seancy.test"
  );
  check(
    "Autre audience refusée",
    await verifyAccessJwt(
      await sign(good.privateKey, header, { ...payload, aud: ["autre"] }),
      TEAM,
      AUD,
      opts
    ),
    null
  );
  check(
    "Autre émetteur refusé",
    await verifyAccessJwt(
      await sign(good.privateKey, header, {
        ...payload,
        iss: "https://pirate.cloudflareaccess.com",
      }),
      TEAM,
      AUD,
      opts
    ),
    null
  );
  check(
    "Jeton expiré refusé",
    await verifyAccessJwt(
      await sign(good.privateKey, header, { ...payload, exp: NOW / 1000 - 1 }),
      TEAM,
      AUD,
      opts
    ),
    null
  );
  check(
    "Signé par une autre clé : refusé",
    await verifyAccessJwt(await sign(other.privateKey, header, payload), TEAM, AUD, opts),
    null
  );
  const valid = await sign(good.privateKey, header, payload);
  const [h, , s] = valid.split(".");
  check(
    "Contenu modifié après signature : refusé",
    await verifyAccessJwt(
      `${h}.${b64(JSON.stringify({ ...payload, email: "pirate@x.test" }))}.${s}`,
      TEAM,
      AUD,
      opts
    ),
    null
  );
  check(
    "Algorithme « none » refusé",
    await verifyAccessJwt(
      `${b64(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64(JSON.stringify(payload))}.`,
      TEAM,
      AUD,
      opts
    ),
    null
  );
  check("En-tête vide refusé", await verifyAccessJwt("", TEAM, AUD, opts), null);
  check("Jeton illisible refusé", await verifyAccessJwt("abc.def.ghi", TEAM, AUD, opts), null);
  check(
    "Service token (sans adresse) accepté",
    await verifyAccessJwt(
      await sign(good.privateKey, header, { ...payload, email: undefined }),
      TEAM,
      AUD,
      opts
    ),
    ""
  );

  resetAccessKeys();
  loads = 0;
  for (let i = 0; i < 5; i++) {
    await verifyAccessJwt(
      await sign(good.privateKey, { alg: "RS256", kid: `inconnue-${i}` }, payload),
      TEAM,
      AUD,
      { load, now: NOW + i }
    );
  }
  check("Clés inconnues : relues au plus une fois par minute", loads, 1);

  console.log(`\n${passed} OK, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
};
void main();
