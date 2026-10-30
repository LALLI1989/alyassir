/**
 * The manager's recovery code (Phase 8A, owner decision 29/10/2026): 16 characters printed on paper,
 * e.g. K7QM-3XPA-9RTW-LD2F. No 0/O or 1/I so it is easy to read back. Pure: random bytes come in.
 */
export const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RECOVERY_LENGTH = 16;

/** 16 characters from 16 random bytes (32 letters divide 256 evenly: no bias), in groups of 4. */
export function formatRecoveryCode(bytes: ArrayLike<number>): string {
  if (bytes.length < RECOVERY_LENGTH) throw new Error("not enough random bytes");
  let out = "";
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += RECOVERY_ALPHABET[(bytes[i] as number) % RECOVERY_ALPHABET.length];
  }
  return out;
}

/**
 * What the manager typed, in the stored form (16 characters, no dashes), or null when it cannot be a
 * code. Spaces, dashes and lower case are accepted; a character outside the alphabet is refused.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== RECOVERY_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}
