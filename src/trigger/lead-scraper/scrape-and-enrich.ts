import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { scrapeLeads } from "./scrape-leads.js";
import { enrichLeads } from "./enrich-leads.js";
import { getAccessToken, countSheetRows } from "./sheets-helpers.js";

// ---------------------------------------------------------------------------
// High-Ticket-SHK: Scrape-+-Klassifikation-Orchestrator
//
// Funktioniert für eine einzelne Suche wie auch für den Bulk-Run:
// 1) Scrapt das volle Kreuzprodukt keywords × locations und schreibt die Leads
//    ins Sheet — wartet, bis alle Scrapes fertig sind.
// 2) Stößt anschließend die Klassifikation an. enrich-leads bewertet nur die
//    noch nicht klassifizierten Zeilen → genau die frisch gescrapten Leads.
// ---------------------------------------------------------------------------

const cleanList = (arr: string[]) => arr.map((s) => s.trim()).filter(Boolean);

export const scrapeAndEnrich = schemaTask({
  id: "scrape-and-enrich",
  maxDuration: 3600,
  schema: z.object({
    keywords: z
      .array(z.string())
      .transform(cleanList)
      .pipe(z.array(z.string().min(1)).min(1).max(50))
      .describe("SHK-Suchbegriffe, z.B. ['Heizungsbau', 'Badsanierung']"),
    locations: z
      .array(z.string())
      .transform(cleanList)
      .pipe(z.array(z.string().min(1)).min(1).max(50))
      .describe("Standorte, z.B. ['Stuttgart', 'München']"),
    count: z.number().int().min(1).max(500).default(20).describe("Leads pro Kombination"),
    emailSearch: z.boolean().default(false).describe("E-Mail-Suche aktivieren"),
    maxReviews: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Nur Betriebe mit höchstens so vielen Google-Bewertungen. Leer = kein Filter"),
  }),
  // No retry — ein erneuter Lauf würde alle Scrapes neu auslösen
  run: async (payload) => {
    const { keywords, locations, count, emailSearch, maxReviews } = payload;

    // Aktuelle Zeilenzahl merken — so klassifizieren wir hinterher NUR die frisch
    // gescrapten Zeilen (werden unten angehängt), nicht den bestehenden Bestand.
    // Lässt sich das nicht sicher ermitteln, wird die Auto-Anreicherung bewusst
    // ÜBERSPRUNGEN (statt versehentlich den ganzen Bestand zu klassifizieren).
    let fromRow: number | undefined;
    try {
      const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const keyRaw = process.env.GOOGLE_PRIVATE_KEY;
      const sheetId = process.env.GOOGLE_SPREADSHEET_ID;
      if (email && keyRaw && sheetId) {
        const token = await getAccessToken(email, keyRaw.replace(/\\n/g, "\n"));
        const existingRows = await countSheetRows(token, sheetId);
        fromRow = Math.max(existingRows + 1, 2); // erste neue Zeile (Header = Zeile 1)
        console.log(`Bestehende Zeilen: ${existingRows} → neue Leads ab Zeile ${fromRow} werden klassifiziert.`);
      } else {
        console.warn("Google-Sheets-Env unvollständig — Auto-Anreicherung wird übersprungen.");
      }
    } catch (err) {
      console.warn("Konnte Startzeile nicht ermitteln — Auto-Anreicherung wird übersprungen (enrich-leads bitte manuell starten).", err);
    }

    // Volles Kreuzprodukt: jedes Keyword × jeder Standort
    const items = keywords.flatMap((keyword) =>
      locations.map((location) => ({
        payload: { keyword, location, count, emailSearch, maxReviews },
      }))
    );

    console.log(
      `High-Ticket-Scrape: ${keywords.length} SHK-Begriffe × ${locations.length} Standorte = ${items.length} Kombinationen` +
        (maxReviews !== undefined ? ` | Filter: max. ${maxReviews} Bewertungen` : "") +
        " — warte auf Abschluss…"
    );

    // batchTriggerAndWait erlaubt max. 500 Items pro Aufruf → in Blöcken abarbeiten
    // (sequenziell, NICHT in Promise.all wickeln).
    const CHUNK_SIZE = 500;
    let succeeded = 0;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const batch = await scrapeLeads.batchTriggerAndWait(chunk);
      const runs: Array<{ ok: boolean }> =
        (batch as { runs?: Array<{ ok: boolean }> }).runs ?? (batch as unknown as Array<{ ok: boolean }>);
      for (const run of runs) if (run.ok) succeeded++;
    }
    console.log(`Scrapes abgeschlossen: ${succeeded}/${items.length} erfolgreich. Starte Klassifikation…`);

    // Klassifikation NUR der frisch gescrapten Zeilen anstoßen (fromRow). Ohne
    // sichere Startzeile NICHT automatisch anreichern, um den Bestand zu schützen.
    let enrichmentTriggered = false;
    if (fromRow) {
      await enrichLeads.trigger({ force: false, fromRow });
      enrichmentTriggered = true;
    } else {
      console.warn("Keine Startzeile bekannt — bitte enrich-leads bei Bedarf manuell starten.");
    }

    return {
      keywords: keywords.length,
      locations: locations.length,
      combinations: items.length,
      scrapesSucceeded: succeeded,
      scrapesTotal: items.length,
      maxReviews: maxReviews ?? null,
      enrichmentTriggered,
    };
  },
});
