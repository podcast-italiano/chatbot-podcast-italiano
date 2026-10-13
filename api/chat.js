const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Precomputed map: YouTube video ID -> podcastitaliano.com site page URL.
// Built by crawling the site's /video/ pages once. Used to link to the site
// (with transcript) instead of YouTube whenever a page exists.
// Loaded defensively: if the file is missing, the bot still works and falls
// back to YouTube links instead of crashing the whole function.
let VIDEO_SITE_MAP = {};
try {
  VIDEO_SITE_MAP = require('./video-site-map.json');
} catch (e) {
  console.error('video-site-map.json not found, falling back to YouTube links');
}

let cache = { content: null, fetchedAt: null };
const CACHE_TTL = 1 * 60 * 1000; // 1 minute

// RSS feeds for Podcast Italiano shows. Episode titles + transcript links
// are extracted from these and injected into the system prompt so the bot
// always knows which episodes exist and where to find their transcriptions.
// The two shows have separate numbering (Principiante #122, Intermedio #67):
// every line carries the show name so the bot never mixes them up.
const RSS_FEEDS = [
  { url: 'https://feeds.acast.com/public/shows/668fd0eaa0179c311c39e769', show: 'Podcast Italiano Principiante' },
  { url: 'https://rss.buzzsprout.com/2413795.rss', show: 'Podcast Italiano (intermedio/avanzato)' },
];

// Published Google Sheet (CSV) with all YouTube videos: columns are
// YT ID, title, YouTube URL, free PDF link.
const VIDEO_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSQWcqu1Rd6XolU9J8V2B5CxgIfqpkWJldNS720II6co76U-DPFsMmv9i2AvQ5depnmA4Z9GsE8u6fx/pub?gid=29836155&single=true&output=csv';
const SITEMAP_URL = 'https://www.podcastitaliano.com/sitemap.xml';

let episodeCache = { content: null, fetchedAt: null };
let videoCache = { content: null, fetchedAt: null };
const EPISODE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function decodeAllEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// Google Docs "Publish to web" returns a full HTML page (with a huge inline
// CSS block) that can be ~100k tokens. Strip it down to plain text so we only
// send the actual knowledge base to the model. Safe no-op on plain text/markdown.
function htmlToText(input) {
  if (!/<\/?[a-z][\s\S]*>/i.test(input)) return input; // already plain text
  let text = input;
  const body = text.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  if (body) text = body[1];
  text = text
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeAllEntities(text);
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function getSystemPrompt() {
  const now = Date.now();
  if (cache.content && now - cache.fetchedAt < CACHE_TTL) {
    return cache.content;
  }
  const res = await fetch(process.env.SYSTEM_PROMPT_URL);
  if (!res.ok) throw new Error('Failed to fetch system prompt');
  const raw = await res.text();
  const content = htmlToText(raw);
  cache = { content, fetchedAt: now };
  return content;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function parseFeed(xml, show) {
  const lines = [];
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    const body = item.split('</item>')[0];
    const titleMatch = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1]);
    const linkMatch = body.match(/https?:\/\/(?:www\.)?podcastitaliano\.com\/podcast-episode\/[a-z0-9\-]+/i);
    let link = linkMatch ? linkMatch[0].replace(/^https?:\/\/podcastitaliano\.com/i, 'https://www.podcastitaliano.com') : null;
    // Many older episodes have no site link in the feed although the page exists:
    // look the title up among the /podcast-episode/ slugs of the sitemap.
    if (!link && siteEpisodeSlugs) {
      const slug = matchEpisodeSlug(title, siteEpisodeSlugs);
      if (slug) link = 'https://www.podcastitaliano.com/podcast-episode/' + slug;
    }
    if (link) {
      lines.push(`- [${show}] ${title}: ${link}`);
    } else {
      lines.push(`- [${show}] ${title} (pagina con trascrizione non trovata sul sito)`);
    }
  }
  return lines;
}

const STOPWORDS = new Set('il lo la i gli le un una di a da in con su per tra fra e o che del della dei delle al alla nel nella non si mi ti ci vi'.split(' '));

function slugWords(s) {
  return new Set(slugify(s).split('-').filter((w) => w && !STOPWORDS.has(w)));
}

// Best sitemap slug for a feed title (word overlap, threshold tuned on the real
// feeds: 120 of 147 unlinked episodes found, no false matches in the sample).
function matchEpisodeSlug(title, slugs) {
  let core = title
    .replace(/\s*[-–]\s*(Intermedio|Avanzato|Principiante|Speciale|Riflessioni|Intervist\w*|RST)\b.*$/i, '')
    .replace(/^#\d+\s*[-–:]\s*/, '');
  const tw = slugWords(core);
  if (!tw.size) return null;
  let best = null;
  let bestScore = 0;
  for (const s of slugs) {
    const sw = new Set(s.split('-').filter((w) => w && !STOPWORDS.has(w)));
    if (!sw.size) continue;
    let inter = 0;
    for (const w of sw) if (tw.has(w)) inter++;
    const score = inter / (sw.size + tw.size - inter);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.6 ? best : null;
}

let sitemapCache = { xml: null, fetchedAt: null };
async function getSitemap() {
  const now = Date.now();
  if (sitemapCache.xml && now - sitemapCache.fetchedAt < EPISODE_CACHE_TTL) return sitemapCache.xml;
  const r = await fetch(SITEMAP_URL);
  if (!r.ok) return sitemapCache.xml || '';
  const xml = await r.text();
  sitemapCache = { xml, fetchedAt: now };
  return xml;
}

function sitemapSlugs(xml, section) {
  const set = new Set();
  const re = new RegExp('/' + section + '/([a-z0-9-]+)', 'g');
  let m;
  while ((m = re.exec(xml)) !== null) set.add(m[1]);
  return set;
}

let siteEpisodeSlugs = null;

async function getEpisodeList() {
  const now = Date.now();
  if (episodeCache.content && now - episodeCache.fetchedAt < EPISODE_CACHE_TTL) {
    return episodeCache.content;
  }
  try {
    const xml = await getSitemap();
    if (xml) siteEpisodeSlugs = [...sitemapSlugs(xml, 'podcast-episode')];
  } catch (e) { /* ignore: fall back to the feed links only */ }
  let allLines = [];
  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url);
      if (!res.ok) continue;
      const xml = await res.text();
      allLines = allLines.concat(parseFeed(xml, feed.show));
    } catch (e) {
      // ignore a failing feed, keep the others
    }
  }
  const content = allLines.length
    ? '\n\n=== LISTA EPISODI DEL PODCAST (titoli e link alle trascrizioni) ===\n' +
      'Quando un utente chiede di un episodio o di un argomento, cerca qui i titoli pertinenti. Se l\'utente chiede di un ARGOMENTO o un tema generale, proponi PIU episodi rilevanti (fino a 4-5), ciascuno con il suo link, non solo uno. Se chiede un episodio specifico, dai quello. Ogni riga dice a quale podcast appartiene l\'episodio: i due podcast hanno numerazioni separate, quindi se l\'utente da solo un numero chiedi di quale podcast parla. Se non trovi nulla che corrisponde, dillo onestamente e invita a cercare su podcastitaliano.com.\n' +
      allLines.join('\n')
    : '';
  episodeCache = { content, fetchedAt: now };
  return content;
}

// Parse a single CSV line, honoring quoted fields (titles can contain commas).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuotes = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Turn a video title into a Webflow-style slug, to match new videos against
// the sitemap when they are not yet in the precomputed map.
function slugify(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const videoPageCache = new Map();
async function readVideoPage(slug) {
  if (videoPageCache.has(slug)) return videoPageCache.get(slug);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://www.podcastitaliano.com/video/' + slug, { signal: ctrl.signal });
    if (!r.ok) return null;
    const html = await r.text();
    const t = html.match(/<title>([^<]*)<\/title>/i);
    const p = html.match(/https:\/\/bit\.ly\/PDF-[A-Za-z0-9_-]+/);
    const v = { slug, title: t ? decodeAllEntities(t[1]).trim() : slug.replace(/-/g, ' '), pdf: p ? p[0] : '' };
    videoPageCache.set(slug, v);
    return v;
  } finally {
    clearTimeout(timer);
  }
}

async function getVideoList() {
  const now = Date.now();
  if (videoCache.content && now - videoCache.fetchedAt < EPISODE_CACHE_TTL) {
    return videoCache.content;
  }

  let csv = '';
  try {
    const r = await fetch(VIDEO_CSV_URL);
    if (r.ok) csv = await r.text();
  } catch (e) { /* ignore */ }
  if (!csv) return videoCache.content || '';

  // Build a set of /video/ slugs from the sitemap, to auto-resolve brand-new
  // videos that are not yet in the precomputed VIDEO_SITE_MAP.
  let slugSet = null;
  try {
    const xml = await getSitemap();
    if (xml) slugSet = sitemapSlugs(xml, 'video');
  } catch (e) { /* ignore */ }

  const lines = [];
  const covered = new Set();
  for (const raw of csv.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cols = parseCsvLine(raw);
    const ytid = (cols[0] || '').trim();
    const title = (cols[1] || '').trim();
    const yturl = (cols[2] || '').trim();
    const pdf = (cols[3] || '').trim();
    if (!ytid || !title) continue;

    // Prefer the site page (has transcript). Fall back to sitemap slug match
    // for new videos, then to YouTube.
    let link = VIDEO_SITE_MAP[ytid];
    if (!link && slugSet) {
      const slug = slugify(title);
      if (slugSet.has(slug)) link = 'https://www.podcastitaliano.com/video/' + slug;
    }
    if (!link) link = yturl;
    const m = link.match(/\/video\/([a-z0-9-]+)/);
    if (m) covered.add(m[1]);

    let line = `- ${title}: ${link}`;
    if (pdf) line += ` | PDF gratuito: ${pdf}`;
    lines.push(line);
  }

  // The CSV is not updated when a new video is published: every /video/ page of
  // the sitemap that it does not cover is read directly (title + free PDF link).
  if (slugSet) {
    const missing = [...slugSet].filter((s) => !covered.has(s)).slice(0, 80);
    const extra = await Promise.all(missing.map((s) => readVideoPage(s).catch(() => null)));
    for (const v of extra) {
      if (!v) continue;
      let line = `- ${v.title} (${v.slug.replace(/-/g, ' ')}): https://www.podcastitaliano.com/video/${v.slug}`;
      if (v.pdf) line += ` | PDF gratuito: ${v.pdf}`;
      lines.unshift(line); // newest videos first
    }
  }

  const content = lines.length
    ? '\n\n=== LISTA VIDEO YOUTUBE (titoli, link e PDF gratuiti) ===\n' +
      'Quando un utente chiede di un video o di un argomento, cerca qui i titoli pertinenti. Se l\'utente chiede di un ARGOMENTO o un tema generale, proponi PIU video rilevanti (fino a 4-5), ciascuno con il suo link, non solo uno. Se chiede un video specifico, dai quello, e mai un video su un altro argomento al suo posto (per esempio il congiuntivo a chi cerca il condizionale). Preferisci SEMPRE il link a podcastitaliano.com quando presente (ha la trascrizione), usa il link YouTube solo se non c\'è quello del sito. Se il video ha un "PDF gratuito" associato, proponilo all\'utente. Se l\'utente incolla un link bit.ly/PDF-..., cercalo qui e dagli il video corrispondente. Se non trovi nulla che corrisponde, dillo onestamente.\n' +
      lines.join('\n')
    : '';
  videoCache = { content, fetchedAt: now };
  return content;
}

// Page the widget is open on (sent by widget.html). Only Podcast Italiano pages
// are accepted, so a forged body cannot inject arbitrary text into the prompt.
function cleanPage(page) {
  if (!page || typeof page.url !== 'string') return null;
  let u;
  try { u = new URL(page.url); } catch (e) { return null; }
  if (!/(^|\.)podcastitaliano\.com$/.test(u.hostname)) return null;
  const title = String(page.title || '').replace(/[\r\n]+/g, ' ').slice(0, 150);
  return { url: (u.origin + u.pathname).slice(0, 300), title };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, page, conversation_id } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (messages.length > 20) {
    return res.status(400).json({ error: 'Conversation limit reached' });
  }

  // TEMP diagnostic: report the size of each prompt component.
  if (messages[0] && messages[0].content === '__debug__') {
    const sp = await getSystemPrompt().catch((e) => 'ERR:' + e.message);
    const ep = await getEpisodeList().catch(() => '');
    const vd = await getVideoList().catch(() => '');
    return res.status(200).json({
      systemPrompt_chars: sp.length,
      systemPrompt_head: sp.slice(0, 300),
      episodes_chars: ep.length,
      episodes_lines: (ep.match(/\n- /g) || []).length,
      episodes_without_page: (ep.match(/pagina con trascrizione non trovata/g) || []).length,
      videos_chars: vd.length,
      videos_lines: (vd.match(/\n- /g) || []).length,
      videos_head: vd.split('\n').slice(3, 6),
    });
  }

  try {
    const [systemPrompt, episodeList, videoList] = await Promise.all([
      getSystemPrompt(),
      getEpisodeList().catch(() => ''),
      getVideoList().catch(() => ''),
    ]);

    const pageInfo = cleanPage(page);
    const pageBlock = pageInfo
      ? '\n\n=== PAGINA DA CUI SCRIVE L\'UTENTE ===\n' +
        `Titolo: ${pageInfo.title}\nURL: ${pageInfo.url}\n` +
        'Se l\'utente dice "questo episodio", "questo video", "questa storia", "questa pagina" o simili, intende questa pagina: non chiedergli quale.\n'
      : '';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt + pageBlock + episodeList + videoList },
        ...messages,
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const reply = completion.choices[0].message.content;
    const userMessage = messages[messages.length - 1].content;

    // Awaited (with a short timeout): a fire-and-forget fetch can be cut off when
    // the serverless function freezes after the response, and the row is lost.
    const logCtrl = new AbortController();
    const logTimer = setTimeout(() => logCtrl.abort(), 2500);
    await fetch('https://hook.eu2.make.com/tqg823h0gmb0n4iveshna4f9goxa4lup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: logCtrl.signal,
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        user_message: userMessage,
        bot_reply: reply,
        conversation_length: messages.length,
        conversation_id: typeof conversation_id === 'string' ? conversation_id.slice(0, 40) : '',
        page_url: pageInfo ? pageInfo.url : '',
        page_title: pageInfo ? pageInfo.title : '',
      }),
    }).catch(() => {});
    clearTimeout(logTimer);

    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.', debug: String(err && err.message || err) });
  }
};
