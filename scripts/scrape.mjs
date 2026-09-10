// Scrapes noisypigeon.com (Pika.page) into raw/*.json for later conversion to
// Jekyll posts. Re-runnable: safe to run again later to pick up new posts.
import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = "https://noisypigeon.com";
const UA = "noisypigeon-blog-migration/1.0 (personal export by site owner)";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, "..", "raw");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  console.log("Fetching homepage...");
  const homeHtml = await fetchHtml(`${BASE}/`);
  const $home = cheerio.load(homeHtml);

  const avatarSrc = $home("header.site-header img.avatar").attr("src");
  const bioHtml = $home("main#main > div.site-page .trix-content").first().html();

  const entries = [];
  $home("ul.t-list-of-posts a.p-name.u-url").each((_, el) => {
    const href = $home(el).attr("href");
    const slug = href.replace(/^\/posts\//, "").replace(/\/$/, "");
    entries.push({ slug, url: `${BASE}${href}` });
  });

  console.log(`Found ${entries.length} posts on homepage.`);
  await writeFile(
    path.join(RAW_DIR, "_home.json"),
    JSON.stringify({ avatarSrc, bioHtml, postCount: entries.length }, null, 2)
  );

  for (const [i, { slug, url }] of entries.entries()) {
    process.stdout.write(`[${i + 1}/${entries.length}] ${slug} ... `);
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const title = $("article.site-post h1.p-name").first().text().trim();
    const datetime = $("article.site-post time.dt-published").first().attr("datetime");
    const description = $('meta[name="description"]').attr("content")?.trim();
    const contentHtml = $("article.site-post .trix-content").first().html();

    if (!title || !datetime || !contentHtml) {
      console.log("MISSING DATA - skipping, inspect manually");
      continue;
    }

    await writeFile(
      path.join(RAW_DIR, `${slug}.json`),
      JSON.stringify({ slug, url, title, datetime, description, contentHtml }, null, 2)
    );
    console.log("ok");
    await sleep(350);
  }

  // Pika "pages" (e.g. /pages/names) aren't posts, so they don't show up in
  // ul.t-list-of-posts and never get scraped above - it's linked from inside many
  // post bodies instead, which is how we found it.
  console.log("Fetching /pages/names ...");
  const namesHtml = await fetchHtml(`${BASE}/pages/names`);
  const $names = cheerio.load(namesHtml);
  await writeFile(
    path.join(RAW_DIR, "_pages_names.json"),
    JSON.stringify(
      {
        title: $names("main h1").first().text().trim(),
        url: `${BASE}/pages/names`,
        contentHtml: $names("main .trix-content").first().html(),
      },
      null,
      2
    )
  );

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
