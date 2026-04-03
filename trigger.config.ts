import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_clswnsgaigqpzmwtkeia",
  runtime: "node",
  dirs: ["src/trigger"],
  maxDuration: 300, // 5 Minuten – ausreichend für Lead-Scraping mit E-Mail-Extraktion
});
