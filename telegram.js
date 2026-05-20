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

// Lovable Supabase project — where sentinel-commander edge function lives
const LOVABLE_URL = "https://cequizgvuhdrgnszjyar.supabase.co";
const LOVABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlcXVpemd2dWhkcmduc3pqeWFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NTc1NjQsImV4cCI6MjA5MjUzMzU2NH0.6p7kjibpP_GvMrixSTy_4B1POKrzREgIyyfstdHEysQ";

// Nigeria state bounding boxes [minLng, minLat, maxLng, maxLat]
const NGA_STATE_BBOX = {
  "abia":        [7.01,4.72,8.05,5.87],  "adamawa":    [11.5,7.20,14.4,11.0],
  "akwa ibom":   [7.10,4.50,8.50,6.00],  "anambra":    [6.58,5.68,7.42,6.77],
  "bauchi":      [8.69,9.18,11.6,12.3],  "bayelsa":    [5.54,4.10,6.79,5.42],
  "benue":       [7.38,6.10,10.0,8.65],  "borno":      [11.5,9.80,15.2,13.9],
  "cross river": [7.85,4.28,9.73,7.18],  "delta":      [5.07,4.93,7.00,6.63],
  "ebonyi":      [7.62,5.56,8.62,6.77],  "edo":        [5.06,5.74,6.73,7.70],
  "ekiti":       [4.88,7.38,5.88,8.27],  "enugu":      [6.98,5.96,8.02,7.19],
  "fct":         [6.77,8.34,7.68,9.35],  "abuja":      [6.77,8.34,7.68,9.35],
  "gombe":       [10.0,9.10,12.4,11.5],  "imo":        [6.74,4.97,7.72,5.98],
  "jigawa":      [8.42,11.2,10.8,13.5],  "kaduna":     [6.08,9.00,9.04,11.4],
  "kano":        [7.68,11.1,9.51,12.8],  "katsina":    [6.60,11.7,9.47,14.0],
  "kebbi":       [3.63,10.1,6.82,13.2],  "kogi":       [5.94,6.68,8.00,8.88],
  "kwara":       [3.73,7.72,6.88,9.77],  "lagos":      [2.69,6.35,4.00,6.70],
  "nasarawa":    [7.12,7.52,9.65,9.09],  "niger":      [3.28,8.00,7.17,11.3],
  "ogun":        [2.69,6.70,4.03,7.80],  "ondo":       [4.18,5.75,6.04,7.85],
  "osun":        [4.12,7.12,5.50,8.24],  "oyo":        [2.82,7.05,4.80,9.07],
  "plateau":     [7.82,8.22,10.6,10.8],  "rivers":     [6.52,4.10,8.03,5.88],
  "sokoto":      [4.10,12.4,6.84,14.2],  "taraba":     [9.17,6.45,12.8,9.55],
  "yobe":        [10.3,10.5,15.1,13.9],  "zamfara":    [5.39,11.2,7.78,13.2],
};

const RISK_COLOR = {
  CRITICAL: "#CC0000",
  HIGH:     "#CC6600",
  MODERATE: "#CCAA00",
  LOW:      "#006600",
};

// Emergency keywords — false positive acceptable, missing real SOS is not
const SOS_PATTERNS = [
  /\bambush(ed|ing)?\b/i,
  /\bunder\s+fire\b/i,
  /\battack(ed|ing|ers?)?\b/i,
  /\bmayday\b/i,
  /\bS\.?O\.?S\b/,
  /\bcasualt(y|ies)\b/i,
  /\blast\s+message\b/i,
  /\bman\s+down\b/i,
  /\btaking\s+fire\b/i,
  /\bbeing\s+shot\b/i,
  /\bhelp\s+us\b/i,
  /\bwe('re|\s+are)\s+(surrounded|pinned|hit)\b/i,
];

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
  const audioBuffer = Buffer.from(base64, "base64");
  const form        = new FormData();
  form.append("file",  new Blob([audioBuffer], { type: mimeType || "audio/ogg" }), "audio.ogg");
  form.append("model", "whisper-large-v3");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method:  "POST",
    headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY },
    body:    form,
  });

  if (!res.ok) throw new Error("Whisper error " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return { text: data.text || "", conf: 0.9 };
}

async function extractIntent(transcript) {
  const sys  = "Nigerian Navy C4ISR analyst. Extract commander intent, emergency flags, and which platform modules are relevant. Return ONLY valid JSON. No markdown.";
  const intentOpts = "VESSEL_REPORT|AREA_SCAN|THREAT_ALERT|STATUS_REQUEST|EMERGENCY_SOS|HUMINT_SUBMIT|UNKNOWN";
  const moduleOpts = "MARITIME_QUERY|SENTINEL_SWEEP|SOCMINT|ENTITY_LOOKUP|HUMINT_SUBMIT";
  const user = [
    "TRANSCRIPT: " + JSON.stringify(transcript),
    "",
    "Return ONLY valid JSON (no extra keys):",
    "{",
    "  \"intent\": \"" + intentOpts + "\",",
    "  \"is_sos\": false,",
    "  \"modules\": [\"only relevant ones from: " + moduleOpts + "\"],",
    "  \"entities\": {\"vessels\": [], \"coords\": [], \"threat_type\": \"\", \"time_ref\": \"\", \"action\": \"\"},",
    "  \"summary\": \"<one sentence>\",",
    "  \"confidence\": 0.9",
    "}",
  ].join("\n");

  const raw = await qwen("qwen2.5-72b-instruct", [
    { role: "system", content: sys  },
    { role: "user",   content: user },
  ], 700);

  try   { return safeJson(raw); }
  catch {
    return {
      intent: "UNKNOWN", is_sos: false, modules: [],
      entities: {}, summary: transcript.slice(0, 120), confidence: 0.3,
    };
  }
}

function quickSosCheck(text) {
  return SOS_PATTERNS.some((p) => p.test(text));
}

function genRefNumber() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return "HUMINT-" + d + "-" + r;
}

async function extractHumint(transcript) {
  const sys = "Nigerian Army/Navy HUMINT analyst. Extract all actionable intelligence entities from field report. Return ONLY valid JSON. No markdown.";
  const user = [
    "TRANSCRIPT: " + JSON.stringify(transcript),
    "",
    "Return ONLY valid JSON:",
    "{",
    "  \"persons\":    [{\"name\":\"\",\"description\":\"\",\"role\":\"\",\"location\":\"\"}],",
    "  \"locations\":  [{\"name\":\"\",\"description\":\"\",\"grid_ref\":\"\"}],",
    "  \"vehicles\":   [{\"type\":\"\",\"identifier\":\"\",\"description\":\"\"}],",
    "  \"groups\":     [{\"name\":\"\",\"type\":\"\",\"size\":\"\",\"location\":\"\"}],",
    "  \"activities\": [{\"description\":\"\",\"time_ref\":\"\",\"location\":\"\"}],",
    "  \"weapons\":    [{\"type\":\"\",\"description\":\"\"}],",
    "  \"summary\":    \"<one sentence>\",",
    "  \"threat_level\": \"CRITICAL|HIGH|MODERATE|LOW\",",
    "  \"confidence\":   0.9",
    "}",
  ].join("\n");

  const raw = await qwen("qwen2.5-72b-instruct", [
    { role: "system", content: sys  },
    { role: "user",   content: user },
  ], 1000);

  try { return safeJson(raw); }
  catch {
    return {
      persons: [], locations: [], vehicles: [], groups: [],
      activities: [], weapons: [],
      summary: transcript.slice(0, 120),
      threat_level: "MODERATE", confidence: 0.3,
    };
  }
}

async function extractSentinelParams(transcript) {
  const sys  = "Nigerian military analyst. Extract satellite sweep parameters from the voice report. Return ONLY valid JSON.";
  const user = [
    "TRANSCRIPT: " + JSON.stringify(transcript),
    "",
    "Return ONLY valid JSON:",
    "{",
    "  \"location\": \"<place name>\",",
    "  \"state\": \"<Nigerian state or empty string>\",",
    "  \"lga\": \"<LGA name or empty string>\",",
    "  \"threat_type\": \"ILLEGAL_MINING|ENCAMPMENT|FOREST_CLEARANCE|FLOODING|HUMAN_TRACKING\",",
    "  \"days_back\": 30",
    "}",
  ].join("\n");

  const raw = await qwen("qwen2.5-72b-instruct", [
    { role: "system", content: sys  },
    { role: "user",   content: user },
  ], 400);

  try { return safeJson(raw); }
  catch {
    return { location: "Nigeria", state: "", lga: "", threat_type: "ENCAMPMENT", days_back: 30 };
  }
}

function resolveBbox(params) {
  const key = (params.state || params.location || "").toLowerCase().trim();
  for (const [name, bbox] of Object.entries(NGA_STATE_BBOX)) {
    if (key.includes(name) || name.includes(key)) return bbox;
  }
  return [2.5, 4.0, 14.7, 14.0]; // Nigeria fallback
}

async function callSentinelCommander(params) {
  const today   = new Date().toISOString().slice(0, 10);
  const daysAgo = new Date(Date.now() - (params.days_back || 30) * 86400000).toISOString().slice(0, 10);
  const bbox    = resolveBbox(params);

  const payload = {
    input_mode:   "POLYGON",
    bbox,
    date1:        daysAgo,
    date2:        today,
    threat_type:  params.threat_type || "ENCAMPMENT",
    lga:          params.lga   || undefined,
    state:        params.state || undefined,
  };

  const res = await fetch(LOVABLE_URL + "/functions/v1/sentinel-commander", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + LOVABLE_KEY,
      "apikey":        LOVABLE_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error("Sentinel error " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  if (data?.error === "MPC_UPSTREAM_UNAVAILABLE" || data?.degraded) {
    throw new Error(data?.hint || "Microsoft Planetary Computer temporarily unavailable. Retry in 60s.");
  }
  if (data?.error) throw new Error(data.error);
  return data;
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

  // 1. Security gate — silent block for unregistered senders
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

  // 2. Audit log entry
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
    // 3. Download audio
    const filePath                 = await getFilePath(fileId);
    const { base64, mimeType: dm } = await downloadAudio(filePath, mimeType);

    // 4. Transcribe
    const { text, conf } = await transcribe(base64, dm);
    console.log("[Pipeline] Transcript conf=" + conf + " | " + text.slice(0, 80));

    // 5. SOS CHECK — fires before any other step (LIFE-SAFETY FIRST)
    const fastSos = quickSosCheck(text);

    // 6. Write field_request immediately for C2 visibility (Realtime notifies dashboard)
    let fieldReqId = null;
    try {
      const { data: fr, error: frErr } = await db
        .from("field_requests")
        .insert({
          source_id:   senderId,
          source_name: cdrName,
          unit:        cdrUnit,
          channel:     "TELEGRAM",
          transcript:  text,
          status:      "PROCESSING",
          is_sos:      fastSos,
          risk_level:  fastSos ? "CRITICAL" : "MODERATE",
          log_id:      logId,
        })
        .select("id")
        .single();
      if (frErr) console.warn("[FieldReq] Insert failed:", frErr.message);
      else fieldReqId = fr?.id;
    } catch (e) { console.warn("[FieldReq] Insert threw:", e.message); }

    // 7. SOS immediate response — reply before SITREP pipeline completes
    if (fastSos) {
      await sendText(chatId, "EMERGENCY ACKNOWLEDGED. C2 notified. Stay on comms.");
      console.warn("[SOS] EMERGENCY DETECTED - " + cdrName + " | " + text.slice(0, 120));
    }

    // 8. Intent extraction (parallel with SOS — both use transcript)
    const intent = await extractIntent(text);
    console.log("[Pipeline] Intent: " + intent.intent + " | SOS: " + (intent.is_sos || fastSos));

    // Confirm and consolidate SOS flag
    const isSos = fastSos || Boolean(intent.is_sos) || intent.intent === "EMERGENCY_SOS";

    // 9. Update field_request with intent data
    if (fieldReqId) {
      await db.from("field_requests").update({
        intent:         intent.intent,
        summary:        intent.summary,
        is_sos:         isSos,
        risk_level:     isSos ? "CRITICAL" : "MODERATE",
        modules_queued: intent.modules || [],
        status:         isSos ? "SOS_ACTIVE" : "PROCESSING",
      }).eq("id", fieldReqId);
    }

    // 10. HUMINT extraction (runs when intent or module routing indicates intel submission)
    let humintRef      = null;
    let humintEntities = null;
    const isHumint = intent.intent === "HUMINT_SUBMIT"
      || (Array.isArray(intent.modules) && intent.modules.includes("HUMINT_SUBMIT"));

    if (isHumint) {
      humintEntities = await extractHumint(text);
      humintRef      = genRefNumber();
      try {
        await db.from("raw_intelligence").insert({
          source_id:        senderId,
          source_name:      cdrName,
          unit:             cdrUnit,
          channel:          "TELEGRAM",
          transcript:       text,
          entities:         humintEntities,
          ref_number:       humintRef,
          threat_level:     humintEntities.threat_level || "MODERATE",
          confidence:       humintEntities.confidence   || 0.5,
          field_request_id: fieldReqId,
        });
        console.log("[HUMINT] Stored - " + humintRef);
        await sendText(chatId, "HUMINT received. Ref: " + humintRef + ". Processing SITREP...");
      } catch (e) {
        console.warn("[HUMINT] Write failed:", e.message);
      }
    }

    // 11. SENTINEL SWEEP — runs when commander requests satellite imagery
    let sentinelResult = null;
    const isSentinel = intent.intent === "AREA_SCAN"
      || (Array.isArray(intent.modules) && intent.modules.includes("SENTINEL_SWEEP"));

    if (isSentinel) {
      try {
        await sendText(chatId, "SENTINEL SWEEP initiated. Querying Planetary Computer satellite archive... ETA 30-60 seconds.");
        const sentinelParams = await extractSentinelParams(text);
        console.log("[SENTINEL] Params:", JSON.stringify(sentinelParams));
        sentinelResult = await callSentinelCommander(sentinelParams);
        const score = sentinelResult.threatScore ?? sentinelResult.results?.[0]?.threatScore ?? "N/A";
        const sev   = sentinelResult.severity ?? sentinelResult.results?.[0]?.severity ?? "LOW";
        await sendText(chatId, "SENTINEL COMPLETE. Threat score: " + score + " | Severity: " + sev + ". Generating SITREP...");
        console.log("[SENTINEL] Done - score=" + score + " sev=" + sev);
      } catch (e) {
        console.warn("[SENTINEL] Failed:", e.message);
        await sendText(chatId, "SENTINEL SWEEP error: " + e.message.slice(0, 160) + ". Generating text SITREP from voice report.");
      }
    }

    // 12. SITREP generation — enrich with HUMINT and/or Sentinel data
    const sitrepIntent = {
      ...intent,
      ...(humintEntities ? { humint: humintEntities } : {}),
      ...(sentinelResult  ? { sentinel: {
        brief:          sentinelResult.brief ?? sentinelResult.results?.[0]?.brief,
        recommendation: sentinelResult.recommendation ?? sentinelResult.results?.[0]?.recommendation,
        threat_score:   sentinelResult.threatScore ?? sentinelResult.results?.[0]?.threatScore,
        severity:       sentinelResult.severity ?? sentinelResult.results?.[0]?.severity,
        scene1_date:    sentinelResult.tiles?.scene1?.date ?? sentinelResult.results?.[0]?.tiles?.scene1?.date,
        scene2_date:    sentinelResult.tiles?.scene2?.date ?? sentinelResult.results?.[0]?.tiles?.scene2?.date,
        collection:     sentinelResult.collection,
      }} : {}),
    };
    const sitrep = await makeSitrep(cdrName, cdrUnit, text, sitrepIntent);
    if (isSos) sitrep.risk_level = "CRITICAL";
    if (sentinelResult && sentinelResult.severity === "CRITICAL") sitrep.risk_level = "CRITICAL";

    // 13. PDF build
    const pdf      = await buildPdf(sitrep);
    const filename = "SITREP_" + sitrep.dtg.slice(0, 10) + "_" + sitrep.risk_level + ".pdf";
    const note     = conf < 0.75 ? " [LOW CONFIDENCE - VERIFY]" : "";
    const humintLine = humintRef ? "\n\nHUMINT REF: " + humintRef : "";
    const caption  = "SITREP " + sitrep.risk_level + " | " + sitrep.subject
      + humintLine
      + "\n\n" + sitrep.assessment.slice(0, 220)
      + "\n\nACTION: " + sitrep.action.slice(0, 140) + note;

    // 14. Deliver PDF
    await sendPdf(chatId, pdf, filename, caption);

    // 14. Email (optional)
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

    // 15. Finalise audit log
    if (logId) {
      await db.from("commander_query_log").update({
        transcript:     text,
        intent:         intent.intent,
        status:         "DELIVERED",
        sitrep_summary: sitrep.assessment.slice(0, 500),
        risk_level:     sitrep.risk_level,
      }).eq("id", logId);
    }

    // 16. Close field_request
    if (fieldReqId) {
      await db.from("field_requests").update({
        status:     isSos ? "SOS_ACTIVE" : "DELIVERED",
        risk_level: sitrep.risk_level,
      }).eq("id", fieldReqId);
    }

    console.log("[Pipeline] Done - " + sitrep.risk_level + " - " + cdrName);

  } catch (err) {
    console.error("[Pipeline] Fatal:", err.message);
    await sendText(chatId, "Processing failed: " + err.message.slice(0, 120) + ". Contact duty officer. Ref: " + (logId || "unknown"));
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
  console.log("[KXS] Groq:          " + Boolean(process.env.GROQ_API_KEY));
});
