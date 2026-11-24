import { HttpError } from "./http";

/**
 * Transactional email. Drivers (MAIL_DRIVER):
 * - `resend`: Resend HTTP API (RESEND_API_KEY, MAIL_FROM), no extra dependency;
 * - `log` (default): prints the message in development. In production it
 *   refuses (503) rather than write account links to the logs;
 * - `memory`: keeps messages in memory, for tests.
 */
export type Mail = { to: string; subject: string; text: string; html: string };

const memoryOutbox: Mail[] = [];
export function sentMails() {
  return memoryOutbox;
}

export async function sendMail(mail: Mail) {
  const driver = process.env.MAIL_DRIVER ?? "log";
  if (driver === "memory") {
    memoryOutbox.push(mail);
    return;
  }
  if (driver === "resend") {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.MAIL_FROM;
    if (!key || !from)
      throw new Error("RESEND_API_KEY et MAIL_FROM sont requis pour l’email.");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, ...mail, to: [mail.to] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("Envoi d’email refusé", response.status);
      throw new HttpError(
        503,
        "L’envoi d’email est momentanément indisponible. Réessayez.",
      );
    }
    return;
  }
  if (process.env.NODE_ENV === "production") {
    console.error("Email non envoyé : MAIL_DRIVER=resend n’est pas configuré.");
    throw new HttpError(
      503,
      "L’envoi d’email n’est pas encore configuré sur ce service.",
    );
  }
  console.info(
    `\n[email] À : ${mail.to}\nObjet : ${mail.subject}\n${mail.text}\n`,
  );
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function appUrl(path: string) {
  const origin = (process.env.APP_ORIGIN ?? "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );
  return `${origin}${path}`;
}

/** Builds a plain-text and HTML email around one call-to-action link. */
export function actionMail(input: {
  to: string;
  subject: string;
  intro: string[];
  action: string;
  url: string;
  outro: string;
}): Mail {
  const text = [
    ...input.intro,
    "",
    `${input.action} : ${input.url}`,
    "",
    input.outro,
    "",
    "— CataMotive",
  ].join("\n");
  const paragraphs = input.intro
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  const html = `<!doctype html><html lang="fr"><body style="font-family:system-ui,sans-serif;color:#1c1c1c;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">${paragraphs}<p><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#1c1c1c;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${escapeHtml(input.action)}</a></p><p style="font-size:13px;color:#666">Lien direct : ${escapeHtml(input.url)}</p><p style="font-size:13px;color:#666">${escapeHtml(input.outro)}</p><p style="font-size:13px;color:#666">— CataMotive</p></body></html>`;
  return { to: input.to, subject: input.subject, text, html };
}
