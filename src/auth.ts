import fs from "node:fs/promises";
import { readConfig, writeConfig } from "./config.js";
import { getMe } from "./plaud-api.js";

export type StatusUpdate = { msg: string; elapsedMs: number };

function cleanToken(token: string): string {
  return String(token || "")
    .trim()
    .replace(/^bearer\s+/i, "");
}

function isProbablyJwt(token: string): boolean {
  const t = cleanToken(token);
  return t.startsWith("eyJ") && t.length > 20;
}

function stripUrlQuery(url: string): string {
  try {
    const u = new URL(String(url));
    u.search = "";
    return u.toString();
  } catch {
    return "";
  }
}

export type SanitizedMe = {
  status: number | null;
  user: {
    id: string | null;
    email: string | null;
    nickname: string | null;
    country: string | null;
    userAreaName: string | null;
    avatarUrl: string | null;
  } | null;
  state: {
    isMembership: number | null;
    membershipType: string | null;
    membershipFlag: string | null;
  } | null;
};

function sanitizeMe(me: any): SanitizedMe | null {
  if (!me || typeof me !== "object") return null;
  const dataUser = me.data_user && typeof me.data_user === "object" ? me.data_user : null;
  const dataState = me.data_state && typeof me.data_state === "object" ? me.data_state : null;

  const user = dataUser
    ? {
        id: dataUser.id || null,
        email: dataUser.email || null,
        nickname: dataUser.nickname || null,
        country: dataUser.country || null,
        userAreaName: dataUser.user_area_name || null,
        avatarUrl: dataUser.avatar ? stripUrlQuery(dataUser.avatar) : null,
      }
    : null;

  const state = dataState
    ? {
        isMembership: dataState.is_membership ?? null,
        membershipType: dataState.membership_type ?? null,
        membershipFlag: dataState.membership_flag ?? null,
      }
    : null;

  return { status: me.status ?? null, user, state };
}

export async function validateToken(
  token: string,
  region: "us" | "eu" = "us",
): Promise<{ ok: true; me: SanitizedMe | null } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "missing" };
  try {
    const me = await getMe({ token, region });
    return { ok: true, me: sanitizeMe(me) };
  } catch (error: any) {
    return { ok: false, reason: error?.message || "invalid" };
  }
}

export async function saveToken(token: string, region?: "us" | "eu"): Promise<string> {
  const clean = cleanToken(token);
  if (!isProbablyJwt(clean)) throw new Error("Invalid token format");
  const existing = await readConfig();
  await writeConfig({ ...existing, authToken: clean, ...(region ? { region } : {}) });
  return clean;
}

export async function importTokenFromHar(harPath: string): Promise<string> {
  const raw = await fs.readFile(harPath, "utf8");
  const har = JSON.parse(raw);
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Invalid HAR: missing log.entries");
  }

  for (const entry of entries) {
    const req = entry?.request;
    const headers = req?.headers;
    if (!Array.isArray(headers)) continue;
    const auth = headers.find((h: any) => String(h?.name || "").toLowerCase() === "authorization")?.value;
    if (!auth) continue;
    if (!String(auth).toLowerCase().startsWith("bearer ")) continue;

    const token = cleanToken(auth);
    if (!isProbablyJwt(token)) continue;
    return token;
  }

  throw new Error("No bearer token found in HAR");
}

export async function captureTokenFromBrowser({
  url = "https://app.plaud.ai",
  timeoutMs = 180_000,
  channel = "chrome",
  headless = false,
  onStatus,
}: {
  url?: string;
  timeoutMs?: number;
  channel?: string;
  headless?: boolean;
  onStatus?: (s: StatusUpdate) => void;
}): Promise<string> {
  let playwright: any;
  try {
    playwright = await import("playwright-core");
  } catch {
    throw new Error("Missing dependency: playwright-core");
  }

  const { chromium } = playwright;
  const startedAt = Date.now();
  const status = (msg: string) => {
    if (typeof onStatus === "function") onStatus({ msg, elapsedMs: Date.now() - startedAt });
  };

  status(`Launching browser (${channel}${headless ? ", headless" : ""})`);

  let browser: any;
  try {
    browser = await chromium.launch({ headless, channel });
  } catch {
    throw new Error(
      `Failed to launch browser channel "${channel}". Install Chrome/Edge, or use \`plaud auth import-har\`.`,
    );
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    let capturedToken = "";
    const started = Date.now();

    const maybeCapture = (request: any) => {
      try {
        const reqUrl = request.url();
        if (!reqUrl.includes("api.plaud.ai")) return;
        const headers = request.headers?.() || {};
        const auth = headers.authorization || headers.Authorization;
        if (!auth) return;
        if (!String(auth).toLowerCase().startsWith("bearer ")) return;
        const token = cleanToken(auth);
        if (isProbablyJwt(token)) {
          capturedToken = token;
          status("Captured Plaud bearer token");
        }
      } catch {
        // ignore
      }
    };

    page.on("request", maybeCapture);
    context.on("request", maybeCapture);

    status("Opening Plaud login page (complete sign-in in the browser)");
    await page.goto(url, { waitUntil: "domcontentloaded" });

    status("Waiting for Plaud API request with auth header");
    while (!capturedToken && Date.now() - started < timeoutMs) {
      await page.waitForTimeout(250);
    }

    if (!capturedToken) {
      throw new Error(
        "Timed out waiting for Plaud API auth. Please complete login in the opened browser window, or use `plaud auth import-har`.",
      );
    }

    return capturedToken;
  } finally {
    status("Closing browser");
    await browser.close();
  }
}

