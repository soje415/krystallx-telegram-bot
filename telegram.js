import express from "express";
import { createRequire } from "module";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit");

const app = express();
app.use(express.json());

// ── Clients ───────────────────────────────────────────────────────

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Constants ─────────────────────────────────────────────────────

const TG   = "https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN;
const QWEN = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

const RISK_COLOR = {
  CRITICAL: "#CC0000",
  HIGH:     "#CC6600",
  MODERATE: "#CCAA00",
  LOW:      "#006600",
};

// ================================================================
// TELEGRAM HELPERS
// ================================================================

async function getFilePath(fileId) {
  const res  = await fetch(TG + "/getFile?file_id=" + encodeURIComponent(fileId));
  const body = await res.json();
  if (!body.ok || !body.result?.file_path) {
    throw new Error("getFile failed for " + fileId);
  }
  return body.result.file_path;
}

async function downloadAudio(filePath, mimeType) {
  const url = "https://api.telegram.org/file/bot" + process.env.TELEGRAM_BOT_TOKEN + "/" + filePath;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Audio download failed: " + res.status);
  const buf   = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin     = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { base64: btoa(bin), mimeType: mimeType || "audio/ogg" };
}

async function sendText(chatId, text) {
  await fetch(TG + "/sendMessage", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text: text }),
  });
}

async function sendPdf(chatId, buf, filename, caption) {
  const form = new FormData();
  form.append("chat_id",  String(chatId));
  form.append("caption",  caption);
  form.append("document", new Blob([buf], { type: "application/pdf" }), filename);
  const res = await fetch(TG + "/sendDocument", { method: "POST", body: form });
  if (!res.ok) console.warn("[TG] sendDocument:", await res.text());
}

// ================================================================
// QWEN AI HELPERS
// ================================================================

async function qwen(model, messages, maxTokens) {
  const res = await fetch(QWEN, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + process.env.QWEN_API_KEY,
    },
    body: JSON.stringify({
      model:      model,
      messages:   messages,
      max_tokens: maxTokens || 1500,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Qwen error " + res.status + ": " + txt.slice(0, 200));
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function safeJson(raw) {
  const s = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(s);
}

async function transcribe(base64, mimeType) {
  const fmt    = (mimeType || "audio/ogg").split("/")[1] || "ogg";
  const prompt = "Transcribe this voice message. Nigerian Navy commander. Return ONLY valid JSON on one line: {\"transcript\":\"<text>\",\"confidence\":<number>}";
  const raw = await qwen("qwen2-audio-instruct", [
    {
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: "data:" + mimeType + ";base64," + base64, format: fmt } },
        { type: "text", text: prompt },
      ],
    },
  ], 800);
  try {
    const p = safeJson(raw);
    return { text: p.transcript || raw, conf: typeof p.confidence === "number" ? p.confidence : 0.5 };
  } catch {
    return { text: raw.trim(), conf: 0.4 };
  }
}

async function extractIntent(transcript) {
  const sys  = "Nigerian Navy intelligence analyst. Extract commander intent. Return ONLY valid JSON. No markdown.";
  const user = "TRANSCRIPT: " + JSON.stringify(transcript) + "\n\nReturn ONLY:\n{\"intent\":\"VESSEL_REPORT|AREA_SCAN|THREAT_ALERT|STATUS_REQUEST|UNKNOWN\",\"entities\":{\"vessels\":[],\"coords\":[],\"threat_type\":\"\",\"time_ref\":\"\",\"action\":\"\"},\"summary\":\"<one sentence>\",\"confidence\":0.9}";
  const raw  = await qwen("qwen2.5-72b-instruct", [
    { role: "system", content: sys  },
    { role: "user",   content: user },
  ], 600);
  try   { return safeJson(raw); }
  catch { return { intent: "UNKNOWN", entities: {}, summary: transcript.slice(0, 120), confidence: 0.3 }; }
}

async function makeSitrep(name, unit, transcript, intent) {
  const dtg = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "Z";
  const sys  = "AI intelligence officer for KrystallX Shield C4ISR Nigeria. Write NATO-format SITREPs. Return ONLY valid JSON. No markdown.";
  const user = [
    "COMMANDER: " + name + " (" + unit + ")",
    "TRANSCRIPT: " + JSON.stringify(transcript),
    "INTENT: " + JSON.stringify(intent),
    "",
    "Return ONLY valid JSON:",
    "{\"classification\":\"CONFIDENTIAL\",\"dtg\":\"" + dtg + "\",\"from\":\"" + unit + "\",\"to\":\"NNS BEECROFT / C4ISR OPS CENTRE\",\"subject\":\"<subject>\",\"situation\":\"<para>\",\"enemy_forces\":\"<para>\",\"friendly_forces\":\"<para>\",\"assessment\":\"<para>\",\"action\":\"<para>\",\"risk_level\":\"CRITICAL|HIGH|MODERATE|LOW\",\"coordinating_info\":\"<coords>\"}",
  ].join("\n");

  const raw = await qwen("qwen2.5-72b-instruct", [
    { role: "system", content: sys  },
    { role: "user",   content: user },
  ], 1500);

  try { return safeJson(raw); }
  catch {
    const d2 = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "Z";
    return {
      classification: "CONFIDENTIAL", dtg: d2, from: unit,
      to: "NNS BEECROFT / C4ISR OPS CENTRE",
      subject: "VOICE REPORT - AI PARSE ERROR",
      situation: transcript, enemy_forces: "ASSESSMENT PENDING",
      friendly_forces: "NOT SPECIFIED",
      assessment: "AI parsing failed. Manual review required.",
      action: "Duty officer to review raw transcript.",
      risk_level: "MODERATE", coordinating_info: "",
    };
  }
}

// ================================================================
// PDF BUILDER
// ================================================================

function buildPdf(s) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data",  (c) => chunks.push(c));
    doc.on("end",   ()  => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const color = RISK_COLOR[s.risk_level] || "#333333";
    const w     = doc.page.width - 100;

    doc.rect(50, 40, w, 22).fill(color);
    doc.fillColor("white").fontSize(10).font("Helvetica-Bold")
       .text(s.classification + " - RISK: " + s.risk_level, 50, 46, { width: w, align: "center" });

    doc.moveDown(2).fillColor("#000000").fontSize(15).font("Helvetica-Bold")
       .text("KRYSTALLX SHIELD - C4ISR INTELLIGENCE REPORT", { align: "center" });
    doc.fontSize(9).font("Helvetica").fillColor("#555555")
       .text("Sovereignty Shield Platform - Nigerian Navy Intelligence", { align: "center" });

    doc.moveDown(0.5)
       .moveTo(50, doc.y).lineTo(50 + w, doc.y).strokeColor("#aaaaaa").stroke()
       .moveDown(0.5);

    for (const [label, value] of [["DTG", s.dtg], ["FROM", s.from], ["TO", s.to], ["SUBJECT", s.subject]]) {
      doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold").text(label + ": ", { continued: true });
      doc.font("Helvetica").text(value || "");
    }

    doc.moveDown(0.5)
       .moveTo(50, doc.y).lineTo(50 + w, doc.y).strokeColor("#aaaaaa").stroke()
       .moveDown(0.8);

    for (const [heading, body] of [
      ["1. SITUATION",       s.situation],
      ["2. ENEMY FORCES",    s.enemy_forces],
      ["3. FRIENDLY FORCES", s.friendly_forces],
      ["4. ASSESSMENT",      s.assessment],
      ["5. ACTION",          s.action],
    ]) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000").text(heading);
      doc.font("Helvetica").fillColor("#222222").text(body || "", { indent: 10 });
      doc.moveDown(0.7);
    }

    if (s.coordinating_info) {
      doc.moveTo(50, doc.y).lineTo(50 + w, doc.y).strokeColor("#aaaaaa").stroke().moveDown(0.4);
      doc.font("Helvetica-Bold").text("COORDINATING INFORMATION:");
      doc.font("Helvetica").text(s.coordinating_info, { indent: 10 });
      doc.moveDown(0.7);
    }

    doc.moveDown(0.5).font("Helvetica-Bold").fontSize(13).fillColor(color)
       .text("THREAT ASSESSMENT: " + s.risk_level, { align: "center" });

    doc.moveDown(1)
       .moveTo(50, doc.y).lineTo(50 + w, doc.y).strokeColor("#aaaaaa").stroke()
       .moveDown(0.4);
    doc.fontSize(8).fillColor("#888888").font("Helvetica")
       .text("KrystallX Shield AI - " + new Date().toUTCString() + " - " + s.classification, { align: "center" });

    doc.end();
  });
}

// ================================================================
// PIPELINE
// ================================================================

async function runPipeline(msg, senderName) {
  const chatId   = msg.chat.id;
  const senderId = String(msg.from?.id || chatId);
  const fileId   = msg.voice?.file_id || msg.audio?.file_id || "";
  const mimeType = msg.voice?.mime_type || msg.audio?.mime_type || "audio/ogg";

  // 1. Security check
  const { data: src } = await db
    .from("humint_sources")
    .select("id, display_name, rank, unit, email, active")
    .eq("telegram_user_id", senderId)
    .single();

  if (!src || !src.active) {
    console.warn("[Pipeline] Unregistered: " + senderId + " (" + senderName + ")");
    await db.from("commander_query_log").insert({
      source_id:     senderId,
      source_name:   senderName,
      channel:       "TELEGRAM",
      audio_file_id: fileId,
      status:        "QUARANTINED",
      error_detail:  "Sender not in humint_sources",
    });
    return;
  }

  const cdrName = ((src.rank || "") + " " + src.display_name).trim();
  const cdrUnit = src.unit || "UNKNOWN UNIT";

  // 2. Log entry
  const { data: logRow } = await db
    .from("commander_query_log")
    .insert({
      source_id:     senderId,
      source_name:   cdrName,
      channel:       "TELEGRAM",
      audio_file_id: fileId,
      status:        "PROCESSING",
    })
    .select("id")
    .single();
  const logId = logRow?.id;

  await sendText(chatId, "Voice note received. Analysing report from " + cdrName + "... SITREP incoming.");

  try {
    // 3. Download
    const filePath                 = await getFilePath(fileId);
    const { base64, mimeType: dm } = await downloadAudio(filePath, mimeType);

    // 4. Transcribe
    const { text, conf } = await transcribe(base64, dm);
    console.log("[Pipeline] Transcript conf=" + conf + " | " + text.slice(0, 80));

    // 5. Intent
    const intent = await extractIntent(text);
    console.log("[Pipeline] Intent: " + intent.intent);

    // 6. SITREP
    const sitrep = await makeSitrep(cdrName, cdrUnit, text, intent);

    // 7. PDF
    const pdf      = await buildPdf(sitrep);
    const filename = "SITREP_" + sitrep.dtg.slice(0, 10) + "_" + sitrep.risk_level + ".pdf";
    const note     = conf < 0.75 ? " [LOW CONFIDENCE - VERIFY]" : "";
    const caption  = "SITREP " + sitrep.risk_level + " | " + sitrep.subject + "\n\n" + sitrep.assessment.slice(0, 250) + "\n\nACTION: " + sitrep.action.slice(0, 150) + note;

    // 8. Deliver
    await sendPdf(chatId, pdf, filename, caption);

    // 9. Email (optional)
    if (src.email && process.env.RESEND_API_KEY) {
      try {
        const mailer  = new Resend(process.env.RESEND_API_KEY);
        const fromAdr = process.env.RESEND_FROM_EMAIL || "sitrep@krystallxshield.ng";
        await mailer.emails.send({
          from:        "KrystallX Shield <" + fromAdr + ">",
          to:          [src.email],
          subject:     "[" + sitrep.risk_level + "] SITREP: " + sitrep.subject,
          html:        "<p>Commander " + cdrName + ",</p><p>Risk: <b>" + sitrep.risk_level + "</b></p><p>" + sitrep.assessment + "</p><p><b>Action:</b> " + sitrep.action + "</p>",
          attachments: [{ filename: filename, content: pdf.toString("base64") }],
        });
        console.log("[Pipeline] Email sent to " + src.email);
      } catch (e) { console.warn("[Pipeline] Email failed:", e.message); }
    }

    // 10. Update log
    if (logId) {
      await db.from("commander_query_log").update({
        transcript:     text,
        intent:         intent.intent,
        status:         "DELIVERED",
        sitrep_summary: sitrep.assessment.slice(0, 500),
        risk_level:     sitrep.risk_level,
      }).eq("id", logId);
    }

    console.log("[Pipeline] Done - " + sitrep.risk_level + " - " + cdrName);

  } catch (err) {
    console.error("[Pipeline] Fatal:", err.message);
    await sendText(chatId, "Processing failed: " + err.message.slice(0, 120) + ". Contact duty officer.");
    if (logId) {
      await db.from("commander_query_log")
        .update({ status: "FAILED", error_detail: err.message.slice(0, 500) })
        .eq("id", logId);
    }
  }
}

// ================================================================
// ROUTES
// ================================================================

app.get("/", (_req, res) => {
  res.json({
    service:   "KrystallX Shield - Telegram Intel Bot",
    status:    "ONLINE",
    bot_ready: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    timestamp: new Date().toISOString(),
  });
});

app.post("/webhook/telegram", (req, res) => {
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    res.sendStatus(403);
    return;
  }
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.voice && !msg?.audio) return;
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ")
    || msg.from?.username || "Unknown";
  runPipeline(msg, name).catch((e) => console.error("[Webhook] Unhandled:", e.message));
});

app.get("/webhook/telegram/info", async (_req, res) => {
  try {
    const r = await fetch(TG + "/getMe");
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// START
// ================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("[KXS Telegram Bot] Live on port " + PORT);
  console.log("[KXS] Bot token set: " + Boolean(process.env.TELEGRAM_BOT_TOKEN));
  console.log("[KXS] Supabase:      " + (process.env.SUPABASE_URL || "NOT SET"));
  console.log("[KXS] Qwen:          " + Boolean(process.env.QWEN_API_KEY));
});
