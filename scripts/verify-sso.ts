/**
 * End-to-end proof of the browser SSO flow, without a browser:
 *   app /api/auth/oidc/login → Keycloak login form (password) → OTP form
 *   (TOTP computed from the demo secret) → app callback → session cookie.
 * Then checks RBAC on a real mutation: a reviewer is refused, an operator
 * is allowed.
 *
 * Prerequisites: app on APP_URL with OIDC_* configured, Keycloak realm from
 * infra/keycloak/configure-realm.sh.
 * Usage: node --import tsx scripts/verify-sso.ts
 */
import { createHmac } from "node:crypto";

const APP = process.env.APP_URL ?? "http://127.0.0.1:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo-Password-2026!";
const TOTP_SECRET =
  process.env.DEMO_TOTP_SECRET ?? "catamotive-lab-totp-secret";

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits). */
export function totp(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

class Browser {
  private jar = new Map<string, Map<string, string>>();
  private store(url: string, response: Response) {
    const host = new URL(url).host;
    const cookies = this.jar.get(host) ?? new Map();
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line))
        cookies.delete(name);
      else cookies.set(name, value);
    }
    this.jar.set(host, cookies);
  }
  cookie(url: string, name: string) {
    return this.jar.get(new URL(url).host)?.get(name);
  }
  async request(url: string, init: RequestInit = {}) {
    const cookies = this.jar.get(new URL(url).host);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...(init.headers as Record<string, string>),
        ...(cookies?.size
          ? {
              Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            }
          : {}),
      },
    });
    this.store(url, response);
    return response;
  }
  /** Follows redirects; returns the final response and the URL it came from. */
  async navigate(url: string, init: RequestInit = {}) {
    let current = url;
    let response = await this.request(current, init);
    for (
      let hops = 0;
      hops < 10 && response.status >= 300 && response.status < 400;
      hops++
    ) {
      current = new URL(response.headers.get("location")!, current).toString();
      response = await this.request(current);
    }
    return { response, url: current };
  }
}

const formAction = (html: string) => {
  const match = /<form[^>]*action="([^"]+)"/i.exec(html);
  if (!match) throw new Error("Formulaire introuvable dans la page Keycloak");
  return match[1].replaceAll("&amp;", "&");
};

export async function ssoLogin(username: string) {
  const browser = new Browser();
  // 1. App → IdP (authorization request with PKCE + state + nonce)
  const login = await browser.navigate(`${APP}/api/auth/oidc/login`);
  const authorizeUrl = new URL(login.url);
  const steps: string[] = [
    `authorize: code_challenge_method=${authorizeUrl.searchParams.get("code_challenge_method")}, state=${Boolean(authorizeUrl.searchParams.get("state"))}, nonce=${Boolean(authorizeUrl.searchParams.get("nonce"))}`,
  ];
  // 2. First factor: password
  const passwordPage = await login.response.text();
  const afterPassword = await browser.request(formAction(passwordPage), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: PASSWORD }),
  });
  const otpPage = await afterPassword.text();
  if (!/name="otp"/.test(otpPage))
    throw new Error(
      `Keycloak n’a pas demandé l’OTP (HTTP ${afterPassword.status})`,
    );
  steps.push("password: accepted, OTP form displayed (MFA enforced)");
  // 3. Second factor: TOTP
  const afterOtp = await browser.request(formAction(otpPage), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ otp: totp(TOTP_SECRET) }),
  });
  const callback = afterOtp.headers.get("location");
  if (
    afterOtp.status !== 302 ||
    !callback?.startsWith(`${APP}/api/auth/oidc/callback`)
  )
    throw new Error(`OTP refusé (HTTP ${afterOtp.status})`);
  steps.push("otp: accepted, redirect to app callback with authorization code");
  // 4. Callback: code exchange + ID token verification + session
  const landing = await browser.navigate(callback);
  if (!browser.cookie(APP, "catamotive_session"))
    throw new Error(`Pas de session applicative (arrivée sur ${landing.url})`);
  steps.push(
    `callback: session opened, landed on ${new URL(landing.url).pathname}`,
  );
  return { browser, steps, landing };
}

async function tryImport(browser: Browser) {
  const response = await browser.request(`${APP}/api/imports`, {
    method: "POST",
    headers: {
      Origin: APP,
      "X-File-Name": encodeURIComponent("sso-rbac.csv"),
      "Content-Type": "text/csv",
    },
    body: "SKU;Nom\nS1;Test\n",
  });
  return { status: response.status, body: await response.json() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [user, expected] of [
    ["rita.reviewer", 403],
    ["oscar.operator", 201],
  ] as const) {
    const { browser, steps, landing } = await ssoLogin(user);
    const page = await landing.response.text();
    const result = await tryImport(browser);
    console.log(
      JSON.stringify(
        {
          user,
          steps,
          dashboardShowsRole: /Relecteur|Opérateur|Administrateur/.test(page),
          importAttempt: result,
          rbac:
            result.status === expected ? "OK" : `ÉCHEC (attendu ${expected})`,
        },
        null,
        2,
      ),
    );
    if (result.status !== expected) process.exitCode = 1;
  }
}
