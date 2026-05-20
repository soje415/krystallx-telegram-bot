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
    "  \"location\": \"<most specific place name mentioned>\",",
    "  \"state\": \"<Nigerian state name or empty string>\",",
    "  \"lga\": \"<Local Government Area or empty string>\",",
    "  \"ward\": \"<ward name if mentioned, else empty string>\",",
    "  \"district\": \"<district or area name if mentioned, else empty string>\",",
    "  \"threat_type\": \"ILLEGAL_MINING|ENCAMPMENT|FOREST_CLEARANCE|FLOODING|HUMAN_TRACKING\",",
    "  \"days_back\": 30",
    "}",
  ].join("\n");

  const raw = await qwen("qwen2.5-72b-instruct", [
    { role: "system", content: sys  },
    { role: "user",   content: user },
  ], 500);

  try { return safeJson(raw); }
  catch {
    return { location: "Nigeria", state: "", lga: "", ward: "", district: "", threat_type: "ENCAMPMENT", days_back: 30 };
  }
}

function resolveBbox(params) {
  const key = (params.state || params.location || "").toLowerCase().trim();
  for (const [name, bbox] of Object.entries(NGA_STATE_BBOX)) {
    if (key.includes(name) || name.includes(key)) return bbox;
  }
  return [2.5, 4.0, 14.7, 14.0]; // Nigeria fallback
}

async function callAnalyzeThreat(scene1Base64, scene2Base64, params, scene1Date, scene2Date) {
  const bbox = resolveBbox(params);
  const lat  = (bbox[1] + bbox[3]) / 2;
  const lng  = (bbox[0] + bbox[2]) / 2;

  // Build rich place context for higher ARES confidence
  const placeParts = [
    params.location && params.location !== params.state ? params.location : null,
    params.ward     ? "Ward: " + params.ward         : null,
    params.district ? "District: " + params.district : null,
    params.lga      ? "LGA: " + params.lga           : null,
    params.state    ? "State: " + params.state        : null,
    "Threat type under investigation: " + (params.threat_type || "ENCAMPMENT"),
  ].filter(Boolean).join(" · ");

  const res = await fetch(LOVABLE_URL + "/functions/v1/analyze-threat", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + LOVABLE_KEY,
      "apikey":        LOVABLE_KEY,
    },
    body: JSON.stringify({
      image_before:  scene1Base64,
      image_after:   scene2Base64,
      coordinates:   { lat, lng, radius_km: 10 },
      lga_name:      params.lga      || "",
      state_name:    params.state    || params.location || "",
      ward:          params.ward     || "",
      district:      params.district || "",
      place_context: placeParts,
      date_t1:       scene1Date,
      date_t2:       scene2Date,
      sensor:        "Sentinel-2",
    }),
  });

  if (!res.ok) throw new Error("ARES error " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  if (data.error && !data.sitrep) throw new Error("ARES: " + data.error);
  return data.sitrep;
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
// UNIFIED PDF BUILDER — matches KrystallX Shield frontend visual style
// ================================================================

function buildKxsPdf(data) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 0, size: "A4" });
    const chunks = [];
    doc.on("data",  (c) => chunks.push(c));
    doc.on("end",   ()  => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // A4 points: 595.28 × 841.89  |  M=40pt ≈ 14mm
    const W = 595.28, H = 841.89, M = 40;
    const VOID_BG = "#0A0E1A";
    const AMBER   = "#F59E0B";
    const PANEL   = "#0F1629";
    const RED_BAN = "#dc2626";
    const DARK_HDR = "#1a2238";
    const THREAT_HEX = { CRITICAL: "#ef4444", HIGH: "#f97316", MODERATE: "#facc15", LOW: "#22c55e" };

    const stripDataUrl = (b64) => (b64 || "").replace(/^data:[^;]+;base64,/, "");

    const fillR = (x, y, w, h, hex) => doc.rect(x, y, w, h).fill(hex);

    const classBanner = (y) => {
      fillR(0, y, W, 18, RED_BAN);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8)
         .text("SECRET // KRYSTALLX SHIELD C4-ISR // NOFORN", 0, y + 5, { align: "center", width: W, lineBreak: false });
    };

    const secHdr = (label, y) => {
      fillR(M, y, W - 2 * M, 16, AMBER);
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9)
         .text(label, M + 6, y + 4, { lineBreak: false });
      return y + 21;
    };

    const module    = data.module || "SITREP";
    const issuedAt  = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const reportId  = "KX-" + module.slice(0, 3) + "-" + Date.now().toString(36).toUpperCase();
    const risk      = (data.threat_level || data.risk_level || "MODERATE").toUpperCase();
    const tHex      = THREAT_HEX[risk] || THREAT_HEX.MODERATE;

    // ── PAGE 1: COVER ─────────────────────────────────────────────
    fillR(0, 0, W, H, VOID_BG);
    classBanner(0);
    classBanner(H - 18);

    doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(26)
       .text("KRYSTALLX", 0, 50, { align: "center", width: W, lineBreak: false });
    doc.fontSize(13).fillColor("#ffffff")
       .text("S H I E L D", 0, 80, { align: "center", width: W, lineBreak: false });
    doc.fontSize(7.5).fillColor("#b4b4b4")
       .text("SOVEREIGN COMMAND & CONTROL — INTELLIGENCE, SURVEILLANCE, RECONNAISSANCE",
             0, 97, { align: "center", width: W, lineBreak: false });

    doc.moveTo(M, 114).lineTo(W - M, 114).strokeColor(AMBER).lineWidth(1).stroke();

    const [tl1, tl2] = module === "SENTINEL"
      ? ["SATELLITE CHANGE-DETECTION", "THREAT ASSESSMENT"]
      : module === "HUMINT"
      ? ["HUMAN INTELLIGENCE", "FIELD REPORT"]
      : ["SITUATION REPORT", "C4ISR ASSESSMENT"];

    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(17)
       .text(tl1, 0, 124, { align: "center", width: W, lineBreak: false });
    doc.fontSize(17)
       .text(tl2, 0, 145, { align: "center", width: W, lineBreak: false });
    doc.moveTo(M, 168).lineTo(W - M, 168).strokeColor(AMBER).lineWidth(1).stroke();

    // Threat level tile
    fillR(M, 180, W - 2 * M, 95, PANEL);
    doc.rect(M, 180, W - 2 * M, 95).strokeColor(tHex).lineWidth(3).stroke();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9).text("THREAT LEVEL", M + 10, 193, { lineBreak: false });
    doc.fillColor(tHex).fontSize(26).text(risk, M + 10, 210, { lineBreak: false });
    const threatType = (data.threat_type || data.intent || module).toUpperCase();
    doc.fillColor("#ffffff").fontSize(9).text("CATEGORY", W - M - 190, 193, { lineBreak: false });
    doc.fillColor(AMBER).fontSize(13).text(threatType, W - M - 190, 208, { lineBreak: false });
    if (data.analyst_confidence) {
      doc.fillColor("#ffffff").font("Helvetica").fontSize(8)
         .text("Confidence: " + data.analyst_confidence, W - M - 190, 228, { lineBreak: false });
    }

    // Metadata table
    let cy = 295;
    const meta = module === "SENTINEL"
      ? [
          ["LOCATION",   data.location || data.state_name || "Nigeria"],
          ["AOI BBOX",   (data.bbox || []).map((n) => (+n).toFixed(4)).join(", ")],
          ["SENSOR",     data.sensor || "Sentinel-2"],
          ["SCENE T1",   (data.scene1_date || "").slice(0, 10)],
          ["SCENE T2",   (data.scene2_date || "").slice(0, 10)],
          ["ANALYST",    "KrystallX ARES AI · Satellite Intel"],
          ["REPORT ID",  reportId],
          ["ISSUED",     issuedAt],
        ]
      : module === "HUMINT"
      ? [
          ["COMMANDER",   data.commander || ""],
          ["UNIT",        data.unit || ""],
          ["CHANNEL",     "TELEGRAM · ENCRYPTED"],
          ["REF NUMBER",  data.ref_number || ""],
          ["THREAT LEVEL", risk],
          ["REPORT ID",   reportId],
          ["ISSUED",      issuedAt],
        ]
      : [
          ["COMMANDER",  data.commander || ""],
          ["UNIT",       data.unit || ""],
          ["DTG",        data.dtg || ""],
          ["FROM",       data.from || ""],
          ["TO",         data.to || "NNS BEECROFT / C4ISR OPS CENTRE"],
          ["RISK LEVEL", risk],
          ["REPORT ID",  reportId],
          ["ISSUED",     issuedAt],
        ];

    for (const [k, v] of meta) {
      doc.fillColor("#a0a0a0").font("Helvetica-Bold").fontSize(8).text(k, M, cy, { lineBreak: false });
      doc.fillColor("#ffffff").font("Helvetica").text(String(v || ""), M + 80, cy, { lineBreak: false });
      cy += 16;
    }

    // ── PAGE 2 ─────────────────────────────────────────────────────
    doc.addPage();
    fillR(0, 0, W, H, VOID_BG);
    classBanner(0);
    classBanner(H - 18);
    let y = 26;

    if (module === "SENTINEL") {
      y = secHdr("SCENE COMPARISON — T1 (BEFORE) vs T2 (AFTER)", y);
      const gap   = 10;
      const hW    = (W - 2 * M - gap) / 2;
      const hdrH  = 19;
      const imgH  = 270;
      const cardH = hdrH + imgH + 10;

      const drawCard = (x, label, date, b64) => {
        fillR(x, y, hW, cardH, PANEL);
        fillR(x, y, hW, hdrH, DARK_HDR);
        doc.rect(x, y, hW, cardH).strokeColor(AMBER).lineWidth(0.8).stroke();
        doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(9)
           .text(label + " · " + (date || "").slice(0, 10), x + 7, y + 5, { lineBreak: false });
        if (b64) {
          try {
            // fit scales to fill the box while maintaining aspect ratio — no truncation
            doc.image(Buffer.from(stripDataUrl(b64), "base64"),
                      x + 4, y + hdrH + 3, { fit: [hW - 8, imgH - 6], align: "center", valign: "center" });
          } catch { /* keep blank panel */ }
        } else {
          doc.fillColor("#808080").font("Helvetica").fontSize(8)
             .text("(snapshot unavailable)", x + hW / 2 - 50, y + hdrH + imgH / 2, { lineBreak: false });
        }
      };

      drawCard(M,            "T1 BEFORE", data.scene1_date, data.t1_image);
      drawCard(M + hW + gap, "T2 AFTER",  data.scene2_date, data.t2_image);
      y += cardH + 14;

      // Observations two-column
      const t1Obs = (data.t1_observations || []).slice(0, 5);
      const t2Obs = (data.t2_observations || []).slice(0, 5);
      doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(9)
         .text("T1 OBSERVATIONS", M, y, { lineBreak: false })
         .text("T2 OBSERVATIONS", M + hW + gap, y, { lineBreak: false });
      y += 13;
      let ly1 = y, ly2 = y;
      doc.font("Helvetica").fontSize(8).fillColor("#dcdcdc");
      for (const obs of t1Obs) {
        doc.text("• " + obs, M, ly1, { width: hW - 6 });
        ly1 += doc.heightOfString("• " + obs, { width: hW - 6 }) + 3;
      }
      for (const obs of t2Obs) {
        doc.text("• " + obs, M + hW + gap, ly2, { width: hW - 6 });
        ly2 += doc.heightOfString("• " + obs, { width: hW - 6 }) + 3;
      }
      y = Math.max(ly1, ly2) + 14;

      if (data.change_summary) {
        y = secHdr("CHANGE SUMMARY", y);
        doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6")
           .text(data.change_summary, M, y, { width: W - 2 * M });
      }

    } else if (module === "HUMINT") {
      const ent = data.entities || {};
      const tblW = W - 2 * M;
      const col  = tblW / 3;

      const drawTable = (title, rows, cols) => {
        if (!rows || rows.length === 0) return;
        if (y > H - 120) {
          doc.addPage(); fillR(0, 0, W, H, VOID_BG); classBanner(0); classBanner(H - 18); y = 26;
        }
        y = secHdr(title, y);
        fillR(M, y, tblW, 16, DARK_HDR);
        doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(8);
        let cx = M + 5;
        for (const [lbl, cw] of cols) { doc.text(lbl, cx, y + 4, { lineBreak: false }); cx += cw; }
        y += 16;
        doc.font("Helvetica").fontSize(8).fillColor("#dcdcdc");
        for (let i = 0; i < rows.length; i++) {
          if (y > H - 60) {
            doc.addPage(); fillR(0, 0, W, H, VOID_BG); classBanner(0); classBanner(H - 18); y = 26;
          }
          if (i % 2 === 0) fillR(M, y, tblW, 14, PANEL);
          cx = M + 5;
          for (const [, cw, field] of cols) {
            doc.text(String(rows[i][field] || ""), cx, y + 3, { width: cw - 6, lineBreak: false, ellipsis: true });
            cx += cw;
          }
          y += 14;
        }
        y += 8;
      };

      drawTable("PERSONS OF INTEREST", ent.persons,
        [["NAME", col, "name"], ["ROLE", col, "role"], ["LOCATION", col, "location"]]);
      drawTable("VEHICLES / WATERCRAFT", ent.vehicles,
        [["TYPE", col, "type"], ["IDENTIFIER", col, "identifier"], ["DESCRIPTION", col, "description"]]);
      drawTable("GROUPS / ORGANISATIONS", ent.groups,
        [["NAME", col, "name"], ["TYPE", col, "type"], ["LOCATION", col, "location"]]);
      drawTable("ACTIVITIES", ent.activities,
        [["DESCRIPTION", col * 2, "description"], ["TIME REF", col, "time_ref"]]);
      drawTable("WEAPONS / EQUIPMENT", ent.weapons,
        [["TYPE", col, "type"], ["DESCRIPTION", col * 2, "description"]]);
      drawTable("LOCATIONS", ent.locations,
        [["NAME", col, "name"], ["DESCRIPTION", col, "description"], ["GRID REF", col, "grid_ref"]]);

    } else {
      // SITREP NATO sections
      for (const [heading, body] of [
        ["1. SITUATION",       data.situation],
        ["2. ENEMY FORCES",    data.enemy_forces],
        ["3. FRIENDLY FORCES", data.friendly_forces],
        ["4. ASSESSMENT",      data.assessment],
        ["5. ACTION",          data.action],
      ]) {
        if (!body) continue;
        if (y > H - 120) {
          doc.addPage(); fillR(0, 0, W, H, VOID_BG); classBanner(0); classBanner(H - 18); y = 26;
        }
        y = secHdr(heading, y);
        doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6").text(body, M, y, { width: W - 2 * M });
        y += doc.heightOfString(body, { width: W - 2 * M }) + 14;
      }
      if (data.coordinating_info) {
        y = secHdr("COORDINATING INFORMATION", y);
        doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6")
           .text(data.coordinating_info, M, y, { width: W - 2 * M });
      }
    }

    // ── PAGE 3: INTEL & RECOMMENDATION ────────────────────────────
    doc.addPage();
    fillR(0, 0, W, H, VOID_BG);
    classBanner(0);
    classBanner(H - 18);
    y = 26;

    if (module === "SENTINEL") {
      y = secHdr("INTELLIGENCE NARRATIVE", y);
      const narr = data.executive_summary || "Analysis pending.";
      doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6").text(narr, M, y, { width: W - 2 * M });
      y += doc.heightOfString(narr, { width: W - 2 * M }) + 16;

      const inds = data.threat_indicators || [];
      if (inds.length) {
        y = secHdr("KEY INDICATORS", y);
        doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6");
        for (const ind of inds) {
          const line = "▸ [" + ind.severity + "] " + ind.type + ": " + ind.description;
          doc.text(line, M, y, { width: W - 2 * M });
          y += doc.heightOfString(line, { width: W - 2 * M }) + 5;
        }
        y += 8;
      }

      const coords = inds.filter((i) => i.lat && i.lng);
      if (coords.length) {
        y = secHdr("SUSPECT COORDINATES", y);
        fillR(M, y, W - 2 * M, 16, DARK_HDR);
        doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(8)
           .text("TYPE", M + 5, y + 4, { lineBreak: false })
           .text("LATITUDE",  M + 255, y + 4, { lineBreak: false })
           .text("LONGITUDE", M + 370, y + 4, { lineBreak: false });
        y += 16;
        doc.font("Helvetica").fontSize(8).fillColor("#dcdcdc");
        coords.forEach((c, i) => {
          if (i % 2 === 0) fillR(M, y, W - 2 * M, 14, PANEL);
          doc.text(c.type || "", M + 5, y + 3, { width: 245, lineBreak: false, ellipsis: true });
          doc.text((+c.lat).toFixed(4) + "°N", M + 255, y + 3, { lineBreak: false });
          doc.text((+c.lng).toFixed(4) + "°E", M + 370, y + 3, { lineBreak: false });
          y += 14;
        });
        y += 10;
      }

      const recActs = (data.recommended_actions || []).join(" · ");
      if (recActs) {
        y = secHdr("RECOMMENDED ACTION", y);
        fillR(M, y, W - 2 * M, 38, "#111111");
        doc.rect(M, y, W - 2 * M, 38).strokeColor(AMBER).lineWidth(1.7).stroke();
        doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(10)
           .text(recActs, M + 7, y + 7, { width: W - 2 * M - 14 });
        y += 46;
      }

      if ((data.recommended_units || []).length) {
        y = secHdr("RECOMMENDED RESPONDER UNITS", y);
        doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6");
        for (const u of data.recommended_units) { doc.text("• " + u, M, y); y += 13; }
        y += 8;
      }

    } else {
      y = secHdr("THREAT ASSESSMENT SUMMARY", y);
      const summary = data.assessment || data.executive_summary || data.summary || "No assessment available.";
      doc.font("Helvetica").fontSize(9).fillColor("#e6e6e6").text(summary, M, y, { width: W - 2 * M });
    }

    // Signature block — all modules
    if (y > H - 90) {
      doc.addPage(); fillR(0, 0, W, H, VOID_BG); classBanner(0); classBanner(H - 18); y = 40;
    }
    doc.moveTo(M, y + 4).lineTo(W - M, y + 4).strokeColor(AMBER).lineWidth(0.8).stroke();
    doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(8)
       .text("AUTHORIZED BY", M, y + 12, { lineBreak: false })
       .text("DISPATCHED TO", W / 2, y + 12, { lineBreak: false });
    doc.fillColor("#ffffff").font("Helvetica")
       .text("KrystallX ARES AI · Intelligence System", M, y + 24, { lineBreak: false })
       .text("Tactical Commander, Field Operations", W / 2, y + 24, { lineBreak: false });
    doc.fillColor("#a0a0a0").fontSize(7)
       .text("Report ID: " + reportId + "  •  Issued " + issuedAt, M, y + 36, { lineBreak: false });

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

    // 11. SENTINEL SWEEP — MPC raster fetch → ARES vision analysis
    let sentinelResult = null;
    let aresResult     = null;
    let sentinelParams = null;
    const isSentinel = intent.intent === "AREA_SCAN"
      || (Array.isArray(intent.modules) && intent.modules.includes("SENTINEL_SWEEP"));

    if (isSentinel) {
      try {
        await sendText(chatId, "SENTINEL SWEEP initiated. Querying Planetary Computer satellite archive... ETA 30-60 seconds.");
        sentinelParams  = await extractSentinelParams(text);
        console.log("[SENTINEL] Params:", JSON.stringify(sentinelParams));
        sentinelResult  = await callSentinelCommander(sentinelParams);

        // Extract raster crops from MPC response
        const scene1  = sentinelResult.tiles?.scene1 || sentinelResult.results?.[0]?.tiles?.scene1;
        const scene2  = sentinelResult.tiles?.scene2 || sentinelResult.results?.[0]?.tiles?.scene2;
        const s1b64   = scene1?.crop_base64;
        const s2b64   = scene2?.crop_base64;
        const s1date  = scene1?.date || "";
        const s2date  = scene2?.date || "";

        if (s1b64 && s2b64) {
          await sendText(chatId, "Raster imagery acquired. Running ARES change-detection analysis...");
          aresResult = await callAnalyzeThreat(s1b64, s2b64, sentinelParams, s1date, s2date);
          // Attach dates and images back for PDF builder
          aresResult._t1_image  = s1b64;
          aresResult._t2_image  = s2b64;
          aresResult._s1date    = s1date;
          aresResult._s2date    = s2date;
          const mag  = aresResult.change_magnitude || "MODERATE";
          const conf = aresResult.analyst_confidence || "MEDIUM";
          await sendText(chatId, "ARES COMPLETE. Change magnitude: " + mag + " | Confidence: " + conf + ". Building SITREP...");
          console.log("[ARES] Done - mag=" + mag + " conf=" + conf);
        } else {
          const score = sentinelResult.threatScore ?? sentinelResult.results?.[0]?.threatScore ?? "N/A";
          const sev   = sentinelResult.severity ?? sentinelResult.results?.[0]?.severity ?? "LOW";
          await sendText(chatId, "SENTINEL COMPLETE (no raster crops available). Score: " + score + " | " + sev + ". Generating text SITREP...");
          console.log("[SENTINEL] Fallback - score=" + score + " sev=" + sev);
        }
      } catch (e) {
        console.warn("[SENTINEL] Failed:", e.message);
        await sendText(chatId, "SENTINEL SWEEP error: " + e.message.slice(0, 160) + ". Generating text SITREP from voice report.");
      }
    }

    // 12. SITREP generation — enrich with HUMINT and/or Sentinel/ARES data
    const aresIntel = aresResult ? {
      executive_summary: aresResult.executive_summary,
      change_magnitude:  aresResult.change_magnitude,
      analyst_confidence: aresResult.analyst_confidence,
      threat_indicators: aresResult.threat_indicators,
      recommended_actions: aresResult.recommended_actions,
    } : null;

    const sitrepIntent = {
      ...intent,
      ...(humintEntities ? { humint: humintEntities } : {}),
      ...(aresIntel      ? { sentinel: aresIntel }    : {}),
      ...(sentinelResult && !aresIntel ? { sentinel: {
        brief:       sentinelResult.brief ?? sentinelResult.results?.[0]?.brief,
        threat_score: sentinelResult.threatScore ?? sentinelResult.results?.[0]?.threatScore,
        severity:    sentinelResult.severity ?? sentinelResult.results?.[0]?.severity,
      }} : {}),
    };
    const sitrep = await makeSitrep(cdrName, cdrUnit, text, sitrepIntent);
    if (isSos) sitrep.risk_level = "CRITICAL";
    if (aresResult?.change_magnitude === "CRITICAL") sitrep.risk_level = "CRITICAL";

    // 13. PDF build — unified KXS dark-theme format
    let pdf, filename, caption;
    const note = conf < 0.75 ? " [LOW CONFIDENCE - VERIFY]" : "";

    if (isSentinel && (aresResult || sentinelResult)) {
      // SENTINEL PDF — dark cover + T1/T2 imagery + ARES intel
      const bbox = resolveBbox(sentinelParams || {});
      pdf = await buildKxsPdf({
        module:             "SENTINEL",
        threat_level:       aresResult?.change_magnitude || sitrep.risk_level,
        threat_type:        sentinelParams?.threat_type || "ENCAMPMENT",
        location:           sentinelParams?.location || sentinelParams?.state || "Nigeria",
        state_name:         sentinelParams?.state || "",
        bbox,
        sensor:             "Sentinel-2 · MPC",
        scene1_date:        aresResult?._s1date || "",
        scene2_date:        aresResult?._s2date || "",
        t1_image:           aresResult?._t1_image || null,
        t2_image:           aresResult?._t2_image || null,
        t1_observations:    aresResult?.t1_observations || [],
        t2_observations:    aresResult?.t2_observations || [],
        change_summary:     aresResult?.change_summary || "",
        executive_summary:  aresResult?.executive_summary || sitrep.assessment,
        threat_indicators:  aresResult?.threat_indicators || [],
        recommended_actions: aresResult?.recommended_actions || [sitrep.action],
        recommended_units:  aresResult?.recommended_units || [],
        analyst_confidence: aresResult?.analyst_confidence || "MEDIUM",
        commander:          cdrName,
        unit:               cdrUnit,
      });
      filename = "SENTINEL_" + new Date().toISOString().slice(0, 10) + "_" + (aresResult?.change_magnitude || sitrep.risk_level) + ".pdf";
      const mag  = aresResult?.change_magnitude || "N/A";
      const conf2 = aresResult?.analyst_confidence || "MEDIUM";
      const recAct = (aresResult?.recommended_actions || [sitrep.action])[0] || "";
      caption = "SENTINEL REPORT · " + (sentinelParams?.location || sentinelParams?.state || "Nigeria")
        + "\nChange magnitude: " + mag + " · Confidence: " + conf2
        + "\n\n" + (aresResult?.executive_summary || sitrep.assessment).slice(0, 280)
        + "\n\nACTION: " + recAct.slice(0, 140) + note;

    } else if (isHumint && humintEntities) {
      // HUMINT PDF — entity tables
      pdf = await buildKxsPdf({
        module:       "HUMINT",
        threat_level: humintEntities.threat_level || sitrep.risk_level,
        commander:    cdrName,
        unit:         cdrUnit,
        ref_number:   humintRef,
        entities:     humintEntities,
        summary:      humintEntities.summary,
        assessment:   sitrep.assessment,
      });
      filename = "HUMINT_" + humintRef + ".pdf";
      caption  = "HUMINT REPORT · Ref: " + humintRef
        + "\nRisk: " + (humintEntities.threat_level || sitrep.risk_level)
        + " · Confidence: " + Math.round((humintEntities.confidence || 0.5) * 100) + "%"
        + "\n\n" + humintEntities.summary.slice(0, 280)
        + "\n\nACTION: " + sitrep.action.slice(0, 140) + note;

    } else {
      // Default SITREP PDF
      pdf = await buildKxsPdf({
        module:          "SITREP",
        threat_level:    sitrep.risk_level,
        threat_type:     intent.intent || "SITREP",
        commander:       cdrName,
        unit:            cdrUnit,
        dtg:             sitrep.dtg,
        from:            sitrep.from,
        to:              sitrep.to,
        subject:         sitrep.subject,
        situation:       sitrep.situation,
        enemy_forces:    sitrep.enemy_forces,
        friendly_forces: sitrep.friendly_forces,
        assessment:      sitrep.assessment,
        action:          sitrep.action,
        coordinating_info: sitrep.coordinating_info,
      });
      filename = "SITREP_" + sitrep.dtg.slice(0, 10) + "_" + sitrep.risk_level + ".pdf";
      const humintLine = humintRef ? "\n\nHUMINT REF: " + humintRef : "";
      caption = "SITREP " + sitrep.risk_level + " | " + sitrep.subject
        + humintLine
        + "\n\n" + sitrep.assessment.slice(0, 220)
        + "\n\nACTION: " + sitrep.action.slice(0, 140) + note;
    }

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
