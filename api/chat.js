const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cache = { content: null, fetchedAt: null };
const CACHE_TTL = 1 * 60 * 1000; // 1 minute

// RSS feeds for Podcast Italiano shows. Episode titles + transcript links
// are extracted from these and injected into the system prompt so the bot
// always knows which episodes exist and where to find their transcriptions.
const RSS_FEEDS = [
  'https://feeds.acast.com/public/shows/668fd0eaa0179c311c39e769', // Podcast Italiano Principiante
  'https://rss.buzzsprout.com/2413795.rss', // Podcast Italiano (principale)
];

let episodeCache = { content: null, fetchedAt: null };
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
    // Look for a podcastitaliano.com transcript link inside the item
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
    const systemPrompt = await getSystemPrompt();
    const episodeList = await getEpisodeList();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt + episodeList }, ...messages],
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
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
