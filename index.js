/**
 * WhatsApp -> n8n -> WhatsApp bot (with extensive debugging logs)
 *
 * ENV:
 *   N8N_WEBHOOK_URL=...
 *   COOLDOWN_MS=8000
 *   PRICE_IMAGES=offers/01.jpg,offers/02.jpg,offers/03.jpg
 *   REVIEW_IMAGES=reviews/01.jpg,reviews/02.jpg,reviews/03.jpg
 *   BENEFITS_IMAGES=learn/01.jpg,learn/02.jpg,learn/03.jpg   <-- NEW
 *   ALLOWLIST=9199xxxxxxx,9188xxxxxxx   (optional)
 *   LOG_LEVEL=debug                     (optional)
 *   DEBUG=1                             (optional)
 *
 * n8n response supported:
 *  - Flat: { reply, flags, imageUrls? }
 *  - Wrapped: { output: { reply, flags, imageUrls? } }
 *
 * imageUrls optional:
 *  {
 *    priceListOrPromoOffers: [..],
 *    userReviewsAndFeedbacks: [..],
 *    benefitsAvailable: [..]          <-- NEW
 *  }
 */

require("dotenv").config();

const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// -------------------- Logger --------------------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL =
  (process.env.LOG_LEVEL || (process.env.DEBUG ? "debug" : "info")).toLowerCase();
const LOG_LEVEL_NUM = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return '"<non-serializable>"';
  }
}

function log(level, msg, meta) {
  const lvl = (level || "info").toLowerCase();
  const lvlNum = LEVELS[lvl] ?? LEVELS.info;
  if (lvlNum < LOG_LEVEL_NUM) return;

  const line = `[${ts()}] [${lvl.toUpperCase()}] ${msg}`;
  if (meta !== undefined) {
    console.log(line, safeJson(meta));
  } else {
    console.log(line);
  }
}

function maskUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const base = `${u.protocol}//${u.host}${u.pathname}`;
    return base.length > 60 ? base.slice(0, 60) + "…" : base;
  } catch {
    return String(url).slice(0, 60) + (String(url).length > 60 ? "…" : "");
  }
}

function makeTraceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled Promise rejection", {
    reason: String(reason),
    stack: reason?.stack,
  });
});
process.on("uncaughtException", (err) => {
  log("error", "Uncaught exception", { message: err?.message, stack: err?.stack });
});

// -------------------- Config --------------------
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
if (!N8N_WEBHOOK_URL) {
  console.error("❌ Missing N8N_WEBHOOK_URL in .env");
  process.exit(1);
}

const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 8000);

const PRICE_IMAGES = parseCsvList(process.env.PRICE_IMAGES);
const REVIEW_IMAGES = parseCsvList(process.env.REVIEW_IMAGES);
const BENEFITS_IMAGES = parseCsvList(process.env.BENEFITS_IMAGES); // <-- NEW
const ALLOWLIST = parseCsvList(process.env.ALLOWLIST).map(normalizePhone);

log("info", "Bot starting with config", {
  LOG_LEVEL,
  COOLDOWN_MS,
  N8N_WEBHOOK_URL: maskUrl(N8N_WEBHOOK_URL),
  PRICE_IMAGES_count: PRICE_IMAGES.length,
  REVIEW_IMAGES_count: REVIEW_IMAGES.length,
  BENEFITS_IMAGES_count: BENEFITS_IMAGES.length, // <-- NEW
  ALLOWLIST_enabled: ALLOWLIST.length > 0,
  ALLOWLIST_count: ALLOWLIST.length,
});

// -------------------- WhatsApp client --------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  log("info", "QR event received: scan to login");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  log("info", "✅ WhatsApp bot is ready!");
});

client.on("auth_failure", (msg) => {
  log("error", "WhatsApp auth_failure", { msg });
});

client.on("disconnected", (reason) => {
  log("warn", "WhatsApp disconnected", { reason });
});

// -------------------- Per-user queue + cooldown --------------------
const sendQueues = new Map();
/**
 * Record shape:
 * { lastCall: number, queue: Array<Task>, processing: boolean }
 * Task shape: { userId, waChatId, messageText, resolve, reject, traceId }
 */

function getQueueRecord(userId) {
  if (!sendQueues.has(userId)) {
    sendQueues.set(userId, { lastCall: 0, queue: [], processing: false });
    log("debug", "Created new queue record", { userId });
  }
  return sendQueues.get(userId);
}

function scheduleSendToN8N({ userId, waChatId, messageText, traceId }) {
  const record = getQueueRecord(userId);
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const task = { userId, waChatId, messageText, resolve, reject, traceId };

    const timeSinceLast = now - record.lastCall;
    const canSendNow = !record.processing && timeSinceLast >= COOLDOWN_MS;

    log("debug", "scheduleSendToN8N called", {
      traceId,
      userId,
      waChatId,
      processing: record.processing,
      queueLength: record.queue.length,
      timeSinceLast,
      canSendNow,
      COOLDOWN_MS,
      messagePreview: messageText.slice(0, 80),
      messageLen: messageText.length,
    });

    if (canSendNow) {
      log("info", "Queue: sending immediately", { traceId, userId });
      runSendTask(task, record);
      return;
    }

    record.queue.push(task);
    log("info", "Queue: task queued", {
      traceId,
      userId,
      newQueueLength: record.queue.length,
    });

    if (!record.processing && record.queue.length === 1) {
      const waitTime = Math.max(0, COOLDOWN_MS - timeSinceLast);
      log("debug", "Queue: scheduling first queued task after wait", {
        traceId,
        userId,
        waitTime,
      });

      setTimeout(() => {
        if (!record.processing && record.queue.length > 0) {
          const nextTask = record.queue.shift();
          log("info", "Queue: dequeued task for execution", {
            traceId: nextTask?.traceId,
            userId,
            remainingQueueLength: record.queue.length,
          });
          runSendTask(nextTask, record);
        } else {
          log("debug", "Queue: timer fired but nothing to run", {
            traceId,
            userId,
            processing: record.processing,
            queueLength: record.queue.length,
          });
        }
      }, waitTime);
    }
  });
}

async function runSendTask(task, record) {
  record.processing = true;
  const start = Date.now();
  record.lastCall = start;

  log("info", "Queue: runSendTask start", {
    traceId: task.traceId,
    userId: task.userId,
    queueLength: record.queue.length,
  });

  try {
    const data = await sendToN8N(
      {
        userId: task.userId,
        waChatId: task.waChatId,
        message: task.messageText,
      },
      { traceId: task.traceId }
    );

    task.resolve(data);
    log("info", "Queue: runSendTask success", {
      traceId: task.traceId,
      userId: task.userId,
      elapsedMs: Date.now() - start,
    });
  } catch (err) {
    task.reject(err);
    log("error", "Queue: runSendTask error", {
      traceId: task.traceId,
      userId: task.userId,
      message: err?.message,
      stack: err?.stack,
    });
  } finally {
    record.processing = false;

    if (record.queue.length > 0) {
      const elapsed = Date.now() - start;
      const waitTime = Math.max(0, COOLDOWN_MS - elapsed);

      log("info", "Queue: scheduling next queued task", {
        traceId: task.traceId,
        userId: task.userId,
        elapsedMs: elapsed,
        waitTime,
        remainingQueueLength: record.queue.length,
      });

      setTimeout(() => {
        if (!record.processing && record.queue.length > 0) {
          const nextTask = record.queue.shift();
          log("info", "Queue: dequeued next task", {
            traceId: nextTask?.traceId,
            userId: task.userId,
            remainingQueueLength: record.queue.length,
          });
          runSendTask(nextTask, record);
        } else {
          log("debug", "Queue: next-task timer fired but nothing to run", {
            userId: task.userId,
            processing: record.processing,
            queueLength: record.queue.length,
          });
        }
      }, waitTime);
    } else {
      log("debug", "Queue: idle (no queued tasks)", {
        traceId: task.traceId,
        userId: task.userId,
      });
    }
  }
}

// -------------------- n8n call --------------------
async function sendToN8N(payload, { traceId } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const startedAt = Date.now();
  log("info", "n8n: sending request", {
    traceId,
    url: maskUrl(N8N_WEBHOOK_URL),
    payload: {
      ...payload,
      messagePreview: String(payload?.message || "").slice(0, 120),
      messageLen: String(payload?.message || "").length,
    },
  });

  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await resp.text();
    log("info", "n8n: response received", {
      traceId,
      status: resp.status,
      ok: resp.ok,
      elapsedMs: Date.now() - startedAt,
      bodyLen: text.length,
      bodyPreview: text.slice(0, 250),
    });

    if (!resp.ok) {
      throw new Error(`n8n error ${resp.status}: ${text.slice(0, 500)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      log("error", "n8n: JSON parse failed", {
        traceId,
        error: e?.message,
        bodyPreview: text.slice(0, 800),
      });
      throw new Error(`n8n returned non-JSON: ${text.slice(0, 500)}`);
    }

    log("debug", "n8n: parsed JSON", { traceId, data });
    return data;
  } catch (err) {
    const isAbort = String(err?.name || "").toLowerCase().includes("abort");
    log("error", "n8n: request failed", {
      traceId,
      aborted: isAbort,
      message: err?.message,
      stack: err?.stack,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// -------------------- Message handling --------------------
client.on("message_create", async (message) => {
  const traceId = makeTraceId();

  try {
    if (message.fromMe) {
      log("debug", "Ignored message.fromMe", { traceId });
      return;
    }

    const body = (message.body || "").trim();
    if (!body) {
      log("debug", "Ignored empty body", { traceId, from: message.from });
      return;
    }

    const waChatId = message.from; // e.g. "9199xxxxxxx@c.us"
    const userId = normalizePhone(waChatId.split("@")[0]);

    log("info", "Incoming WhatsApp message", {
      traceId,
      userId,
      waChatId,
      bodyLen: body.length,
      bodyPreview: body.slice(0, 160),
      hasMedia: !!message.hasMedia,
      timestamp: message.timestamp,
      type: message.type,
    });

    if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(userId)) {
      log("warn", "Blocked by allowlist", { traceId, userId, waChatId });
      return;
    }

    const n8nData = await scheduleSendToN8N({
      userId,
      waChatId,
      messageText: body,
      traceId,
    });

    log("debug", "n8nData received (before handling)", { traceId, n8nData });
    await handleWebhookResponse({ message, waChatId, userId, n8nData, traceId });
  } catch (err) {
    log("error", "❌ Error handling WhatsApp message", {
      traceId,
      message: err?.message,
      stack: err?.stack,
    });

    try {
      await message.reply("❌ Internal error processing your request.");
    } catch (e) {
      log("error", "Failed to send WhatsApp error reply", {
        traceId,
        message: e?.message,
      });
    }
  }
});

// -------------------- Response logic --------------------
async function handleWebhookResponse({ message, waChatId, userId, n8nData, traceId }) {
  const data = normalizeN8NResponse(n8nData, traceId);

  const reply =
    typeof data.reply === "string" && data.reply.trim()
      ? data.reply.trim()
      : "";

  const flags = data.flags || {};
  const priceFlag = !!flags.priceListOrPromoOffers;
  const learnFlag = !!flags.benefitsAvailable;
  const reviewsFlag = !!flags.userReviewsAndFeedbacks;
  const paymentQrFlag = !!flags.paymentQr;


  const activeFlags = [priceFlag, learnFlag, reviewsFlag].filter(Boolean).length;
  if (activeFlags > 1) {
    log("warn", "Multiple intent flags true; applying priority price > learn > reviews", {
      traceId,
      userId,
      flags,
    });
  }

  const imageUrls = data.imageUrls || {};

  const priceImages = pickFirst3(
    imageUrls.priceListOrPromoOffers || PRICE_IMAGES
  );

  const reviewImages = pickFirst3(
    imageUrls.userReviewsAndFeedbacks || REVIEW_IMAGES
  );

  const learnMoreImages = pickFirst3(
    imageUrls.benefitsAvailable || BENEFITS_IMAGES
  );

  const safeReply = reply || "⚠️ AI did not return a reply.";

  if (!reply) {
    log("warn", "AI reply missing after normalization", {
      traceId,
      userId,
      rawN8NKeys: Object.keys(n8nData || {}),
      normalizedKeys: Object.keys(data || {}),
    });
  }

  log("info", "Routing decision", {
    traceId,
    userId,
    priceFlag,
    learnFlag,
    reviewsFlag,
    replyLen: safeReply.length,
    replyPreview: safeReply.slice(0, 180),
    priceImages,
    reviewImages,
    learnMoreImages,
  });

  // 1) Offers / Promo: images -> reply
  if (priceFlag) {
    log("info", "Action: Price/Promo branch", { traceId, userId });
    await sendImages(waChatId, priceImages, { traceId, reason: "price" });
    await delayForHumanFeel(safeReply, { traceId });
    await client.sendMessage(waChatId, safeReply);
    log("info", "Action: Price/Promo reply sent", { traceId, userId });
    return;
  }

  // 2) Learn more / How it works: images -> reply (UPDATED)
  if (learnFlag) {
    log("info", "Action: Learn more branch (IMAGE FLOW)", { traceId, userId });
    await sendImages(waChatId, learnMoreImages, { traceId, reason: "learn-more" });
    await delayForHumanFeel(safeReply, { traceId });
    await client.sendMessage(waChatId, safeReply);
    log("info", "Action: Learn more reply sent", { traceId, userId });
    return;
  }

  // 3) Reviews: images -> reply
  if (reviewsFlag) {
    log("info", "Action: Reviews branch", { traceId, userId });
    await sendImages(waChatId, reviewImages, { traceId, reason: "reviews" });
    await delayForHumanFeel(safeReply, { traceId });
    await client.sendMessage(waChatId, safeReply);
    log("info", "Action: Reviews reply sent", { traceId, userId });
    return;
  }

  // 4) Payment QR flow
if (paymentQrFlag) {
  log("info", "Action: Payment QR branch", { traceId, userId });

  // 1️⃣ Send QR image
  if (PAYMENT_QR_IMAGE) {
    await sendImages(
      waChatId,
      [PAYMENT_QR_IMAGE],
      { traceId, reason: "payment-qr" }
    );
  } else {
    log("warn", "PAYMENT_QR_IMAGE not configured", { traceId });
  }

  // 2️⃣ Small human delay
  await delayForHumanFeel(safeReply, { traceId });

  // 3️⃣ Send payment instructions text
  await client.sendMessage(waChatId, safeReply);

  log("info", "Action: Payment QR sent", { traceId, userId });
  return;
}


  // Default: reply only
  log("info", "Action: Default reply", { traceId, userId });
  await message.reply(safeReply);
}

// -------------------- Media helpers --------------------
async function sendImages(waChatId, urlsOrPaths, { traceId, reason } = {}) {
  const list = (urlsOrPaths || []).filter(Boolean).slice(0, 3);
  log("debug", "sendImages called", { traceId, reason, waChatId, list });

  if (list.length === 0) {
    log("warn", "sendImages: no images to send", { traceId, reason, waChatId });
    return;
  }

  for (const item of list) {
    try {
      log("info", "Sending image", {
        traceId,
        reason,
        waChatId,
        item,
        kind: isHttpUrl(item) ? "url" : "local",
      });

      const media = await toMessageMedia(item, { traceId, reason });
      await client.sendMessage(waChatId, media);

      log("info", "Image sent OK", { traceId, reason, waChatId, item });
      await sleep(500);
    } catch (err) {
      log("warn", "⚠️ Failed to send image", {
        traceId,
        reason,
        waChatId,
        item,
        message: err?.message,
        stack: err?.stack,
      });
    }
  }
}

async function toMessageMedia(urlOrPath, { traceId, reason } = {}) {
  if (isHttpUrl(urlOrPath) && typeof MessageMedia.fromUrl === "function") {
    log("debug", "toMessageMedia: using MessageMedia.fromUrl", { traceId, reason, urlOrPath });
    return await MessageMedia.fromUrl(urlOrPath, { unsafeMime: true });
  }

  if (isHttpUrl(urlOrPath)) return await mediaFromUrl(urlOrPath, { traceId, reason });
  return mediaFromLocalPath(urlOrPath, { traceId, reason });
}

async function mediaFromUrl(url, { traceId, reason } = {}) {
  log("debug", "mediaFromUrl: fetching", { traceId, reason, url: maskUrl(url) });

  const startedAt = Date.now();
  const resp = await fetch(url);
  const contentType = resp.headers.get("content-type") || "application/octet-stream";

  log("debug", "mediaFromUrl: response", {
    traceId,
    reason,
    status: resp.status,
    ok: resp.ok,
    contentType,
    elapsedMs: Date.now() - startedAt,
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const arrBuf = await resp.arrayBuffer();
  const buffer = Buffer.from(arrBuf);
  const base64 = buffer.toString("base64");

  log("debug", "mediaFromUrl: downloaded", {
    traceId,
    reason,
    bytes: buffer.length,
    base64Len: base64.length,
  });

  const filename = safeFilenameFromUrl(url) || "image";
  return new MessageMedia(contentType, base64, filename);
}

function mediaFromLocalPath(p, { traceId, reason } = {}) {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);

  log("debug", "mediaFromLocalPath: resolving", { traceId, reason, p, abs });

  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }

  const stat = fs.statSync(abs);
  const buffer = fs.readFileSync(abs);
  const base64 = buffer.toString("base64");
  const mime = mimeFromExt(path.extname(abs));
  const filename = path.basename(abs);

  log("debug", "mediaFromLocalPath: loaded", {
    traceId,
    reason,
    abs,
    bytes: stat.size,
    mime,
    filename,
  });

  return new MessageMedia(mime, base64, filename);
}

function mimeFromExt(ext) {
  const e = (ext || "").toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".gif") return "image/gif";
  return "application/octet-stream";
}

function safeFilenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    return base || "image";
  } catch {
    return "image";
  }
}

// -------------------- Utility --------------------
function normalizeN8NResponse(n8nData, traceId) {
  if (!n8nData || typeof n8nData !== "object") {
    log("warn", "normalizeN8NResponse: invalid n8nData", { traceId, n8nData });
    return {};
  }

  // n8n wrapped response: { output: { ... } }
  if (n8nData.output && typeof n8nData.output === "object") {
    log("info", "normalizeN8NResponse: detected wrapped output response", {
      traceId,
      keys: Object.keys(n8nData.output),
    });
    return n8nData.output;
  }

  // direct response: { reply, flags }
  log("info", "normalizeN8NResponse: detected flat response", {
    traceId,
    keys: Object.keys(n8nData),
  });
  return n8nData;
}

function parseCsvList(v) {
  if (!v || typeof v !== "string") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickFirst3(arr) {
  return (arr || []).filter(Boolean).slice(0, 3);
}

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function normalizePhone(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function delayForHumanFeel(text, { traceId } = {}) {
  const ms = Math.min(3000, 400 + Math.floor((text || "").length / 30) * 300);
  log("debug", "delayForHumanFeel", { traceId, ms, textLen: (text || "").length });
  await sleep(ms);
}

// -------------------- Start --------------------
log("info", "Initializing WhatsApp client…");
client.initialize();
