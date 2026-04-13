import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { createSign } from "crypto";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface LocalResult {
  title?: string;
  address?: string;
  website?: string;
  phone?: string;
  email?: string;
  rating?: number;
  reviews?: number;
}

// ---------------------------------------------------------------------------
// Google Maps Suche via DataForSEO
// ---------------------------------------------------------------------------

async function searchDataForSEO(
  keyword: string,
  location: string,
  count: number,
  login: string,
  password: string
): Promise<LocalResult[]> {
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const query = `${keyword} ${location}`.trim();

  const res = await fetch(
    "https://api.dataforseo.com/v3/serp/google/maps/live/advanced",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          keyword: query,
          location_name: "Germany",
          language_code: "de",
          depth: Math.min(count, 700),
        },
      ]),
    }
  );

  if (!res.ok) {
    throw new Error(`DataForSEO Fehler ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          title?: string;
          address?: string;
          phone?: string;
          domain?: string;
          rating?: { value?: number; votes_count?: number };
        }>;
      }>;
    }>;
  };

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];

  return items.map((item) => ({
    title: item.title,
    address: item.address,
    phone: item.phone,
    website: item.domain ? `https://${item.domain}` : undefined,
    rating: item.rating?.value,
    reviews: item.rating?.votes_count,
  }));
}

// ---------------------------------------------------------------------------
// E-Mail-Extraktion von Unternehmenswebsites (nur wenn emailSearch aktiv)
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const IGNORE_DOMAINS = ["sentry.io", "wixpress.com", "example.com", "yourdomain", "google.com"];
const IGNORE_EXTENSIONS = [".png", ".jpg", ".gif", ".svg", ".webp", ".css", ".js"];

function isValidEmail(email: string): boolean {
  if (IGNORE_EXTENSIONS.some((ext) => email.endsWith(ext))) return false;
  if (IGNORE_DOMAINS.some((d) => email.includes(d))) return false;
  return true;
}

async function extractEmail(websiteUrl: string): Promise<string> {
  const pathsToCheck = ["/impressum", "/kontakt", "/contact", "/about", ""];

  for (const path of pathsToCheck) {
    try {
      const url = new URL(path, websiteUrl).toString();
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) continue;

      const html = await res.text();
      const matches = html.match(EMAIL_REGEX) ?? [];
      const valid = matches.filter(isValidEmail);
      if (valid.length > 0) return valid[0];
    } catch {
      // Seite nicht erreichbar → nächsten Pfad probieren
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return "";
}

// ---------------------------------------------------------------------------
// Google Sheets via REST API
// ---------------------------------------------------------------------------

function createJwt(email: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  ).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

async function getAccessToken(email: string, privateKey: string): Promise<string> {
  const jwt = createJwt(email, privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google Auth Fehler ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

const SHEET_HEADERS = [
  "Name", "Adresse", "Stadt", "Webseite", "Telefon",
  "E-Mail", "Bewertung ★", "Anz. Bewertungen", "Suchanfrage", "Datum",
];

async function ensureHeaders(token: string, spreadsheetId: string): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:J1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as { values?: string[][] };

  if (!data.values || data.values.length === 0) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:J1?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [SHEET_HEADERS] }),
      }
    );
    console.log("Spaltenüberschriften angelegt.");
  }
}

function dedupeKey(name: string, address: string): string {
  return `${name.toLowerCase().trim()}|${address.toLowerCase().trim()}`;
}

async function fetchExistingKeys(token: string, spreadsheetId: string): Promise<Set<string>> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:B`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as { values?: string[][] };
  const keys = new Set<string>();
  for (const row of data.values ?? []) {
    if (row[0]) keys.add(dedupeKey(row[0], row[1] ?? ""));
  }
  return keys;
}

async function appendLeads(
  token: string,
  spreadsheetId: string,
  rows: string[][]
): Promise<void> {
  const maxAttempts = 5;
  let delayMs = 60_000; // start with 60s — the Sheets quota window is 1 minute

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: rows }),
      }
    );

    if (res.ok) return;

    if (res.status === 429 && attempt < maxAttempts) {
      console.log(`Google Sheets Schreib-Limit erreicht (429). Warte ${delayMs / 1000}s, dann Versuch ${attempt + 1}/${maxAttempts}…`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 1.5, 300_000); // cap at 5 minutes
      continue;
    }

    throw new Error(`Google Sheets Fehler ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Haupt-Task
// ---------------------------------------------------------------------------

export const scrapeLeads = schemaTask({
  id: "scrape-leads",
  schema: z.object({
    keyword: z.string().describe("Branche / Suchbegriff, z.B. 'Heizung Sanitär'"),
    location: z.string().describe("Stadt oder Region, z.B. 'Stuttgart'"),
    count: z.number().int().min(1).max(500).default(20).describe("Anzahl gewünschter Leads"),
    emailSearch: z.boolean().default(false).describe("Website nach E-Mail durchsuchen"),
  }),
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000 },
  run: async (payload) => {
    const dataForSeoLogin = process.env.DATAFORSEO_LOGIN;
    if (!dataForSeoLogin) throw new Error("DATAFORSEO_LOGIN ist nicht gesetzt");
    const dataForSeoPassword = process.env.DATAFORSEO_PASSWORD;
    if (!dataForSeoPassword) throw new Error("DATAFORSEO_PASSWORD ist nicht gesetzt");

    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error("GOOGLE_SPREADSHEET_ID ist nicht gesetzt");

    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    if (!serviceAccountEmail) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL ist nicht gesetzt");

    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
    if (!privateKeyRaw) throw new Error("GOOGLE_PRIVATE_KEY ist nicht gesetzt");

    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
    const { keyword, location, count, emailSearch } = payload;
    const query = `${keyword} ${location}`.trim();
    const today = new Date().toLocaleDateString("de-DE");

    console.log(`Lead-Scraping gestartet: "${query}" | Ziel: ${count} Leads | E-Mail-Suche: ${emailSearch ? "an" : "aus"}`);

    const token = await getAccessToken(serviceAccountEmail, privateKey);
    console.log("Google Sheets Authentifizierung erfolgreich.");

    console.log(`DataForSEO Suche: "${query}" | Angefragt: ${count} Ergebnisse...`);
    const allResults = await searchDataForSEO(keyword, location, count, dataForSeoLogin, dataForSeoPassword);
    console.log(`${allResults.length} Firmen gefunden.`);

    const leads = allResults.slice(0, count);
    if (emailSearch && leads.length > 0) console.log("Starte E-Mail-Suche...");

    // Bestehende Einträge (Name + Adresse) aus dem Sheet laden für Duplikat-Prüfung
    const existingKeys = await fetchExistingKeys(token, spreadsheetId);
    console.log(`${existingKeys.size} bestehende Einträge im Sheet geladen.`);

    const rows: string[][] = [];
    let skipped = 0;

    for (const lead of leads) {
      const name = lead.title ?? "";
      const address = lead.address ?? "";
      const key = dedupeKey(name, address);

      // Duplikat-Prüfung: identischer Lead (Name + Adresse) bereits vorhanden
      if (existingKeys.has(key)) {
        console.log(`  Übersprungen (Duplikat): ${name} — ${address}`);
        skipped++;
        continue;
      }
      existingKeys.add(key); // für Duplikate innerhalb des aktuellen Batches

      const city = address.split(",").at(-1)?.trim() ?? "";
      const website = lead.website ?? "";
      const phone = lead.phone ?? "";
      const rating = lead.rating?.toString() ?? "";
      const reviewCount = lead.reviews?.toString() ?? "";

      // E-Mail: direkt aus Google Maps Daten, oder per Website-Scraping wenn emailSearch aktiv
      let email = lead.email ?? "";
      if (!email && emailSearch && website) {
        console.log(`  E-Mail suchen: ${name}`);
        email = await extractEmail(website);
        if (email) console.log(`    → ${email}`);
        await new Promise((r) => setTimeout(r, 400));
      }

      rows.push([name, address, city, website, phone, email, rating, reviewCount, query, today]);
    }

    console.log(`Schreibe ${rows.length} Leads in Google Sheet...`);
    await ensureHeaders(token, spreadsheetId);
    await appendLeads(token, spreadsheetId, rows);

    const withEmail = rows.filter((r) => r[5] !== "").length;
    const withWebsite = rows.filter((r) => r[3] !== "").length;
    const withPhone = rows.filter((r) => r[4] !== "").length;

    console.log(`✓ Fertig! ${rows.length} Leads | ${withWebsite} Webseiten | ${withPhone} Telefon | ${withEmail} E-Mails | ${skipped} Duplikate übersprungen`);

    return { total: rows.length, withWebsite, withPhone, withEmail, skipped, query };
  },
});
