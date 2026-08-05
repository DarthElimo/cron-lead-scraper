import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import {
  getAccessToken,
  dedupeKey,
  fetchExistingKeys,
  ensureHeaders,
  appendLeads,
} from "./sheets-helpers.js";

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
  depth: number,
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
          depth: Math.min(depth, 700),
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

async function extractEmail(websiteUrl: string, impressumHtml?: string): Promise<string> {
  // Impressum-HTML wurde bereits geladen → direkt prüfen ohne erneuten Fetch
  if (impressumHtml) {
    const matches = impressumHtml.match(EMAIL_REGEX) ?? [];
    const valid = matches.filter(isValidEmail);
    if (valid.length > 0) return valid[0];
  }

  // Restliche Seiten prüfen (/impressum wurde bereits extern geladen)
  const pathsToCheck = impressumHtml
    ? ["/kontakt", "/contact", "/about", ""]
    : ["/impressum", "/kontakt", "/contact", "/about", ""];

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
// Bewertungs-Filter
//
// Ist maxReviews gesetzt, fliegen alle Betriebe mit MEHR Bewertungen raus.
// Weil dadurch ein Teil der Treffer wegfällt, fragen wir bei DataForSEO
// entsprechend mehr Ergebnisse an (OVERFETCH_FACTOR) und schneiden erst NACH
// dem Filtern auf die gewünschte Anzahl zu — sonst kämen bei einem engen Filter
// deutlich weniger Leads raus als angefordert.
// Einträge ohne Bewertungsdaten gelten als 0 Bewertungen und bleiben drin.
// ---------------------------------------------------------------------------

const OVERFETCH_FACTOR = 3;
const MAX_DEPTH = 700;

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
    maxReviews: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Nur Betriebe mit höchstens so vielen Google-Bewertungen. Leer = kein Filter"),
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
    const { keyword, location, count, emailSearch, maxReviews } = payload;
    const query = `${keyword} ${location}`.trim();
    const today = new Date().toLocaleDateString("de-DE");
    const reviewFilterActive = maxReviews !== undefined;

    console.log(
      `Lead-Scraping gestartet: "${query}" | Ziel: ${count} Leads | E-Mail-Suche: ${emailSearch ? "an" : "aus"}` +
        (reviewFilterActive ? ` | Filter: max. ${maxReviews} Bewertungen` : "")
    );

    const token = await getAccessToken(serviceAccountEmail, privateKey);
    console.log("Google Sheets Authentifizierung erfolgreich.");

    // Bei aktivem Filter mehr anfragen, damit nach dem Aussortieren noch genug übrig bleibt
    const depth = reviewFilterActive ? Math.min(count * OVERFETCH_FACTOR, MAX_DEPTH) : count;

    console.log(`DataForSEO Suche: "${query}" | Angefragt: ${depth} Ergebnisse...`);
    const allResults = await searchDataForSEO(keyword, location, depth, dataForSeoLogin, dataForSeoPassword);
    console.log(`${allResults.length} Firmen gefunden.`);

    let filteredByReviews = 0;
    let candidates = allResults;

    if (reviewFilterActive) {
      candidates = allResults.filter((lead) => (lead.reviews ?? 0) <= maxReviews);
      filteredByReviews = allResults.length - candidates.length;
      console.log(
        `Bewertungs-Filter (max. ${maxReviews}): ${filteredByReviews} aussortiert, ${candidates.length} übrig.`
      );
      if (candidates.length < count) {
        console.log(
          `Hinweis: Nur ${candidates.length} von ${count} gewünschten Leads erfüllen den Filter — die Suche gibt nicht mehr her.`
        );
      }
    }

    const leads = candidates.slice(0, count);
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

      // E-Mail optional von der Website holen. Der Geschäftsführer wird NICHT mehr
      // hier extrahiert, sondern später per LLM im Enrichment (schnellerer Scrape,
      // bessere Namen). Ohne E-Mail-Suche macht der Scrape gar keine Website-Abrufe.
      let email = lead.email ?? "";

      if (website && emailSearch && !email) {
        console.log(`  E-Mail suchen: ${name}`);
        email = await extractEmail(website);
        if (email) console.log(`    → ${email}`);
        await new Promise((r) => setTimeout(r, 400));
      }

      rows.push([name, address, city, website, phone, email, rating, reviewCount, query, today, ""]);
    }

    console.log(`Schreibe ${rows.length} Leads in Google Sheet...`);
    await ensureHeaders(token, spreadsheetId);
    await appendLeads(token, spreadsheetId, rows);

    const withEmail = rows.filter((r) => r[5] !== "").length;
    const withWebsite = rows.filter((r) => r[3] !== "").length;
    const withPhone = rows.filter((r) => r[4] !== "").length;

    console.log(
      `✓ Fertig! ${rows.length} Leads | ${withWebsite} Webseiten | ${withPhone} Telefon | ${withEmail} E-Mails | ${skipped} Duplikate übersprungen` +
        (reviewFilterActive ? ` | ${filteredByReviews} wegen Bewertungsanzahl aussortiert` : "")
    );

    return { total: rows.length, withWebsite, withPhone, withEmail, skipped, filteredByReviews, query };
  },
});
