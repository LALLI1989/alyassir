/** Business constants fixed by the SPEC or by the owner's decisions. */

/** Failed logins before a temporary lock (SPEC 4.15). */
export const MAX_FAILED_LOGINS = 5;
/** Temporary lock duration in minutes (owner decision 27/10/2026). */
export const LOCK_MINUTES = 15;
/** Minimum password length (owner decision 27/10/2026). */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

/** Access token lifetime (SPEC 3.2). */
export const ACCESS_TOKEN_MINUTES = 15;
/** Default automatic logout after inactivity, changeable by the manager (SPEC 7.3). */
export const DEFAULT_IDLE_MINUTES = 60;
export const MIN_IDLE_MINUTES = 5;
export const MAX_IDLE_MINUTES = 8 * 60;

/** An approved edit request is a one-time grant valid for 24 hours (SPEC 8). */
export const EDIT_GRANT_HOURS = 24;

/** Agency logo, the only stored image (SPEC 2). */
export const LOGO_MAX_BYTES = 500 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

export const LANGUAGES = ["ar", "fr"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Business time zone (SPEC 4.11). */
export const BUSINESS_TIME_ZONE = "Africa/Casablanca";

/** Headers sent by every client. */
export const HEADER_DEVICE = "x-alyassir-device";
export const HEADER_CLIENT_VERSION = "x-alyassir-client-version";
/** Sent only when the person used the app recently: background refreshes must not keep a session alive. */
export const HEADER_USER_ACTIVE = "x-alyassir-user-active";
