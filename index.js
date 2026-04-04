import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const WEBHOOK_URL = "https://hook.us1.make.com/bs4s6msoa6kc1vvv8hkkih4yomomb1d5";
const STATS_PATH = path.resolve("data", "stats.json");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function main() {
  const jobIds = getJobIdsFromPayload(process.env.CLIENT_PAYLOAD);

  if (jobIds.length === 0) {
    console.log("No job_ids provided in client_payload; exiting.");
    return;
  }

  await fs.mkdir(path.dirname(STATS_PATH), { recursive: true });
  const stats = await loadStats();

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(USER_AGENT);

    for (let i = 0; i < jobIds.length; i += 1) {
      const jobId = String(jobIds[i]).trim();
      if (!jobId) {
        continue;
      }

      const jobUrl = `https://www.linkedin.com/jobs/view/${encodeURIComponent(jobId)}/`;
      const timestamp = new Date().toISOString();

      try {
        const response = await page.goto(jobUrl, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });

        const statusCode = response?.status() ?? 0;
        if (statusCode >= 400) {
          throw new Error(`HTTP ${statusCode}`);
        }

        if (isBlockedUrl(page.url())) {
          throw new Error("blocked");
        }

        const scraped = await extractJob(page);
        const country = parseCountry(scraped.location);

        await postWebhook({
          job_info: {
            title: scraped.title,
            description: scraped.description,
            job_url: jobUrl,
            location: scraped.location,
            workplace_type: scraped.workplace_type,
          },
          company_info: {
            name: scraped.company,
          },
        });

        stats.events.push({
          timestamp,
          job_id: jobId,
          company: scraped.company,
          country,
          workplace_type: scraped.workplace_type,
          success_status: "success",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "scrape_failed";
        await postWebhook({ error: message, job_id: jobId });

        stats.events.push({
          timestamp,
          job_id: jobId,
          company: "Unknown",
          country: "Unknown",
          workplace_type: "Not Specified",
          success_status: "failed",
        });
      }

      stats.generated_at = new Date().toISOString();
      await saveStats(stats);

      if (i < jobIds.length - 1) {
        await sleep(randomBetween(3000, 5000));
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }
}

function getJobIdsFromPayload(rawPayload) {
  if (!rawPayload) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawPayload);
    const payload = parsed?.client_payload ?? parsed;

    if (Array.isArray(payload?.job_ids)) {
      return payload.job_ids
        .map((value) => String(value).trim())
        .filter(Boolean);
    }

    if (typeof payload?.job_ids !== "string") {
      return [];
    }

    return payload.job_ids
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function extractJob(page) {
  await page.waitForSelector("body", { timeout: 15000 });

  const data = await page.evaluate(() => {
    const textFrom = (selectors) => {
      for (const selector of selectors) {
        const value = document.querySelector(selector)?.textContent?.trim();
        if (value) {
          return value;
        }
      }
      return "";
    };

    const title = textFrom([
      "h1.top-card-layout__title",
      "h1.topcard__title",
      "h1[data-test-id='job-title']",
      "h1",
    ]);

    const company = textFrom([
      ".topcard__org-name-link",
      ".topcard__flavor-row a",
      "a[data-tracking-control-name='public_jobs_topcard-org-name']",
    ]);

    const location = textFrom([
      ".topcard__flavor--bullet",
      ".topcard__flavor.topcard__flavor--bullet",
      "span[data-test-id='job-location']",
    ]);

    const description =
      document.querySelector(".show-more-less-html__markup")?.textContent?.trim() ||
      document.querySelector(".description__text")?.textContent?.trim() ||
      document.querySelector("[data-test-id='job-description']")?.textContent?.trim() ||
      "";

    const pageText = document.body?.textContent?.toLowerCase() || "";

    return { title, company, location, description, pageText };
  });

  if (!data.title || !data.company || !data.description) {
    throw new Error("missing_selectors");
  }

  return {
    title: data.title,
    company: data.company,
    description: data.description,
    location: data.location,
    workplace_type: detectWorkplaceType(data.pageText),
  };
}

function detectWorkplaceType(text) {
  if (!text) {
    return "Not Specified";
  }

  if (text.includes("hybrid")) {
    return "Hybrid";
  }

  if (text.includes("on-site") || text.includes("on site") || text.includes("onsite")) {
    return "On-site";
  }

  if (text.includes("remote")) {
    return "Remote";
  }

  return "Not Specified";
}

function parseCountry(location) {
  if (!location) {
    return "Unknown";
  }

  const parts = String(location)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return "Unknown";
  }

  const last = parts[parts.length - 1];
  const normalized = last.toUpperCase();

  if (normalized === "US" || normalized === "USA" || normalized === "UNITED STATES") {
    return "United States";
  }

  if (normalized === "UK" || normalized === "UNITED KINGDOM") {
    return "United Kingdom";
  }

  return last;
}

function isBlockedUrl(currentUrl) {
  return (
    currentUrl.includes("/authwall") ||
    currentUrl.includes("/login") ||
    currentUrl.includes("/checkpoint")
  );
}

async function postWebhook(payload) {
  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`webhook_http_${response.status}`);
  }
}

async function loadStats() {
  try {
    const file = await fs.readFile(STATS_PATH, "utf8");
    const parsed = JSON.parse(file);
    const existingEvents = Array.isArray(parsed.events) ? parsed.events : [];

    return {
      schema_version: 3,
      generated_at: parsed.generated_at || new Date().toISOString(),
      events: existingEvents,
    };
  } catch {
    return {
      schema_version: 3,
      generated_at: new Date().toISOString(),
      events: [],
    };
  }
}

async function saveStats(stats) {
  await fs.writeFile(STATS_PATH, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
