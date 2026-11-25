// Photo de profil personnelle (migration 0015). Le navigateur envoie une
// image déjà recadrée et compressée ; le Worker se contente de vérifier sa
// taille et son format réel (octets de signature, pas le content-type
// annoncé) avant de la stocker, pour ne jamais resservir autre chose qu'une
// image depuis notre propre domaine (un SVG ou du HTML y serait exécutable).

export const AVATAR_MAX_BYTES = 300 * 1024;

export type AvatarContentType = "image/jpeg" | "image/png" | "image/webp";

export function sniffAvatarType(bytes: Uint8Array): AvatarContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Version (date de mise à jour) de la photo du compte, `null` s'il n'en a pas. */
export async function getAvatarVersion(db: D1Database, userId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT updated_at FROM user_avatars WHERE user_id = ?")
    .bind(userId)
    .first<{ updated_at: number }>();
  return row?.updated_at ?? null;
}

export async function getAvatar(
  db: D1Database,
  userId: number
): Promise<{ contentType: string; data: ArrayBuffer } | null> {
  const row = await db
    .prepare("SELECT content_type, data FROM user_avatars WHERE user_id = ?")
    .bind(userId)
    .first<{ content_type: string; data: ArrayBuffer | number[] }>();
  if (!row) {
    return null;
  }
  // D1 renvoie les BLOB sous forme de tableau d'octets.
  const data = Array.isArray(row.data) ? new Uint8Array(row.data).buffer : row.data;
  return { contentType: row.content_type, data };
}

/** Photo du compte derrière un profil partagé (même clé que sa page publique). */
export async function getSharedProfileAvatar(
  db: D1Database,
  shareSlug: string
): Promise<{ contentType: string; data: ArrayBuffer } | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE share_slug = ? AND pending_deletion_at IS NULL")
    .bind(shareSlug)
    .first<{ id: number }>();
  return row ? getAvatar(db, row.id) : null;
}

export async function saveAvatar(
  db: D1Database,
  userId: number,
  contentType: AvatarContentType,
  data: Uint8Array
): Promise<number> {
  // Toujours croissante, même pour deux envois dans la même milliseconde :
  // c'est la version de l'URL, donc ce qui fait recharger l'image.
  const previous = (await getAvatarVersion(db, userId)) ?? 0;
  const updatedAt = Math.max(Date.now(), previous + 1);
  await db
    .prepare(
      `INSERT INTO user_avatars (user_id, content_type, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at`
    )
    .bind(userId, contentType, data, updatedAt)
    .run();
  return updatedAt;
}

export async function deleteAvatar(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM user_avatars WHERE user_id = ?").bind(userId).run();
}
