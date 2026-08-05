import { fetchSiteText, fetchImpressumText, classifyLead } from "./src/trigger/lead-scraper/high-ticket-classifier.ts";
const key = process.env.GROQ_API_KEY;
const url = "https://www.christian-sonnenberg.de/";
const text = await fetchSiteText(url);
const imp = await fetchImpressumText(url);
console.log(`Website-Text: ${text.length} Zeichen | Impressum: ${imp.length} Zeichen`);
const cls = await classifyLead(text, imp, key);
console.log("ERGEBNIS:", JSON.stringify(cls));
