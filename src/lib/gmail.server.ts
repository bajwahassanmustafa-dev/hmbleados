// Per-user Gmail connection via Google OAuth 2.0.
// Tokens are stored encrypted (AES-256-GCM) in app_user_connections, which is
// only reachable with the service role - never from the browser.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CONNECTOR_ID = "gmail_oauth";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export class GmailError extends Error {
  constructor(
    message: string,
    public readonly kind: "config" | "not_connected" | "reauth" | "rejected" | "rate_limit" | "upstream",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

type StoredTokens = {
  refresh_token: string;
  access_token: string;
  expires_at: number; // epoch ms
};

function env() {
  return {
    clientId: process.env["GOOGLE_OAUTH_CLIENT_ID"],
    clientSecret: process.env["GOOGLE_OAUTH_CLIENT_SECRET"],
    encKey: process.env["GMAIL_TOKEN_ENCRYPTION_KEY"],
  };
}

export function isGmailConfigured(): { configured: boolean; missing: string[] } {
  const e = env();
  const missing: string[] = [];
  if (!e.clientId) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!e.clientSecret) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!e.encKey) missing.push("GMAIL_TOKEN_ENCRYPTION_KEY");
  return { configured: missing.length === 0, missing };
}

export function callbackUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/public/gmail/callback`;
}

// --- crypto ---------------------------------------------------------------

function keyBytes(): Buffer {
  const raw = env().encKey;
  if (!raw) throw new GmailError("GMAIL_TOKEN_ENCRYPTION_KEY is not set.", "config");
  return createHash("sha256").update(raw).digest();
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function decrypt(stored: string): string {
  const buf = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", keyBytes()).update(payload).digest());
}

export function createState(userId: string): string {
  const payload = b64url(JSON.stringify({ u: userId, e: Date.now() + 10 * 60 * 1000, n: b64url(randomBytes(8)) }));
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string): string {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) throw new GmailError("Invalid OAuth state.", "rejected");
  const expected = sign(payload);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new GmailError("OAuth state signature mismatch.", "rejected");
  }
  const parsed = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (typeof parsed.u !== "string" || typeof parsed.e !== "number" || parsed.e < Date.now()) {
    throw new GmailError("OAuth state expired. Start the connection again.", "rejected");
  }
  return parsed.u;
}

// --- OAuth flow -------------------------------------------------------------

export function buildAuthUrl(userId: string, origin: string): string {
  const { clientId } = env();
  const cfg = isGmailConfigured();
  if (!cfg.configured || !clientId) {
    throw new GmailError(`Gmail is not configured. Missing: ${cfg.missing.join(", ")}`, "config");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: createState(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = env();
  if (!clientId || !clientSecret) throw new GmailError("Google OAuth client is not configured.", "config");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const msg = `${json.error ?? res.status}: ${json.error_description ?? "token request failed"}`;
    console.error(`[gmail] token error ${msg}`);
    if (json.error === "invalid_grant") {
      throw new GmailError("Gmail authorization expired or was revoked. Please reconnect Gmail.", "reauth", res.status);
    }
    if (json.error === "invalid_client" || json.error === "unauthorized_client") {
      throw new GmailError(`Google rejected the OAuth client (${msg}). Check GOOGLE_OAUTH_CLIENT_ID / SECRET.`, "config", res.status);
    }
    throw new GmailError(`Google token exchange failed (${msg}).`, "upstream", res.status);
  }
  return json;
}

export async function completeOAuthCallback(code: string, state: string, origin: string): Promise<{ email: string }> {
  const userId = verifyState(state);
  const tokens = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl(origin),
  });
  if (!tokens.refresh_token) {
    throw new GmailError(
      "Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.",
      "rejected",
    );
  }
  if (!tokens.scope?.includes("gmail.send")) {
    throw new GmailError("The Gmail send permission was not granted. Please approve all requested permissions.", "rejected");
  }

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const info = (await infoRes.json().catch(() => ({}))) as { email?: string };
  if (!infoRes.ok || !info.email) {
    throw new GmailError("Could not read the connected Gmail address.", "upstream", infoRes.status);
  }

  const stored: StoredTokens = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
  };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("app_user_connections").upsert(
    {
      user_id: userId,
      connector_id: CONNECTOR_ID,
      connection_key_ciphertext: encrypt(JSON.stringify(stored)),
      account_email: info.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,connector_id" },
  );
  if (error) throw new GmailError(`Could not save the Gmail connection: ${error.message}`, "upstream");
  return { email: info.email };
}

// --- status / tokens --------------------------------------------------------

export type GmailStatus = {
  configured: boolean;
  missing: string[];
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
};

export async function getGmailStatus(userId: string): Promise<GmailStatus> {
  const cfg = isGmailConfigured();
  if (!cfg.configured) {
    return { configured: false, missing: cfg.missing, connected: false, email: null, connectedAt: null };
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("app_user_connections")
    .select("account_email, updated_at")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID)
    .maybeSingle();
  return {
    configured: true,
    missing: [],
    connected: !!data,
    email: data?.account_email ?? null,
    connectedAt: data?.updated_at ?? null,
  };
}

async function getAccessToken(userId: string): Promise<{ token: string; email: string }> {
  const cfg = isGmailConfigured();
  if (!cfg.configured) throw new GmailError(`Gmail is not configured. Missing: ${cfg.missing.join(", ")}`, "config");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("app_user_connections")
    .select("connection_key_ciphertext, account_email")
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID)
    .maybeSingle();
  if (error) throw new GmailError(`Could not load Gmail connection: ${error.message}`, "upstream");
  if (!data) throw new GmailError("No Gmail account is connected. Connect Gmail in Settings.", "not_connected");

  let tokens: StoredTokens;
  try {
    tokens = JSON.parse(decrypt(data.connection_key_ciphertext));
  } catch {
    throw new GmailError("Stored Gmail credentials could not be read. Please reconnect Gmail.", "reauth");
  }

  if (tokens.expires_at > Date.now() + 30_000) {
    return { token: tokens.access_token, email: data.account_email ?? "" };
  }

  const refreshed = await tokenRequest({ refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
  const next: StoredTokens = {
    refresh_token: tokens.refresh_token,
    access_token: refreshed.access_token,
    expires_at: Date.now() + (refreshed.expires_in - 60) * 1000,
  };
  await supabaseAdmin
    .from("app_user_connections")
    .update({ connection_key_ciphertext: encrypt(JSON.stringify(next)) })
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID);
  return { token: next.access_token, email: data.account_email ?? "" };
}

export async function disconnectGmail(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    const { token } = await getAccessToken(userId);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch (e) {
    // Revocation is best-effort; we still remove the stored credentials.
    console.warn("[gmail] revoke skipped:", (e as Error).message);
  }
  const { error } = await supabaseAdmin
    .from("app_user_connections")
    .delete()
    .eq("user_id", userId)
    .eq("connector_id", CONNECTOR_ID);
  if (error) throw new GmailError(`Could not remove Gmail connection: ${error.message}`, "upstream");
}

// --- sending ----------------------------------------------------------------

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const header = (v: string) => (/^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`);

function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  const email = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${header(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
  return b64url(email);
}

export async function sendGmailMessage(
  userId: string,
  args: { to: string; subject: string; body: string },
): Promise<{ id: string; threadId?: string }> {
  const { token, email } = await getAccessToken(userId);
  const raw = buildRawEmail(email, args.to, args.subject, args.body);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[gmail] send failed [${res.status}]: ${text}`);
    let msg = text.slice(0, 300);
    try {
      msg = JSON.parse(text)?.error?.message ?? msg;
    } catch {
      /* ignore */
    }
    if (res.status === 401) throw new GmailError("Gmail authorization expired. Please reconnect Gmail.", "reauth", 401);
    if (res.status === 403) throw new GmailError(`Gmail refused to send: ${msg}`, "rejected", 403);
    if (res.status === 429) throw new GmailError(`Gmail rate limit reached: ${msg}`, "rate_limit", 429);
    if (res.status === 400) throw new GmailError(`Gmail rejected the message: ${msg}`, "rejected", 400);
    throw new GmailError(`Gmail error (${res.status}): ${msg}`, "upstream", res.status);
  }
  const json = (await res.json()) as { id: string; threadId?: string };
  return json;
}
