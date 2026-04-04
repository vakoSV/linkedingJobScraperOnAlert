import puppeteer from "@cloudflare/puppeteer";
import type { Page } from "@cloudflare/puppeteer";

interface Env {
  MYBROWSER: Fetcher;
}

interface ScrapeRequest {
  job_ids: string[];
}

interface ScrapedJob {
  title: string;
  company: string;
  location: string;
  description: string;
  workplaceType: WorkplaceType;
  category: JobCategory;
}

type WorkplaceType = "Remote" | "Hybrid" | "On-site" | "Not Specified";
type JobCategory = "Automation" | "AI" | "SaaS Ops" | "Other";

const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 5000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAKE_WEBHOOK_URL =
  "https://hook.us1.make.com/bs4s6msoa6kc1vvv8hkkih4yomomb1d5";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/scrape") {
      return new Response("Not Found", { status: 404 });
    }

    let payload: ScrapeRequest;
    try {
      payload = await request.json<ScrapeRequest>();
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    const validationError = validatePayload(payload);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400);
    }

    ctx.waitUntil(processJobs(payload, env));

    return jsonResponse(
      {
        status: "accepted",
        queued_jobs: payload.job_ids.length,
      },
      202,
    );
  },
} satisfies ExportedHandler<Env>;

async function processJobs(payload: ScrapeRequest, env: Env): Promise<void> {
  const browser = await puppeteer.launch(env.MYBROWSER);
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(USER_AGENT);

    for (let i = 0; i < payload.job_ids.length; i += 1) {
      const jobId = payload.job_ids[i];
      const sourceUrl = `https://www.linkedin.com/jobs/view/${encodeURIComponent(jobId)}/`;

      try {
        const response = await page.goto(sourceUrl, {
          waitUntil: "networkidle2",
          timeout: 45000,
        });

        const statusCode = response?.status() ?? 0;
        if (statusCode >= 400) {
          throw new Error(`LinkedIn returned HTTP ${statusCode}`);
        }

        if (isBlockedOrAuthwall(page.url())) {
          throw new Error("Blocked or redirected to login/authwall");
        }

        const scrapedJob = await extractJob(page);

        await postToWebhook(MAKE_WEBHOOK_URL, {
          job_info: {
            title: scrapedJob.title,
            description: scrapedJob.description,
            job_url: sourceUrl,
            location: scrapedJob.location,
            workplace_type: scrapedJob.workplaceType,
            category: scrapedJob.category,
          },
          company_info: {
            name: scrapedJob.company,
          },
        });
      } catch (error) {
        const errorCode = classifyJobError(error);
        await postToWebhook(MAKE_WEBHOOK_URL, {
          error: errorCode,
          job_id: jobId,
        });
      }

      if (i < payload.job_ids.length - 1) {
        await sleep(randomInt(MIN_DELAY_MS, MAX_DELAY_MS));
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }
}

async function extractJob(page: Page): Promise<ScrapedJob> {
  await page.waitForSelector("body", { timeout: 15000 });

  const scraped = await page.evaluate(() => {
    const textFrom = (selectors: string[]): string | null => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const value = node?.textContent?.trim();
        if (value) {
          return value;
        }
      }
      return null;
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
      ".top-card-layout__card .topcard__flavor",
      "a[data-tracking-control-name='public_jobs_topcard-org-name']",
    ]);

    const location = textFrom([
      ".topcard__flavor--bullet",
      ".topcard__flavor.topcard__flavor--bullet",
      ".job-search-card__location",
      "span[data-test-id='job-location']",
    ]);

    const metadataText = textFrom([
      ".description__job-criteria-list",
      ".topcard__flavor-row",
      ".topcard__flavor",
      ".job-criteria__item",
    ]);

    const descriptionElement =
      document.querySelector(".show-more-less-html__markup") ??
      document.querySelector(".description__text") ??
      document.querySelector("[data-test-id='job-description']");

    const description = descriptionElement?.textContent?.trim() ?? null;

    return { title, company, location, description, metadataText };
  });

  if (!scraped.title || !scraped.company || !scraped.description) {
    throw new Error("Missing required selectors");
  }

  return {
    title: scraped.title,
    company: scraped.company,
    location: scraped.location ?? "",
    description: scraped.description,
    workplaceType: detectWorkplaceType(scraped.metadataText, scraped.location, scraped.description),
    category: classifyCategory(scraped.title),
  };
}

async function postToWebhook(webhookUrl: string, payload: unknown): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}`);
  }
}

function validatePayload(payload: ScrapeRequest): string | null {
  if (!payload || typeof payload !== "object") {
    return "Request body must be a JSON object";
  }

  if (!Array.isArray(payload.job_ids) || payload.job_ids.length === 0) {
    return "job_ids must be a non-empty array of strings";
  }

  if (!payload.job_ids.every((id) => typeof id === "string" && id.trim().length > 0)) {
    return "job_ids must contain only non-empty strings";
  }

  return null;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlockedOrAuthwall(currentUrl: string): boolean {
  return (
    currentUrl.includes("/authwall") ||
    currentUrl.includes("/login") ||
    currentUrl.includes("/checkpoint")
  );
}

function classifyJobError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("http 404")) {
    return "not_found";
  }

  if (message.includes("blocked") || message.includes("authwall") || message.includes("login")) {
    return "blocked";
  }

  if (message.includes("selector") || message.includes("missing required")) {
    return "selectors_missing";
  }

  return "scrape_failed";
}

function detectWorkplaceType(...texts: Array<string | null | undefined>): WorkplaceType {
  const joinedText = texts
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (joinedText.includes("hybrid")) {
    return "Hybrid";
  }

  if (joinedText.includes("on-site") || joinedText.includes("onsite") || joinedText.includes("on site")) {
    return "On-site";
  }

  if (joinedText.includes("remote")) {
    return "Remote";
  }

  return "Not Specified";
}

function classifyCategory(title: string): JobCategory {
  const normalizedTitle = title.toLowerCase();

  if (
    normalizedTitle.includes("automation") ||
    normalizedTitle.includes("rpa") ||
    normalizedTitle.includes("workflow")
  ) {
    return "Automation";
  }

  if (
    normalizedTitle.includes("ai") ||
    normalizedTitle.includes("machine learning") ||
    normalizedTitle.includes("ml ") ||
    normalizedTitle.includes("llm") ||
    normalizedTitle.includes("data scientist")
  ) {
    return "AI";
  }

  if (
    normalizedTitle.includes("saas") ||
    normalizedTitle.includes("ops") ||
    normalizedTitle.includes("revenue operations") ||
    normalizedTitle.includes("platform")
  ) {
    return "SaaS Ops";
  }

  return "Other";
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
