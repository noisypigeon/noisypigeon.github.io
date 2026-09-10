// Converts raw/*.json (from scrape.mjs) into Jekyll _posts/*.md with frontmatter,
// downloading every referenced image into assets/images/posts/<slug>/ and rewriting
// <img> src attributes to the local path.
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RAW_DIR = path.join(ROOT, "raw");
const POSTS_DIR = path.join(ROOT, "_posts");
const IMAGES_POSTS_DIR = path.join(ROOT, "assets", "images", "posts");
const IMAGES_SITE_DIR = path.join(ROOT, "assets", "images", "site");
const UA = "noisypigeon-blog-migration/1.0 (personal export by site owner)";

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
turndown.addRule("strikethrough", {
  filter: ["del", "s", "strike"],
  replacement: (content) => `~~${content}~~`,
});
turndown.addRule("figure", {
  filter: "figure",
  replacement: (_content, node) => "\n\n" + node.outerHTML + "\n\n",
});
// Bare <img> not inside a figure - emit as raw HTML too, so width/height/loading survive.
turndown.addRule("img", {
  filter: "img",
  replacement: (_content, node) => node.outerHTML,
});

async function downloadImage(url, destDir, preferredName, used) {
  await mkdir(destDir, { recursive: true });
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} fetching image ${url}`);
  const contentType = res.headers.get("content-type")?.split(";")[0].trim();
  const ext = EXT_BY_MIME[contentType] || "jpg";

  let base = preferredName ? preferredName.replace(/\.[a-zA-Z0-9]+$/, "") : "image";
  base = base.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  let filename = `${base}.${ext}`;
  let i = 2;
  while (used.has(filename)) {
    filename = `${base}-${i}.${ext}`;
    i++;
  }
  used.add(filename);

  const dest = path.join(destDir, filename);
  if (!existsSync(dest)) {
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
  }
  return filename;
}

function fnFromUrl(url) {
  const m = url.match(/fn:([^/]+)/);
  return m ? m[1] : null;
}

async function processImages($, contentHtml, slug, destDir, publicPrefix) {
  const used = new Set();
  // Unwrap Trix action-text-attachment wrappers, keep their inner <figure>.
  $("action-text-attachment").each((_, el) => {
    $(el).replaceWith($(el).html());
  });

  const imgs = $("img").toArray();
  for (const el of imgs) {
    const $img = $(el);
    const src = $img.attr("src");
    if (!src) continue;
    const preferred =
      $img.closest("figure").attr("data-filename") ||
      fnFromUrl(src) ||
      `image-${used.size + 1}`;
    const filename = await downloadImage(src, destDir, preferred, used);
    $img.attr("src", `${publicPrefix}/${filename}`);
    $img.removeAttr("data-zoom-src");
    $img.removeAttr("data-original-src");
    $img.removeAttr("data-controller");
    $img.removeAttr("data-action");
  }
}

// The blog has moved domains twice (pigeon.dev -> pigeon.pika.page -> noisypigeon.com)
// and in-post links to other posts/pages were never updated. Rewrite links to our
// own content on any of those hosts into Jekyll-relative paths; leave everything
// else (e.g. a genuine external link to https://pika.page/) untouched.
const LEGACY_HOSTS = new Set(["noisypigeon.com", "pigeon.pika.page", "pigeon.dev"]);

function rewriteLegacyLinks($) {
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const m = href.match(/^https?:\/\/([^/]+)(\/posts\/[^/?#]+|\/pages\/names)\/?/);
    if (m && LEGACY_HOSTS.has(m[1])) {
      $(el).attr("href", `${m[2]}/`);
    }
  });
}

function cleanHeadings($) {
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).find("a.anchor").remove();
  });
}

function cleanCodeBlocks($) {
  $("code").each((_, el) => {
    const cls = $(el).attr("class");
    if (cls && cls.startsWith("language-")) {
      const lang = cls.replace("language-", "").replace(/-pika-default$/, "");
      if (lang === "plaintext" || lang === "") {
        $(el).removeAttr("class");
      } else {
        $(el).attr("class", `language-${lang}`);
      }
    }
  });
}

function toMarkdown($, root) {
  cleanHeadings($);
  cleanCodeBlocks($);
  rewriteLegacyLinks($);
  const html = $(root).html() ?? "";
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

function frontmatterEscape(str) {
  return (str ?? "").replace(/"/g, '\\"').trim();
}

function toJekyllDate(datetime) {
  // "2025-12-24 23:15:17 UTC" -> "2025-12-24 23:15:17 +0000"
  return datetime.replace(/\s*UTC$/, " +0000");
}

async function buildPost(file) {
  const raw = JSON.parse(await readFile(path.join(RAW_DIR, file), "utf8"));
  const { slug, title, datetime, description, contentHtml, url } = raw;
  const $ = cheerio.load(`<div id="root">${contentHtml}</div>`, null, false);

  const destDir = path.join(IMAGES_POSTS_DIR, slug);
  const publicPrefix = `/assets/images/posts/${slug}`;
  await processImages($, contentHtml, slug, destDir, publicPrefix);

  const body = toMarkdown($, "#root");
  const dateOnly = datetime.slice(0, 10);
  const fm =
    [
      "---",
      `title: "${frontmatterEscape(title)}"`,
      `date: ${toJekyllDate(datetime)}`,
      description ? `description: "${frontmatterEscape(description)}"` : null,
      `original_url: ${url}`,
      "---",
    ]
      .filter(Boolean)
      .join("\n") + "\n\n";

  await mkdir(POSTS_DIR, { recursive: true });
  await writeFile(path.join(POSTS_DIR, `${dateOnly}-${slug}.md`), fm + body + "\n");
}

async function buildHome() {
  const raw = JSON.parse(await readFile(path.join(RAW_DIR, "_home.json"), "utf8"));
  const { avatarSrc, bioHtml } = raw;

  const $ = cheerio.load(`<div id="root">${bioHtml}</div>`, null, false);
  // The year-grouped post list is server-generated by Pika and lives in the same
  // container as the bio text; our home.html layout rebuilds it from site.posts.
  $(".t-list-of-posts").remove();
  await processImages($, bioHtml, "_home", path.join(IMAGES_POSTS_DIR, "_home"), "/assets/images/posts/_home");
  const body = toMarkdown($, "#root");

  await mkdir(IMAGES_SITE_DIR, { recursive: true });
  const used = new Set();
  const avatarFile = await downloadImage(avatarSrc, IMAGES_SITE_DIR, "avatar", used);
  console.log(`Avatar saved as assets/images/site/${avatarFile}`);

  const fm = ["---", "layout: home", "title: Willow Pigeon", "---"].join("\n") + "\n\n";
  await writeFile(path.join(ROOT, "index.md"), fm + body + "\n");

  return avatarFile;
}

async function buildPage(file, permalink) {
  const raw = JSON.parse(await readFile(path.join(RAW_DIR, file), "utf8"));
  const { title, contentHtml, url } = raw;
  const pathSegments = permalink.replace(/^\/|\/$/g, "").split("/"); // e.g. ["pages", "names"]
  const slug = pathSegments.at(-1);
  const $ = cheerio.load(`<div id="root">${contentHtml}</div>`, null, false);

  const imageDirSlug = pathSegments.join("-"); // e.g. "pages-names", keeps image dirs unique per page
  const destDir = path.join(IMAGES_POSTS_DIR, imageDirSlug);
  const publicPrefix = `/assets/images/posts/${imageDirSlug}`;
  await processImages($, contentHtml, imageDirSlug, destDir, publicPrefix);

  const body = toMarkdown($, "#root");
  const fm =
    [
      "---",
      "layout: page",
      `title: "${frontmatterEscape(title)}"`,
      `permalink: ${permalink}`,
      `original_url: ${url}`,
      "---",
    ].join("\n") + "\n\n";

  const pagesDir = path.join(ROOT, "pages");
  await mkdir(pagesDir, { recursive: true });
  await writeFile(path.join(pagesDir, `${slug}.md`), fm + body + "\n");
}

async function main() {
  const files = (await readdir(RAW_DIR)).filter(
    (f) => f.endsWith(".json") && f !== "_home.json" && f !== "_pages_names.json"
  );
  console.log(`Building ${files.length} posts...`);
  for (const [i, file] of files.entries()) {
    process.stdout.write(`[${i + 1}/${files.length}] ${file} ... `);
    await buildPost(file);
    console.log("ok");
  }
  console.log("Building homepage...");
  const avatarFile = await buildHome();
  console.log("Building pages/names.md...");
  await buildPage("_pages_names.json", "/pages/names/");
  console.log("Done.");
  console.log(`\nAvatar file for _includes/header.html: /assets/images/site/${avatarFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
