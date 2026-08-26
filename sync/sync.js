/* YHD NYE — Notion → static HTML sync
 *
 * Pulls the Notion page (blocks) and child databases via the official API
 * and renders them into /out/index.html using the site's existing CSS/JS.
 *
 * Synced:  text blocks, headings, lists, toggles, columns, colors,
 *          databases (rows + select/status option colors), and images/PDFs
 *          (downloaded from Notion's own URLs, HEIC auto-converted to JPEG,
 *          cached in /out/media keyed by block id + last_edited_time).
 * The page's own cover (assets/titleimage.jpg) and 🎆 icon are a deliberate
 * fixed override, not sourced from Notion's actual page cover/icon.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = process.env.NOTION_PAGE_ID;
const INTERVAL = Math.max(60, parseInt(process.env.SYNC_INTERVAL || "300", 10));
const RUN_ONCE = process.env.RUN_ONCE === "1";
const OUT_DIR = process.env.OUT_DIR || "/out";

if (!TOKEN || !PAGE_ID) {
  console.error("NOTION_TOKEN and NOTION_PAGE_ID are required");
  process.exit(1);
}

/* ---------------- Notion API ---------------- */

const API = "https://api.notion.com/v1";
const HEADERS = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, options = {}, attempt = 0) {
  await sleep(120); // stay well under the 3 req/s limit
  const res = await fetch(API + pathname, { headers: HEADERS, ...options });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`Notion API ${res.status} after retries: ${pathname}`);
    const wait = parseFloat(res.headers.get("retry-after") || "2") * 1000;
    await sleep(wait + 500 * attempt);
    return api(pathname, options, attempt + 1);
  }
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${pathname} ${await res.text()}`);
  return res.json();
}

async function fetchChildren(blockId) {
  const blocks = [];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const data = await api(`/blocks/${blockId}/children${q}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  for (const b of blocks) {
    if (b.has_children && b.type !== "child_database" && b.type !== "child_page") {
      b.children = await fetchChildren(b.id);
    }
  }
  return blocks;
}

async function fetchDatabase(dbId) {
  const schema = await api(`/databases/${dbId}`);
  const rows = [];
  let cursor;
  do {
    /* the API does not expose view order; created_time ascending reproduces
       the order rows were added in, which matches the visible table */
    const body = {
      page_size: 100,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const data = await api(`/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  sortRows(schema, rows);
  return { schema, rows };
}

/* Manual drag order of Notion views is not exposed by the API. Approximate:
   1. explicit order column "#" / "Poradie" (number) if the editor adds one
   2. "Gruppe" number column (matches the Silvester table layout)
   3. created_time (rows are queried in that order already)
   Sorts are stable, so created_time stays the tiebreaker. */
function sortRows(schema, rows) {
  const findCol = (names) =>
    Object.entries(schema.properties || {}).find(
      ([name, def]) =>
        (def.type === "number" || def.type === "select") &&
        names.includes(name.toLowerCase())
    )?.[0];
  const orderCol = findCol(["#", "poradie", "order"]) || findCol(["gruppe"]);
  if (!orderCol) return;
  const val = (row) => {
    const prop = row.properties[orderCol];
    const raw = prop?.type === "select" ? parseFloat(prop.select?.name) : prop?.number;
    return raw == null || Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
  };
  rows.sort((a, b) => val(a) - val(b));
}

/* ---------------- media: downloaded straight from Notion ---------------- */
/* Image/file blocks give a temporary, presigned Notion-hosted URL. Each sync
   downloads it into /out/media, converting HEIC to JPEG (browsers can't
   render HEIC). A small manifest keyed by block id + its last_edited_time
   skips re-downloading unchanged files on later syncs. */

const heicConvert = require("heic-convert");

const MEDIA_DIR = () => path.join(OUT_DIR, "media");
const MEDIA_CACHE_FILE = () => path.join(OUT_DIR, ".media-cache.json");
let mediaCache = {};

function loadMediaCache() {
  try { mediaCache = JSON.parse(fs.readFileSync(MEDIA_CACHE_FILE(), "utf-8")); }
  catch { mediaCache = {}; }
}
function saveMediaCache() {
  try { fs.writeFileSync(MEDIA_CACHE_FILE(), JSON.stringify(mediaCache)); }
  catch { /* cache is best-effort; ignore write failures */ }
}

function sanitizeFilename(name) {
  return name.normalize("NFKD").replace(/[^\w.\- ]/g, "").replace(/\s+/g, "_").slice(0, 120) || "file";
}

function isHeic(buf) {
  if (buf.length < 12 || buf.readUInt32BE(4) !== 0x66747970) return false; // "ftyp"
  const brand = buf.toString("ascii", 8, 12);
  return ["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(brand);
}

const EXT_BY_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "image/svg+xml": "svg", "application/pdf": "pdf",
};

function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

/* read pixel dimensions straight from a JPEG/PNG buffer (avoids layout shift) */
function imageDims(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG IHDR
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) { // JPEG
      let off = 2;
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
  } catch { /* unreadable header — fall back to no dimensions */ }
  return null;
}

function fmtSize(bytes) {
  const kb = bytes / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb.toFixed(1)}KB`;
}

/* Downloads (or reuses the cached copy of) one image/file block's media.
   Returns { file, size, dims } where `file` is the filename under media/,
   or null if the block has no usable media. */
async function downloadMedia(block, kind) {
  const data = block[block.type];
  const src = data?.[data.type];
  const url = src?.url;
  if (!url) return null;

  const cacheKey = block.id;
  const cached = mediaCache[cacheKey];
  if (cached && cached.editedTime === block.last_edited_time) {
    const p = path.join(MEDIA_DIR(), cached.file);
    if (fs.existsSync(p)) return cached;
  }

  try {
    const res = await fetchWithTimeout(url, 20000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();

    let ext = extFromUrl(url) || EXT_BY_MIME[mime] || (kind === "image" ? "jpg" : "bin");
    if (kind === "image" && (ext === "heic" || isHeic(buf))) {
      buf = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.85 });
      ext = "jpg";
    }

    const baseName = kind === "file"
      ? sanitizeFilename((data.name || extFromUrl(url) ? decodeURIComponent(new URL(url).pathname.split("/").pop()) : block.id).replace(/\.[a-z0-9]+$/i, ""))
      : `img-${block.id.replace(/-/g, "")}`;
    const file = `${baseName}.${ext}`;

    fs.mkdirSync(MEDIA_DIR(), { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR(), file), buf);

    const entry = {
      editedTime: block.last_edited_time,
      file,
      size: fmtSize(buf.length),
      dims: kind === "image" ? imageDims(buf) : null,
    };
    mediaCache[cacheKey] = entry;
    return entry;
  } catch (e) {
    console.error(`  ! media download failed for block ${block.id}: ${e.message}`);
    return cached || null;
  }
}

/* ---------------- bookmark metadata ---------------- */
/* Titles/descriptions are fetched at build time only; nothing external is
   embedded, so the visitor's browser never contacts other hosts. */

const BOOKMARK_CACHE_FILE = () => path.join(OUT_DIR, ".bookmark-cache.json");
const BOOKMARK_TTL = 7 * 24 * 3600 * 1000;
let bookmarkCache = {};

function loadBookmarkCache() {
  try { bookmarkCache = JSON.parse(fs.readFileSync(BOOKMARK_CACHE_FILE(), "utf-8")); }
  catch { bookmarkCache = {}; }
}
function saveBookmarkCache() {
  try { fs.writeFileSync(BOOKMARK_CACHE_FILE(), JSON.stringify(bookmarkCache)); }
  catch { /* cache is best-effort; ignore write failures */ }
}

const UA_SIMPLE = "Mozilla/5.0 (compatible; YHD-sync/1.0)";
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, ms, ua = UA_SIMPLE) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
      },
    });
  } finally { clearTimeout(t); }
}

function metaTag(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

async function bookmarkMeta(url) {
  const cached = bookmarkCache[url];
  if (cached && Date.now() - cached.ts < BOOKMARK_TTL) return cached.meta;
  /* some sites serve bots fine but block fake browsers, others the reverse —
     try the simple UA first, then a browser UA for what is still missing */
  const meta = await fetchMeta(url, UA_SIMPLE);
  if (!meta.title) {
    const alt = await fetchMeta(url, UA_BROWSER);
    meta.title = meta.title || alt.title;
    meta.desc = meta.desc || alt.desc;
  }
  /* decode HTML entities commonly found in meta content */
  for (const k of ["title", "desc"]) {
    if (meta[k]) meta[k] = meta[k]
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
  }
  bookmarkCache[url] = { ts: Date.now(), meta };
  return meta;
}

async function fetchMeta(url, ua) {
  const meta = { title: null, desc: null, image: null, favicon: null };
  try {
    const res = await fetchWithTimeout(url, 10000, ua);
    if (res.ok && (res.headers.get("content-type") || "").includes("html")) {
      const html = (await res.text()).slice(0, 300000);
      const attr = (name) => [
        new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"),
      ];
      meta.title = metaTag(html, attr("og:title")) ||
        metaTag(html, [/<title[^>]*>([^<]+)<\/title>/i]);
      meta.desc = metaTag(html, attr("og:description")) || metaTag(html, attr("description"));
    }
  } catch (e) {
    console.error(`  ! bookmark preview failed for ${url} (${ua === UA_SIMPLE ? "simple" : "browser"} UA): ${e.message}`);
  }
  return meta;
}

/* ---------------- HTML helpers ---------------- */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Notion API color name → site CSS class. "green" is Notion's teal. */
function textColorClass(color) {
  if (!color || color === "default") return "";
  if (color.endsWith("_background")) return `c-${color.replace("_background", "")}-bg`;
  return `c-${color}`;
}

function renderRichText(rts = []) {
  return rts.map((rt) => {
    let text = esc(rt.plain_text);
    if (!text) return "";
    const a = rt.annotations || {};
    if (a.code) text = `<code>${text}</code>`;
    if (a.bold) text = `<b>${text}</b>`;
    if (a.italic) text = `<i>${text}</i>`;
    if (a.strikethrough) text = `<s>${text}</s>`;
    if (a.underline) text = `<span class="u-line">${text}</span>`;
    const cls = textColorClass(a.color);
    if (cls) {
      text = cls.endsWith("-bg")
        ? `<mark class="${cls}">${text}</mark>`
        : `<span class="${cls}">${text}</span>`;
    }
    const href = rt.href;
    if (href) {
      const external = /^https?:/i.test(href) && !href.includes("notion.");
      const mention = rt.type === "mention";
      text = `<a href="${esc(href)}"${external ? ' target="_blank"' : ""}${mention ? ' class="mention"' : ""}>${text}</a>`;
    }
    return text;
  }).join("");
}

const plain = (rts = []) => rts.map((r) => r.plain_text).join("");

/* ---------------- database → table ---------------- */

function cellHtml(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
    case "rich_text": {
      const t = renderRichText(prop[prop.type]);
      return t;
    }
    case "number":
      return prop.number == null ? "" : esc(String(prop.number));
    case "checkbox":
      return `<span class="cb${prop.checkbox ? " on" : ""}"></span>`;
    case "select":
      return prop.select ? tagHtml(prop.select) : "";
    case "status":
      return prop.status ? tagHtml(prop.status) : "";
    case "multi_select":
      return (prop.multi_select || []).map(tagHtml).join(" ");
    case "date":
      return prop.date ? esc(prop.date.start + (prop.date.end ? ` → ${prop.date.end}` : "")) : "";
    case "url":
      return prop.url ? `<a href="${esc(prop.url)}" target="_blank">${esc(prop.url)}</a>` : "";
    case "email":
      return prop.email ? esc(prop.email) : "";
    case "phone_number":
      return prop.phone_number ? esc(prop.phone_number) : "";
    case "formula": {
      const f = prop.formula;
      if (!f) return "";
      if (f.type === "string") return esc(f.string ?? "");
      if (f.type === "number") return f.number == null ? "" : esc(String(f.number));
      if (f.type === "boolean") return `<span class="cb${f.boolean ? " on" : ""}"></span>`;
      return "";
    }
    case "people":
      return (prop.people || []).map((p) => esc(p.name || "")).join(", ");
    default:
      return "";
  }
}

/* option: {name, color} — Notion select colors, synced */
function tagHtml(option) {
  const color = option.color && option.color !== "default" ? option.color : "default";
  return `<span class="tag n-${esc(color)}">${esc(option.name)}</span>`;
}

/* the API does not expose view column order either — order columns by the
   known page layout; unknown columns keep API order at the end */
const COLUMN_ORDER = [
  "Vorame Nachname", "Name", "Arbeitsplatz", "Arbeitskleidung", "Gruppe",
  "Lebenslauf", "Checkliste", "AHV", "Krankenversicherung", "Personalstammbogen",
  "Schulbescheinigung", "GDPR", "Hinfahrt", "€ Hinfahrt", "Fahrtkosten ->",
  "Rückfahrt", "€ Rückfahrt", "Fahrtkosten <-", "€ Fahrtkosten", "Notizen",
  "Hotelzimmer", "YHD Zimmer", "Wäscherei", "Arbeitsverträge",
];

function columnSortKey(name, type, apiIndex) {
  if (type === "title") return [0, 0, 0];
  const known = COLUMN_ORDER.indexOf(name);
  if (known >= 0) return [1, known, 0];
  /* date-named columns like "27.12." / "01.01." — chronological across NY */
  const m = name.match(/^(\d{1,2})\.(\d{1,2})\.$/);
  if (m) {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10);
    return [2, month < 6 ? month + 12 : month, day];
  }
  return [3, apiIndex, 0];
}

function renderDatabaseTable(title, db) {
  const props = Object.entries(db.schema.properties || {});
  const keyed = props.map(([name, def], i) => ({ name, key: columnSortKey(name, def.type, i) }));
  keyed.sort((a, b) =>
    a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  const names = keyed.map((k) => k.name);

  let html = `<details class="toggle" open>\n<summary><span class="tri"><svg viewBox="0 0 12 12"><path d="M3 1.5l6 4.5-6 4.5z"/></svg></span><span class="db-title">📊 ${esc(title)}</span></summary>\n<div class="toggle-body">\n<div class="db-scroll"><table class="ndb"><thead><tr>`;
  html += names.map((n) => `<th>${esc(n)}</th>`).join("");
  html += `</tr></thead><tbody>`;
  for (const row of db.rows) {
    html += "<tr>";
    for (const name of names) {
      const cell = cellHtml(row.properties[name]);
      const cls = cell.includes('class="tag') ? ' class="tags"' : "";
      html += `<td${cls}>${cell}</td>`;
    }
    html += "</tr>";
  }
  html += `</tbody></table></div>\n</div>\n</details>\n`;
  return html;
}

/* ---------------- blocks → HTML ---------------- */

async function renderBlocks(blocks, ctx) {
  let html = "";
  let list = null; // {tag, items}

  const flush = () => {
    if (list) {
      html += `<${list.tag} class="nlist">\n${list.items.join("\n")}\n</${list.tag}>\n`;
      list = null;
    }
  };

  for (const b of blocks) {
    const t = b.type;

    if (t === "bulleted_list_item" || t === "numbered_list_item") {
      const tag = t === "bulleted_list_item" ? "ul" : "ol";
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
      const data = b[t];
      const cls = textColorClass(data.color);
      let li = `<li${cls ? ` class="${cls}"` : ""}>${renderRichText(data.rich_text)}`;
      if (b.children && b.children.length) {
        li += `\n<div class="children">\n${await renderBlocks(b.children, ctx)}</div>`;
      }
      li += "</li>";
      list.items.push(li);
      continue;
    }
    flush();

    switch (t) {
      case "paragraph": {
        const cls = textColorClass(b.paragraph.color);
        html += `<p${cls ? ` class="${cls}"` : ""}>${renderRichText(b.paragraph.rich_text)}</p>\n`;
        if (b.children && b.children.length) {
          html += `<div class="children">\n${await renderBlocks(b.children, ctx)}</div>\n`;
        }
        break;
      }
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        const level = { heading_1: "h2", heading_2: "h3", heading_3: "h4" }[t];
        const data = b[t];
        const cls = textColorClass(data.color);
        html += `<${level}${cls ? ` class="${cls}"` : ""}>${renderRichText(data.rich_text)}</${level}>\n`;
        break;
      }
      case "toggle": {
        html += `<details class="toggle">\n<summary><span class="tri"><svg viewBox="0 0 12 12"><path d="M3 1.5l6 4.5-6 4.5z"/></svg></span><span>${renderRichText(b.toggle.rich_text)}</span></summary>\n<div class="toggle-body">\n`;
        if (b.children) html += await renderBlocks(b.children, ctx);
        html += `</div>\n</details>\n`;
        break;
      }
      case "column_list": {
        html += `<div class="col-list">\n`;
        for (const col of b.children || []) {
          html += `<div class="col">\n${await renderBlocks(col.children || [], { ...ctx, inColumn: true })}</div>\n`;
        }
        html += `</div>\n`;
        break;
      }
      case "image": {
        const media = await downloadMedia(b, "image");
        if (media) {
          const sizeCls = ctx.inColumn ? "" : " medium";
          const dimAttrs = media.dims ? ` width="${media.dims.w}" height="${media.dims.h}"` : "";
          html += `<figure class="nimg${sizeCls}"><img loading="lazy"${dimAttrs} src="media/${encodeURIComponent(media.file)}" alt="${esc(plain(b.image.caption) || "obrázok")}"></figure>\n`;
        }
        break;
      }
      case "file":
      case "pdf": {
        const data = b[t];
        const media = await downloadMedia(b, "file");
        if (media) {
          const name = data.name || media.file;
          html += `<a class="fileblock" href="media/${encodeURIComponent(media.file)}" target="_blank">📎 <span class="fname">${esc(name)}</span> <span class="fsize">${media.size}</span></a>\n`;
        }
        break;
      }
      case "bookmark":
      case "embed": {
        const data = b[t];
        const url = data.url;
        if (!url) break;
        const caption = plain(data.caption);
        let host = url;
        try { host = new URL(url).hostname; } catch { /* keep raw url as host */ }
        const meta = await bookmarkMeta(url);
        const title = caption || meta.title || host;
        const desc = meta.desc || host;
        html += `<a class="bookmark" href="${esc(url)}" target="_blank"><div class="bm-text"><div class="bm-title">${esc(title)}</div><div class="bm-desc">${esc(desc)}</div><div class="bm-url"><span class="fav">🔗</span>${esc(url)}</div></div></a>\n`;
        break;
      }
      case "child_database": {
        const title = b.child_database.title || "Databáza";
        try {
          const db = await fetchDatabase(b.id);
          html += renderDatabaseTable(title, db);
        } catch (e) {
          console.error(`  ! database "${title}" failed: ${e.message}`);
        }
        break;
      }
      case "divider":
        html += `<hr class="ndivider">\n`;
        break;
      case "quote": {
        const cls = textColorClass(b.quote.color);
        html += `<blockquote class="nquote${cls ? ` ${cls}` : ""}">${renderRichText(b.quote.rich_text)}</blockquote>\n`;
        if (b.children) html += await renderBlocks(b.children, ctx);
        break;
      }
      case "callout": {
        const icon = b.callout.icon?.emoji || "💡";
        const cls = textColorClass(b.callout.color) || "c-gray-bg";
        html += `<div class="ncallout ${cls}"><span>${icon}</span><div>${renderRichText(b.callout.rich_text)}`;
        if (b.children) html += await renderBlocks(b.children, ctx);
        html += `</div></div>\n`;
        break;
      }
      case "link_to_page": {
        const pid = b.link_to_page?.page_id;
        if (pid) html += `<p><a class="mention" href="https://www.notion.so/${pid.replace(/-/g, "")}" target="_blank">📄 Odkaz na stránku</a></p>\n`;
        break;
      }
      case "child_page":
        html += `<p><a class="mention" href="https://www.notion.so/${b.id.replace(/-/g, "")}" target="_blank">📄 ${esc(b.child_page.title)}</a></p>\n`;
        break;
      /* media & unsupported types: intentionally skipped (no media sync) */
      case "video":
      case "audio":
      case "unsupported":
      default:
        break;
    }
  }
  flush();
  return html;
}

/* ---------------- page shell ---------------- */

function shell({ title, edited, content }) {
  const v = Math.floor(Date.now() / 1000); // cache-buster for css/js
  return `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎆</text></svg>">
<link rel="stylesheet" href="css/notion.css?v=${v}">
<script src="js/boot.js?v=${v}"></script>
<script src="js/app.js?v=${v}" defer></script>
</head>
<body>

<div id="welcome" aria-hidden="true">
  <span class="w-icon">🎆</span>
  <span class="w-title">${esc(title)}</span>
  <span class="w-sub">Yachthafenrezidenz Höhe Düne</span>
  <span class="w-sub w-sub2">Silvester 2026/2027</span>
</div>

<div id="progress"></div>

<div class="topbar">
  <div class="crumb"><span>🎆</span><span>${esc(title)}</span></div>
  <div class="right">
    <span class="edited">Edited ${esc(edited)}</span>
    <button id="theme-toggle" aria-label="Prepnúť svetlú/tmavú tému" title="Svetlá / tmavá téma">
      <span class="tt-knob">
        <svg class="tt-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <svg class="tt-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="#d99c22" stroke-width="2" stroke-linecap="round"/></svg>
      </span>
    </button>
  </div>
</div>

<div class="page-cover"><img src="assets/titleimage.jpg" alt="cover"></div>

<div class="page">
  <div class="page-icon with-cover">🎆</div>
  <h1 class="page-title">${esc(title)}</h1>

${content}
</div>

<div id="toc">
  <div id="toc-hint">Rýchla navigácia sekcií</div>
  <div id="toc-panel"></div>
  <div id="toc-btn" title="Sekcie" role="button" aria-label="Navigácia sekcií">
    <svg viewBox="0 0 20 20"><path d="M3 4.5h14v1.8H3zM3 9.1h14v1.8H3zM3 13.7h14v1.8H3z"/></svg>
  </div>
</div>

<div id="toast" role="status" aria-live="polite"></div>

<div id="lightbox"><img alt=""></div>

</body>
</html>
`;
}

/* ---------------- main ---------------- */

async function syncOnce() {
  const started = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR(), { recursive: true });
  loadBookmarkCache();
  loadMediaCache();
  const mediaBefore = Object.keys(mediaCache).length;

  const page = await api(`/pages/${PAGE_ID}`);
  const title = plain(page.properties?.title?.title) || "YHD NYE";
  const edited = new Date(page.last_edited_time).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });
  const blocks = await fetchChildren(PAGE_ID);
  const content = await renderBlocks(blocks, { inColumn: false });
  const html = shell({ title, edited, content });

  saveBookmarkCache();
  saveMediaCache();
  const tmp = path.join(OUT_DIR, ".index.html.tmp");
  fs.writeFileSync(tmp, html, "utf-8");
  fs.renameSync(tmp, path.join(OUT_DIR, "index.html"));
  const mediaNew = Object.keys(mediaCache).length - mediaBefore;
  console.log(`synced "${title}" — ${blocks.length} top-level blocks, ${mediaNew} new media, ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function main() {
  for (;;) {
    try { await syncOnce(); }
    catch (e) { console.error("sync failed:", e.message); }
    if (RUN_ONCE) break;
    await sleep(INTERVAL * 1000);
  }
}

main();
