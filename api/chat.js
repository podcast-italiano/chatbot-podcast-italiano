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
const RSS_FEEDS = [
  'https://feeds.acast.com/public/shows/668fd0eaa0179c311c39e769', // Podcast Italiano Principiante
  'https://rss.buzzsprout.com/2413795.rss', // Podcast Italiano (principale)
];

// Published Google Sheet (CSV) with all YouTube videos: columns are
// YT ID, title, YouTube URL, free PDF link.
const VIDEO_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSQWcqu1Rd6XolU9J8V2B5CxgIfqpkWJldNS720II6co76U-DPFsMmv9i2AvQ5depnmA4Z9GsE8u6fx/pub?gid=29836155&single=true&output=csv';
const SITEMAP_URL = 'https://www.podcastitaliano.com/sitemap.xml';

let episodeCache = { content: null, fetchedAt: null };
let videoCache = { content: null, fetchedAt: null };
const EPISODE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getSystemPrompt() {
  const now = Date.now();
  if (cache.content && now - cache.fetchedAt < CACHE_TTL) {
    return cache.content;
  }
  const res = await fetch(process.env.SYSTEM_PROMPT_URL);
  if (!res.ok) throw new Error('Failed to fetch system prompt');
  const content = await res.text();
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

function parseFeed(xml) {
  const lines = [];
  const items = xml.split('<item>').slice(1);
  for (const item of items) {
    const body = item.split('</item>')[0];
    const titleMatch = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1]);
    const linkMatch = body.match(/https?:\/\/(?:www\.)?podcastitaliano\.com\/podcast-episode\/[a-z0-9\-]+/i);
    const link = linkMatch ? linkMatch[0] : null;
    if (link) {
      lines.push(`- ${title}: ${link}`);
    } else {
      lines.push(`- ${title} (trascrizione non disponibile online)`);
    }
  }
  return lines;
}

async function getEpisodeList() {
  const now = Date.now();
  if (episodeCache.content && now - episodeCache.fetchedAt < EPISODE_CACHE_TTL) {
    return episodeCache.content;
  }
  let allLines = [];
  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed);
      if (!res.ok) continue;
      const xml = await res.text();
      allLines = allLines.concat(parseFeed(xml));
    } catch (e) {
      // ignore a failing feed, keep the others
    }
  }
  const content = allLines.length
    ? '\n\n=== LISTA EPISODI DEL PODCAST (titoli e link alle trascrizioni) ===\n' +
      'Quando un utente chiede di un episodio specifico, cerca qui il titolo corrispondente e fornisci il link alla trascrizione. Se non trovi un episodio che corrisponde, dillo onestamente e invita a cercare su podcastitaliano.com.\n' +
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
    const sr = await fetch(SITEMAP_URL);
    if (sr.ok) {
      const xml = await sr.text();
      slugSet = new Set();
      const re = /\/video\/([a-z0-9-]+)/g;
      let m;
      while ((m = re.exec(xml)) !== null) slugSet.add(m[1]);
    }
  } catch (e) { /* ignore */ }

  const lines = [];
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

    let line = `- ${title}: ${link}`;
    if (pdf) line += ` | PDF gratuito: ${pdf}`;
    lines.push(line);
  }

  const content = lines.length
    ? '\n\n=== LISTA VIDEO YOUTUBE (titoli, link e PDF gratuiti) ===\n' +
      'Quando un utente chiede di un video o di un argomento spiegato in un video, cerca qui il titolo corrispondente e fornisci il link. Preferisci SEMPRE il link a podcastitaliano.com quando presente (ha la trascrizione), usa il link YouTube solo se non c\'è quello del sito. Se il video ha un "PDF gratuito" associato, proponilo all\'utente. Se non trovi nulla che corrisponde, dillo onestamente.\n' +
      lines.join('\n')
    : '';
  videoCache = { content, fetchedAt: now };
  return content;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (messages.length > 20) {
    return res.status(400).json({ error: 'Conversation limit reached' });
  }

  try {
    const [systemPrompt, episodeList, videoList] = await Promise.all([
      getSystemPrompt(),
      getEpisodeList().catch(() => ''),
      getVideoList().catch(() => ''),
    ]);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt + episodeList + videoList },
        ...messages,
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;
    const userMessage = messages[messages.length - 1].content;

    fetch('https://hook.eu2.make.com/tqg823h0gmb0n4iveshna4f9goxa4lup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        user_message: userMessage,
        bot_reply: reply,
        conversation_length: messages.length,
      }),
    }).catch(() => {});

    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.', debug: String(err && err.message || err) });
  }
};
