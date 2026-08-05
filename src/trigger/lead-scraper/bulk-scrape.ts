import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { scrapeLeads } from "./scrape-leads.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const bulkScrapeSchema = z.object({
  keywords: z
    .array(z.string())
    .transform((arr) => arr.map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1)).min(1).max(50))
    .describe("Liste der Branchen"),
  locations: z
    .array(z.string())
    .transform((arr) => arr.map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1)).min(1).max(50))
    .describe("Liste der Standorte"),
  count: z.number().int().min(1).max(500).default(20).describe("Leads pro Kombination"),
  emailSearch: z.boolean().default(false).describe("E-Mail-Suche aktivieren"),
  maxReviews: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Nur Betriebe mit höchstens so vielen Google-Bewertungen. Leer = kein Filter"),
});

// ---------------------------------------------------------------------------
// Bulk-Scraping-Task (Orchestrator)
// ---------------------------------------------------------------------------

export const bulkScrape = schemaTask({
  id: "bulk-scrape",
  maxDuration: 60,
  schema: bulkScrapeSchema,
  // No retry — retrying the orchestrator would re-dispatch all combinations
  run: async (payload) => {
    const { keywords, locations, count, emailSearch, maxReviews } = payload;

    // Build the full Cartesian product: every keyword × every location
    const items = keywords.flatMap((keyword) =>
      locations.map((location) => ({
        payload: { keyword, location, count, emailSearch, maxReviews },
      }))
    );

    console.log(
      `Bulk-Scraping: ${keywords.length} Branchen × ${locations.length} Standorte = ${items.length} Kombinationen` +
        (maxReviews !== undefined ? ` | Filter: max. ${maxReviews} Bewertungen` : "")
    );

    // batchTrigger supports up to 500 items per call — chunk if needed
    const CHUNK_SIZE = 500;
    let dispatched = 0;
    let failedChunks = 0;

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
      try {
        await scrapeLeads.batchTrigger(chunk);
        dispatched += chunk.length;
        console.log(`Chunk ${chunkIndex}: ${chunk.length} Runs gestartet`);
      } catch (err) {
        failedChunks++;
        console.error(`Chunk ${chunkIndex} fehlgeschlagen:`, err);
      }
    }

    console.log(`✓ Fertig! ${dispatched}/${items.length} Runs dispatched. Fehlgeschlagene Chunks: ${failedChunks}`);

    return {
      totalCombinations: items.length,
      dispatched,
      failedChunks,
      count,
      emailSearch,
      maxReviews: maxReviews ?? null,
    };
  },
});
