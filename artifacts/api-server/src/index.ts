import app from "./app";
import { logger } from "./lib/logger";
import { initScheduler } from "./pipeline/queue";
import { ensureGmapsBinary } from "./scraping/gmapsScraper";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  initScheduler();
  // Pre-download the gosom binary in the background so the first
  // Google Maps scrape job doesn't stall on a cold download.
  void ensureGmapsBinary();
});
