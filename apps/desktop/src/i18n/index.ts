import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ar from "./ar.json";
import fr from "./fr.json";

export type Language = "ar" | "fr";
const STORAGE_KEY = "alyassir.language";

function savedLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === "fr" ? "fr" : "ar";
  } catch {
    return "ar";
  }
}

/** Direction follows the language instantly, without restarting (SPEC 3.1). */
function applyDirection(lng: string): void {
  document.documentElement.lang = lng;
  document.documentElement.dir = lng === "ar" ? "rtl" : "ltr";
}

void i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar }, fr: { translation: fr } },
  lng: savedLanguage(),
  fallbackLng: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});
applyDirection(i18n.language);

i18n.on("languageChanged", (lng) => {
  applyDirection(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // Language still switches; it just is not remembered.
  }
});

export default i18n;
