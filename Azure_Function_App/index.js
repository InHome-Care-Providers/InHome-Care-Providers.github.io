/**
 * Azure Functions - HTTP Trigger (Node.js)
 * Writes appointment request submissions into a SharePoint Microsoft List via Microsoft Graph.
 *
 * Required App Settings (Function App > Configuration):
 *   TENANT_ID
 *   CLIENT_ID            (Application (client) ID)
 *   CLIENT_SECRET        (Client Secret VALUE)
 *   SITE_ID              (SharePoint site id string)
 *   LIST_ID              (SharePoint list id GUID)
 *   ALLOWED_ORIGIN       (comma-separated, e.g. https://yourusername.github.io,https://inhomehealthcare.org)
 *   FORM_SHARED_SECRET   (any long random string)
 *
 * SharePoint List columns (create these in your new list):
 *   Title           (Single line - default, auto-filled)
 *   SubmittedAt     (DateTime)
 *   SourcePage      (Single line of text)
 *   FirstName       (Single line of text)
 *   LastName        (Single line of text)
 *   DateOfBirth     (Single line of text)      ← text, not Date, to avoid timezone issues
 *   Phone           (Single line of text)
 *   Email           (Single line of text)
 *   StreetAddress   (Single line of text)
 *   City            (Single line of text)
 *   State           (Single line of text)
 *   Zip             (Single line of text)
 *   PreferredDate   (Single line of text)      ← text to preserve user input exactly
 *   PreferredTime   (Single line of text)
 *   Notes           (Multiple lines - plain text)
 *   UserAgent       (Multiple lines - plain text)
 *   ClientIP        (Single line of text)
 *   Consent         (Yes/No)
 */

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/* ── helpers ─────────────────────────────────────────────────── */

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Form-Secret",
    "Access-Control-Max-Age": "86400",
  };
}

async function getAppToken() {
  const { TENANT_ID, CLIENT_ID, CLIENT_SECRET } = process.env;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET)
    throw new Error("Missing TENANT_ID / CLIENT_ID / CLIENT_SECRET app settings.");

  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error_description || json?.error?.message || JSON.stringify(json);
    throw new Error(`Token request failed (${res.status}): ${msg}`);
  }
  return json.access_token;
}

function toText(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

function toYesNo(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "").toLowerCase().trim();
  return ["yes", "true", "agree", "on", "1"].includes(s);
}

/* ── main handler ────────────────────────────────────────────── */

module.exports = async function (context, req) {
  const allowedOrigins = (process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const origin = (req.headers?.origin || "").trim();
  const echoOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0] || "*";

  context.log(`Origin received="${origin}" AllowedOrigins="${allowedOrigins.join(" | ")}"`);

  // ── CORS preflight ──
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: corsHeaders(echoOrigin), body: "" };
    return;
  }

  // ── Origin check ──
  if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
    context.res = {
      status: 403,
      headers: corsHeaders(echoOrigin),
      body: { ok: false, error: "Origin not allowed" },
    };
    return;
  }

  // ── Shared-secret check ──
  const sharedSecret = process.env.FORM_SHARED_SECRET || "";
  const incoming = req.headers?.["x-form-secret"] || req.headers?.["X-Form-Secret"] || "";
  if (sharedSecret && incoming !== sharedSecret) {
    context.res = {
      status: 401,
      headers: corsHeaders(echoOrigin),
      body: { ok: false, error: "Unauthorized" },
    };
    return;
  }

  // ── Validate config ──
  const { SITE_ID, LIST_ID } = process.env;
  if (!SITE_ID || !LIST_ID) {
    context.res = {
      status: 500,
      headers: corsHeaders(echoOrigin),
      body: { ok: false, error: "Missing SITE_ID or LIST_ID app settings." },
    };
    return;
  }

  // ── Parse body ──
  const body = req.body || {};
  const a = body.answers ?? body;

  if (!a || typeof a !== "object" || Object.keys(a).length < 3) {
    context.res = {
      status: 400,
      headers: corsHeaders(echoOrigin),
      body: { ok: false, error: "Invalid submission" },
    };
    return;
  }

  const nowIso = new Date().toISOString();
  const clientIp = (req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || "";

  try {
    const token = await getAppToken();

    const fields = {
      Title: `Appt Request - ${toText(a.first_name)} ${toText(a.last_name)} - ${nowIso}`,
      SubmittedAt: nowIso,
      SourcePage: body.sourcePage || "/",
      UserAgent: req.headers?.["user-agent"] || "",
      ClientIP: clientIp,

      FirstName: toText(a.first_name),
      LastName: toText(a.last_name),
      DateOfBirth: toText(a.dob),
      Phone: toText(a.phone),
      Email: toText(a.email),
      StreetAddress: toText(a.street_address),
      City: toText(a.city),
      State: toText(a.state),
      Zip: toText(a.zip),

      PreferredDate: toText(a.preferred_date),
      PreferredTime: toText(a.preferred_time),
      Notes: toText(a.notes),

      Consent: toYesNo(a.consent),
    };

    const url = `${GRAPH_ROOT}/sites/${encodeURIComponent(SITE_ID)}/lists/${encodeURIComponent(LIST_ID)}/items`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = json?.error?.message || `Graph request failed (${res.status})`;
      context.log.error("Graph error:", json);
      context.res = {
        status: 500,
        headers: corsHeaders(echoOrigin),
        body: { ok: false, error: msg },
      };
      return;
    }

    context.res = {
      status: 200,
      headers: corsHeaders(echoOrigin),
      body: { ok: true, id: json?.id || null },
    };
  } catch (err) {
    context.log.error("submit function error:", err);
    context.res = {
      status: 500,
      headers: corsHeaders(echoOrigin),
      body: { ok: false, error: err.message || "Unexpected error" },
    };
  }
};
