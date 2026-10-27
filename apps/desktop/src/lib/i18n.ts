import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "@alyassir/i18n";
import type { Language } from "@alyassir/shared";

const STORAGE_KEY = "alyassir.language";

/** Before sign-in the device's last language is used; after sign-in, the user's own choice. */
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
  resources,
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
    // The language still switches; it just is not remembered on this device.
  }
});

export function currentLanguage(): Language {
  return i18n.language === "fr" ? "fr" : "ar";
}

export default i18n;
