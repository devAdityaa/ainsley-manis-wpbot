/**
 * WhatsApp Cloud API -> n8n -> WhatsApp bot
 *
 * Inbound: Meta Webhooks (messages)
 * Outbound: Graph API /<PHONE_NUMBER_ID>/messages
 *
 * Docs:
 * - Messages endpoint: POST /<PHONE_NUMBER_ID>/messages
 * - Media upload: POST /<PHONE_NUMBER_ID>/media
 * - Webhook signature: X-Hub-Signature-256 (HMAC SHA256 with App Secret)
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// -------------------- Logger --------------------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL =
  (process.env.LOG_LEVEL || (process.env.DEBUG ? "debug" : "info")).toLowerCase();
const LOG_LEVEL_NUM = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return '"<non-serializable>"'; }
}
function log(level, msg, meta) {
  const lvl = (level || "info").toLowerCase();
  const lvlNum = LEVELS[lvl] ?? LEVELS.info;
  if (lvlNum < LOG_LEVEL_NUM) return;
  const line = `[${ts()}] [${lvl.toUpperCase()}] ${msg}`;
  if (meta !== undefined) console.log(line, safeJson(meta));
  else console.log(line);
}
function makeTraceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled Promise rejection", { reason: String(reason), stack: reason?.stack });
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

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || !VERIFY_TOKEN) {
  console.error("❌ Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WEBHOOK_VERIFY_TOKEN");
  process.exit(1);
}
if (!META_APP_SECRET) {
  log("warn", "META_APP_SECRET missing; webhook signature validation will be skipped (not recommended)");
}

const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 8000);

function parseCsvList(v) {
  if (!v || typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
function normalizePhone(s) {
  return String(s || "").replace(/[^\d]/g, "");
}
const PRICE_IMAGES = parseCsvList(process.env.PRICE_IMAGES);
const REVIEW_IMAGES = parseCsvList(process.env.REVIEW_IMAGES);
const BENEFITS_IMAGES = parseCsvList(process.env.BENEFITS_IMAGES);
const PAYMENT_QR_IMAGE = process.env.PAYMENT_QR_IMAGE;
const ALLOWLIST = parseCsvList(process.env.ALLOWLIST).map(normalizePhone);

log("info", "Bot starting with config", {
  LOG_LEVEL,
  COOLDOWN_MS,
  PRICE_IMAGES_count: PRICE_IMAGES.length,
  REVIEW_IMAGES_count: REVIEW_IMAGES.length,
  BENEFITS_IMAGES_count: BENEFITS_IMAGES.length,
  ALLOWLIST_enabled: ALLOWLIST.length > 0,
  ALLOWLIST_count: ALLOWLIST.length,
  GRAPH_API_VERSION,
  PHONE_NUMBER_ID,
});

// -------------------- Small utilities --------------------
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
async function delayForHumanFeel(text, { traceId } = {}) {
  const ms = Math.min(3000, 400 + Math.floor((text || "").length / 30) * 300);
  log("debug", "delayForHumanFeel", { traceId, ms, textLen: (text || "").length });
  await sleep(ms);
}
function pickFirst3(arr) { return (arr || []).filter(Boolean).slice(0, 3); }
function isHttpUrl(s) { return typeof s === "string" && /^https?:\/\//i.test(s); }
function mimeFromExt(ext) {
  const e = (ext || "").toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".gif") return "image/gif";
  return "application/octet-stream";
}

// -------------------- WhatsApp Cloud API client --------------------
function graphUrl(pathname) {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}${pathname}`;
}

async function waSendText(to, body, { traceId } = {}) {
  const url = graphUrl(`/${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  log("info", "WA send text", { traceId, to, bodyPreview: body.slice(0, 160), url });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`WA messages error ${resp.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function waSendImageByLink(to, link, { traceId } = {}) {
  const url = graphUrl(`/${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link },
  };

  log("info", "WA send image(link)", { traceId, to, link });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`WA image(link) error ${resp.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function waSendImageById(to, mediaId, { traceId } = {}) {
  const url = graphUrl(`/${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId },
  };

  log("info", "WA send image(id)", { traceId, to, mediaId });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`WA image(id) error ${resp.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// Local media upload cache: absPath -> { mediaId, mime, filename, bytes, uploadedAt }
const mediaCache = new Map();

async function waUploadLocalImage(absPath, { traceId } = {}) {
  const stat = fs.statSync(absPath);
  const ext = path.extname(absPath);
  const mime = mimeFromExt(ext);
  const filename = path.basename(absPath);

  const cached = mediaCache.get(absPath);
  if (
    cached &&
    cached.bytes === stat.size &&
    cached.filename === filename &&
    cached.mime === mime
  ) {
    log("debug", "WA upload cache hit", { traceId, absPath, mediaId: cached.mediaId });
    return cached.mediaId;
  }

  const url = graphUrl(`/${PHONE_NUMBER_ID}/media`);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", fs.createReadStream(absPath), { filename, contentType: mime });

  log("info", "WA uploading media", { traceId, absPath, mime, bytes: stat.size, url });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`WA media upload error ${resp.status}: ${text.slice(0, 500)}`);

  const data = JSON.parse(text);
  const mediaId = data.id;
  if (!mediaId) throw new Error(`WA media upload response missing id: ${text.slice(0, 300)}`);

  mediaCache.set(absPath, { mediaId, mime, filename, bytes: stat.size, uploadedAt: Date.now() });
  log("info", "WA media uploaded", { traceId, absPath, mediaId });

  return mediaId;
}

// -------------------- Per-user queue + cooldown (same logic) --------------------
const sendQueues = new Map();
/**
 * Record: { lastCall: number, queue: Array<Task>, processing: boolean }
 * Task: { userId, waId, messageText, resolve, reject, traceId }
 */
function getQueueRecord(userId) {
  if (!sendQueues.has(userId)) {
    sendQueues.set(userId, { lastCall: 0, queue: [], processing: false });
    log("debug", "Created new queue record", { userId });
  }
  return sendQueues.get(userId);
}

function scheduleSendToN8N({ userId, waId, messageText, traceId }) {
  const record = getQueueRecord(userId);
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const task = { userId, waId, messageText, resolve, reject, traceId };

    const timeSinceLast = now - record.lastCall;
    const canSendNow = !record.processing && timeSinceLast >= COOLDOWN_MS;

    log("debug", "scheduleSendToN8N called", {
      traceId,
      userId,
      waId,
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
    log("info", "Queue: task queued", { traceId, userId, newQueueLength: record.queue.length });

    if (!record.processing && record.queue.length === 1) {
      const waitTime = Math.max(0, COOLDOWN_MS - timeSinceLast);
      log("debug", "Queue: scheduling first queued task after wait", { traceId, userId, waitTime });

      setTimeout(() => {
        if (!record.processing && record.queue.length > 0) {
          const nextTask = record.queue.shift();
          log("info", "Queue: dequeued task for execution", {
            traceId: nextTask?.traceId,
            userId,
            remainingQueueLength: record.queue.length,
          });
          runSendTask(nextTask, record);
        }
      }, waitTime);
    }
  });
}

async function runSendTask(task, record) {
  record.processing = true;
  const start = Date.now();
  record.lastCall = start;

  log("info", "Queue: runSendTask start", { traceId: task.traceId, userId: task.userId });

  try {
    const data = await sendToN8N(
      { userId: task.userId, waChatId: task.waId, message: task.messageText },
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
          });
          runSendTask(nextTask, record);
        }
      }, waitTime);
    }
  }
}

// -------------------- n8n call (same behavior) --------------------
async function sendToN8N(payload, { traceId } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const startedAt = Date.now();
  log("info", "n8n: sending request", {
    traceId,
    url: N8N_WEBHOOK_URL,
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

    if (!resp.ok) throw new Error(`n8n error ${resp.status}: ${text.slice(0, 500)}`);

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`n8n returned non-JSON: ${text.slice(0, 500)}`); }

    log("debug", "n8n: parsed JSON", { traceId, data });
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// -------------------- Response normalization + routing (same behavior) --------------------
function normalizeN8NResponse(n8nData, traceId) {
  if (!n8nData || typeof n8nData !== "object") {
    log("warn", "normalizeN8NResponse: invalid n8nData", { traceId, n8nData });
    return {};
  }
  if (n8nData.output && typeof n8nData.output === "object") {
    log("info", "normalizeN8NResponse: detected wrapped output response", {
      traceId,
      keys: Object.keys(n8nData.output),
    });
    return n8nData.output;
  }
  log("info", "normalizeN8NResponse: detected flat response", {
    traceId,
    keys: Object.keys(n8nData),
  });
  return n8nData;
}

async function sendImages(to, urlsOrPaths, { traceId, reason } = {}) {
  const list = (urlsOrPaths || []).filter(Boolean).slice(0, 3);
  log("debug", "sendImages called", { traceId, reason, to, list });

  for (const item of list) {
    try {
      if (isHttpUrl(item)) {
        await waSendImageByLink(to, item, { traceId });
      } else {
        const abs = path.isAbsolute(item) ? item : path.join(process.cwd(), item);
        if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
        const mediaId = await waUploadLocalImage(abs, { traceId });
        await waSendImageById(to, mediaId, { traceId });
      }
      await sleep(500);
    } catch (err) {
      log("warn", "⚠️ Failed to send image", {
        traceId,
        reason,
        to,
        item,
        message: err?.message,
        stack: err?.stack,
      });
    }
  }
}

async function handleWebhookResponse({ to, userId, n8nData, traceId }) {
  const data = normalizeN8NResponse(n8nData, traceId);

  const reply =
    typeof data.reply === "string" && data.reply.trim() ? data.reply.trim() : "";
  const flags = data.flags || {};

  const priceFlag = !!flags.priceListOrPromoOffers;
  const learnFlag = !!flags.benefitsAvailable;
  const reviewsFlag = !!flags.userReviewsAndFeedbacks;
  const paymentQrFlag = !!flags.paymentQr;

  const activeFlags = [priceFlag, learnFlag, reviewsFlag, paymentQrFlag].filter(Boolean).length;
  if (activeFlags > 1) {
    log("warn", "Multiple intent flags true; applying priority price > learn > reviews", {
      traceId, userId, flags,
    });
  }

  const imageUrls = data.imageUrls || {};
  const priceImages = pickFirst3(imageUrls.priceListOrPromoOffers || PRICE_IMAGES);
  const reviewImages = pickFirst3(imageUrls.userReviewsAndFeedbacks || REVIEW_IMAGES);
  const learnMoreImages = pickFirst3(imageUrls.benefitsAvailable || BENEFITS_IMAGES);

  const safeReply = reply || "⚠️ AI did not return a reply.";

  log("info", "Routing decision", {
    traceId, userId,
    priceFlag, learnFlag, reviewsFlag, paymentQrFlag,
    replyLen: safeReply.length,
    replyPreview: safeReply.slice(0, 180),
  });

  // 1) Offers / Promo: images -> reply
  if (priceFlag) {
    await sendImages(to, priceImages, { traceId, reason: "price" });
    await delayForHumanFeel(safeReply, { traceId });
    await waSendText(to, safeReply, { traceId });
    return;
  }

  // 2) Learn more: images -> reply
  if (learnFlag) {
    await sendImages(to, learnMoreImages, { traceId, reason: "learn-more" });
    await delayForHumanFeel(safeReply, { traceId });
    await waSendText(to, safeReply, { traceId });
    return;
  }

  // 3) Reviews: images -> reply
  if (reviewsFlag) {
    await sendImages(to, reviewImages, { traceId, reason: "reviews" });
    await delayForHumanFeel(safeReply, { traceId });
    await waSendText(to, safeReply, { traceId });
    return;
  }

  // 4) Payment QR: qr -> reply
  if (paymentQrFlag) {
    if (PAYMENT_QR_IMAGE) {
      await sendImages(to, [PAYMENT_QR_IMAGE], { traceId, reason: "payment-qr" });
    } else {
      log("warn", "PAYMENT_QR_IMAGE not configured", { traceId });
    }
    await delayForHumanFeel(safeReply, { traceId });
    await waSendText(to, safeReply, { traceId });
    return;
  }

  // Default: reply only
  await waSendText(to, safeReply, { traceId });
}

// -------------------- Webhook server --------------------
// Keep a short-lived set of processed message ids (Meta can retry deliveries)
const recentlySeen = new Map(); // id -> ts
function seenBefore(id) {
  const now = Date.now();
  // cleanup
  for (const [k, t] of recentlySeen) if (now - t > 10 * 60 * 1000) recentlySeen.delete(k);
  if (!id) return false;
  if (recentlySeen.has(id)) return true;
  recentlySeen.set(id, now);
  return false;
}

// Capture raw body for signature verification
const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

function verifySignature(req) {
  return true
  if (!META_APP_SECRET) return true; // skipped
  const header = req.get("X-Hub-Signature-256") || "";
  const theirSig = header.startsWith("sha256=") ? header.slice(7) : "";
  if (!theirSig) return false;

  const ourSig = crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");

  // constant-time compare
  try {
    return crypto.timingSafeEqual(Buffer.from(ourSig), Buffer.from(theirSig));
  } catch {
    return false;
  }
}

// Verification handshake
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("info", "Webhook verified");
    return res.status(200).send(String(challenge));
  }
  log("warn", "Webhook verification failed", { mode, tokenPresent: !!token });
  return res.sendStatus(403);
});

// Message delivery
app.post("/webhook", (req, res) => {
  const traceId = makeTraceId();

  if (!verifySignature(req)) {
    log("warn", "Webhook signature invalid", { traceId });
    return res.sendStatus(403);
  }

  // ACK fast (Meta expects quick 200)
  res.sendStatus(200);

  // Process async (but still within this same node process)
  setImmediate(async () => {
    try {
      const body = req.body;

      // Standard WhatsApp webhook shape: entry[] -> changes[] -> value
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // Ignore statuses callbacks
      const msg = value?.messages?.[0];
      if (!msg) {
        log("debug", "No inbound message (maybe status update)", { traceId });
        return;
      }

      if (seenBefore(msg.id)) {
        log("debug", "Duplicate webhook delivery ignored", { traceId, msgId: msg.id });
        return;
      }

      const from = msg.from; // WA ID (digits)
      const userId = normalizePhone(from);

      // Only handle text for parity with your current bot
      const textBody = msg?.text?.body ? String(msg.text.body).trim() : "";
      if (!textBody) {
        log("debug", "Ignored non-text/empty inbound message", {
          traceId,
          from,
          type: msg.type,
        });
        return;
      }

      log("info", "Incoming WhatsApp message", {
        traceId,
        userId,
        from,
        bodyLen: textBody.length,
        bodyPreview: textBody.slice(0, 160),
        msgId: msg.id,
        type: msg.type,
        timestamp: msg.timestamp,
      });

      if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(userId)) {
        log("warn", "Blocked by allowlist", { traceId, userId, from });
        return;
      }

      const n8nData = await scheduleSendToN8N({
        userId,
        waId: from,
        messageText: textBody,
        traceId,
      });

      await handleWebhookResponse({ to: from, userId, n8nData, traceId });
    } catch (err) {
      log("error", "Error processing webhook", { traceId, message: err?.message, stack: err?.stack });
      // best effort user notification (only if we have a 'to' number)
      // (we don't have it here reliably if parsing failed)
    }
  });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => log("info", `✅ Webhook server listening on :${PORT}`));
