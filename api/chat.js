const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cache = { content: null, fetchedAt: null };
const CACHE_TTL = 30 * 60 * 1000;

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
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
