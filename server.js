require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  FACEBOOK_PAGE_ACCESS_TOKEN,
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

const OWN_PAGE_NAME = "Scenorium"; // your Facebook Page name — used to skip own replies
const repliedComments = new Set();

// ─── Helper: sleep for ms milliseconds ────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Helper: random delay between min and max ms ──────────────────────────────
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Webhook Verification ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Receive Comment Events ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "feed") continue;

      const val = change.value;

      // Only handle new top-level comments (not likes, reactions, post edits, etc.)
      if (val.item !== "comment" || val.verb !== "add") continue;

      const commentId = val.comment_id;
      const commentText = val.message;
      const postId = val.post_id;
      const fromName = val.from?.name;

      if (!commentId || !commentText) continue;

      // ── Skip if comment is from our own Page ──
      if (fromName === OWN_PAGE_NAME) {
        console.log(`🤖 Skipping own comment from ${fromName}`);
        continue;
      }

      // ── Skip if already replied ──
      if (repliedComments.has(commentId)) {
        console.log(`⏭️ Already replied to comment ${commentId}, skipping`);
        continue;
      }

      repliedComments.add(commentId);
      console.log(`💬 New comment from ${fromName}: "${commentText}"`);

      try {
        const postCaption = postId ? await getPostMessage(postId) : "";
        const reply = await generateReply(commentText, postCaption);

        // ── Wait a random human-like delay before replying ──
        const delayMs = randomDelay(5000, 10000);
        console.log(`⏳ Waiting ${(delayMs / 1000).toFixed(1)}s before replying...`);
        await sleep(delayMs);

        await postReply(commentId, reply);
        console.log(`✅ Replied: "${reply}"`);
      } catch (err) {
        repliedComments.delete(commentId);
        if (err.response) {
          console.error("❌ API Error:", err.response.status, JSON.stringify(err.response.data));
        } else {
          console.error("❌ Error:", err.message);
        }
      }
    }
  }
});

// ─── Fetch Post Message (caption) for context ─────────────────────────────────
async function getPostMessage(postId) {
  try {
    const res = await axios.get(`https://graph.facebook.com/v21.0/${postId}`, {
      params: { fields: "message", access_token: FACEBOOK_PAGE_ACCESS_TOKEN },
    });
    return res.data.message || "";
  } catch (err) {
    console.log("⚠️ Could not fetch post message:", err.response?.data || err.message);
    return "";
  }
}

// ─── Generate Reply via Groq (Free) ──────────────────────────────────────────
async function generateReply(commentText, postCaption) {
  const systemPrompt = `You are a real person who runs the Scenorium Facebook Page, focused on films and cinema.
You're replying to comments on your posts. Write exactly like a young film enthusiast typing a quick reply.

Rules:
- MAX 1 sentence. Often even less.
- If the comment is only emojis, reply with 1-2 emojis only. Nothing else.
- Use lowercase most of the time. Capitalize only for emphasis occasionally.
- No punctuation at the end of sentences sometimes. Real people forget periods.
- NEVER start two replies with the same word. Vary how you open every reply.
- NEVER use the word "lowkey" more than once every 10 replies. Find other ways to express things.
- NEVER reply with "same", "same lol", "same tho", "same energy" or any variation starting with "same" — this is overused, ban it completely.
- Never say "I can imagine", "it's crazy how", "it resonates", "I completely agree" — too formal.
- Vary your style: sometimes just agree with one word, sometimes add a thought, sometimes ask a short question, sometimes react with just an emoji or two.
- Examples of good short reactions (rotate between styles like these, don't reuse the same structure twice in a row):
    "still hits different every time"
    "fr man, nothing's changed"
    "that scene gets me every time ngl"
    "exactly 😭"
    "bro said what we were all thinking"
    "real talk"
    "27 years and here we are lol"
    "always will be"
    "facts"
    "this 💯"
    "ong"
    "🤣🤣"
    "no cap"
    "deadass"
    "haha true"
    "right?? 😭"
- Never thank people for commenting. Never say "glad you enjoyed it".
- Sound like you typed this on your phone in 5 seconds.

CRITICAL — if someone asks a direct question (movie title, actor name, release year, where to watch, etc.):
- ONLY answer if you can clearly tell the answer from the post caption given below.
- If the caption doesn't contain the answer, do NOT guess or make something up. Instead reply with something honest and casual like: "it's in the caption!" or "check the post for that 🎬" or "title's in the post!"
- Never invent a movie title, actor name, or fact you're not sure about.`;

  const userPrompt = postCaption
    ? `Your post caption: "${postCaption}"\n\nSomeone commented: "${commentText}"\n\nReply naturally (short, casual, human, don't start with "lowkey"). If they asked a question, only answer using info from the caption above — otherwise redirect them to the caption.`
    : `Someone commented on your Facebook post: "${commentText}"\n\nNo caption text is available for this post.\n\nReply naturally (short, casual, human, don't start with "lowkey"). If they asked a factual question you can't verify, don't guess — just respond casually without giving false info.`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 60,
      temperature: 0.95,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content.trim();
}

// ─── Post Reply to Facebook Comment ───────────────────────────────────────────
async function postReply(commentId, message) {
  const res = await axios.post(
    `https://graph.facebook.com/v21.0/${commentId}/comments`,
    null,
    { params: { message, access_token: FACEBOOK_PAGE_ACCESS_TOKEN } }
  );
  return res.data;
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Facebook AutoReply is running ✅"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
