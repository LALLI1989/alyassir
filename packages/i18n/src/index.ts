import ar from "./ar.json";
import fr from "./fr.json";

/** Interface texts. Arabic is the reference: French must have exactly the same keys. */
export const resources = {
  ar: { translation: ar },
  fr: { translation: fr },
} as const;

export { ar, fr };
