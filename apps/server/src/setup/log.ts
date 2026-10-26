import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only setup log. Secrets are registered so they are never written out. */
export class SetupLog {
  private readonly secrets: string[] = [];

  constructor(private readonly file: string | null) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  addSecret(secret: string): void {
    if (secret) this.secrets.push(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("***");
    return out;
  }

  info(message: string): void {
    const line = `${new Date().toISOString()} ${this.redact(message)}`;
    console.log(line);
    if (this.file) {
      try {
        appendFileSync(this.file, line + "\r\n", "utf8");
      } catch {
        // Logging must never break setup.
      }
    }
  }
}
