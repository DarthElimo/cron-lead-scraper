import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import {
  getAccessToken,
  ensureHeaders,
  fetchRowsForEnrichment,
  writeEnrichment,
  COL_WEBSITE,
  COL_OWNER,
  COL_HIGH_TICKET,
  COL_BUSINESS_TYPE,
  type EnrichmentUpdate,
} from "./sheets-helpers.js";
import { fetchLeadContent, classifyLead } from "./high-ticket-classifier.js";

// ---------------------------------------------------------------------------
// Enrichment-Task: läuft über die Sheet-Zeilen und klassifiziert High-Ticket?
//
// Idempotent: Standardmäßig werden nur Zeilen OHNE High-Ticket?-Wert klassifiziert
// (force=true klassifiziert alles neu). Ergebnisse werden in Schüben geschrieben,
// damit bei einem Timeout der Fortschritt erhalten bleibt und ein erneuter Lauf
// dort weitermacht.
// ---------------------------------------------------------------------------

const FLUSH_EVERY = 20;

export const enrichLeads = schemaTask({
  id: "enrich-leads",
  maxDuration: 3600,
  schema: z.object({
    force: z.boolean().default(false).describe("Auch bereits klassifizierte Zeilen neu bewerten"),
    limit: z.number().int().min(1).max(2000).optional().describe("Max. Anzahl Zeilen pro Lauf"),
    fromRow: z.number().int().min(2).optional().describe("Nur Zeilen ab dieser Sheet-Zeilennummer (z.B. nur frisch gescrapte)"),
  }),
  // No retry — ein Neustart würde dank Idempotenz ohnehin bei den offenen Zeilen ansetzen
  run: async (payload) => {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error("GOOGLE_SPREADSHEET_ID ist nicht gesetzt");

    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    if (!serviceAccountEmail) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL ist nicht gesetzt");

    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
    if (!privateKeyRaw) throw new Error("GOOGLE_PRIVATE_KEY ist nicht gesetzt");

    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

    // Groq ist optional: ohne Key läuft die Klassifikation rein keyword-basiert.
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      console.log("Hinweis: GROQ_API_KEY nicht gesetzt — Klassifikation läuft rein keyword-basiert (Grenzfälle ohne LLM).");
    }

    console.log("Google Sheets Authentifizierung…");
    const token = await getAccessToken(serviceAccountEmail, privateKey);
    await ensureHeaders(token, spreadsheetId);

    const allRows = await fetchRowsForEnrichment(token, spreadsheetId);

    // Kandidaten: optional erst ab fromRow (z.B. nur frisch gescrapte Zeilen),
    // Webseite vorhanden und (force ODER High-Ticket? noch leer)
    const candidates = allRows.filter((row) => {
      if (payload.fromRow && row.rowNumber < payload.fromRow) return false;
      const website = (row.values[COL_WEBSITE] ?? "").trim();
      if (!website) return false;
      const already = (row.values[COL_HIGH_TICKET] ?? "").trim();
      return payload.force || already === "";
    });

    const todo = payload.limit ? candidates.slice(0, payload.limit) : candidates;
    console.log(`${allRows.length} Datenzeilen | ${candidates.length} zu klassifizieren${payload.fromRow ? ` (ab Zeile ${payload.fromRow})` : ""}${payload.limit ? ` (Limit ${payload.limit})` : ""}.`);

    const counts = { JA: 0, NEIN: 0, Unklar: 0 };
    let pending: EnrichmentUpdate[] = [];
    let written = 0;

    // Pacing zwischen Leads: mit Groq ~2s (passt zum ~30/Min-Free-Limit, vermeidet
    // 429-Stürme); ohne Groq nur kurze Höflichkeitspause für die Ziel-Websites.
    const paceMs = groqKey ? 2000 : 300;

    for (const row of todo) {
      const website = (row.values[COL_WEBSITE] ?? "").trim();
      const name = row.values[0] ?? "";
      const existingOwner = (row.values[COL_OWNER] ?? "").trim();
      const existingBusinessType = (row.values[COL_BUSINESS_TYPE] ?? "").trim();

      // Leistungs- und Impressum-Text in einem Durchgang holen (Homepage nur 1×)
      const { servicesText, impressumText } = await fetchLeadContent(website);
      const cls = await classifyLead(servicesText, impressumText, groqKey);

      // Inhaber + Betriebsart: neues Ergebnis bevorzugen, sonst bestehenden Wert behalten
      const owner = cls.owner || existingOwner;
      const businessType = cls.businessType || existingBusinessType;

      counts[cls.label]++;
      console.log(`  ${cls.label} (${cls.confidence}) — ${name}${owner ? ` · ${owner}` : ""}${businessType ? ` · ${businessType}` : ""}${cls.services ? ` [${cls.services}]` : ""}`);

      pending.push({
        rowNumber: row.rowNumber,
        owner,
        label: cls.label,
        confidence: cls.confidence,
        services: cls.services,
        businessType,
      });

      if (pending.length >= FLUSH_EVERY) {
        await writeEnrichment(token, spreadsheetId, pending);
        written += pending.length;
        pending = [];
      }

      await new Promise((r) => setTimeout(r, paceMs));
    }

    if (pending.length > 0) {
      await writeEnrichment(token, spreadsheetId, pending);
      written += pending.length;
    }

    console.log(`✓ Fertig! ${written} Zeilen klassifiziert — JA: ${counts.JA} | NEIN: ${counts.NEIN} | Unklar: ${counts.Unklar}`);

    return {
      classified: written,
      ja: counts.JA,
      nein: counts.NEIN,
      unklar: counts.Unklar,
      totalCandidates: candidates.length,
    };
  },
});
