/**
 * ChatbotFiscalia - server.js
 * Messenger webhook + flujo conversacional con memoria de sesión (anti-bucle)
 *
 * Requisitos (env vars):
 * - PAGE_ACCESS_TOKEN
 * - VERIFY_TOKEN
 * - OPENAI_API_KEY
 * - OPENAI_MODEL (opcional, default: gpt-4o-mini)
 *
 * Notas:
 * - Sesiones en memoria (Map). En producción ideal: Redis/DB.
 * - Conocimiento: si existe ./knowledge.json (opcional), se usa para buscar fiscalías por materia/distrito.
 */

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { analyzeMessage } = require("./ia");

// -------------------- Config --------------------
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 10000;

// Validaciones mínimas
if (!PAGE_ACCESS_TOKEN) console.warn("⚠️ Falta PAGE_ACCESS_TOKEN en variables de entorno.");
if (!VERIFY_TOKEN) console.warn("⚠️ Falta VERIFY_TOKEN en variables de entorno.");
if (!process.env.OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY en variables de entorno.");

// -------------------- App --------------------
const app = express();
app.use(bodyParser.json());

// -------------------- Sesiones --------------------
// Estructura sesión:
// {
//   stage: "idle" | "collect_story" | "awaiting_district",
//   distrito: null|string,
//   provincia: null|string,
//   materia: null|"penal"|"familia"|...,
//   lastQuestionKey: null|string,
//   lastQuestionAt: 0,
//   lastUserText: null|string
// }
const sessions = new Map();

function getSession(psid) {
  if (!sessions.has(psid)) {
    sessions.set(psid, {
      stage: "idle",
      distrito: null,
      provincia: null,
      materia: null,
      lastQuestionKey: null,
      lastQuestionAt: 0,
      lastUserText: null,
    });
  }
  return sessions.get(psid);
}

function setLastQuestion(session, key) {
  session.lastQuestionKey = key;
  session.lastQuestionAt = Date.now();
}

function recentlyAskedSame(session, key, withinMs = 45_000) {
  return session.lastQuestionKey === key && (Date.now() - (session.lastQuestionAt || 0)) < withinMs;
}

// -------------------- Knowledge (opcional) --------------------
let KNOWLEDGE = null;
try {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  KNOWLEDGE = require("./knowledge.json");
} catch (e) {
  KNOWLEDGE = null;
}

function normalize(str) {
  return (str || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/**
 * Búsqueda simple de fiscalía en knowledge.json (si existe).
 * Espera una estructura flexible. Ejemplos soportados:
 * - KNOWLEDGE.fiscalias = [{ distrito, provincia, materia, nombre, direccion, telefono, horario }]
 * - KNOWLEDGE.ubicaciones = [...]
 */
function lookupFiscalia({ materia, distrito }) {
  if (!KNOWLEDGE) return null;

  const arr =
    KNOWLEDGE.fiscalias ||
    KNOWLEDGE.ubicaciones ||
    KNOWLEDGE.Fiscalia ||
    KNOWLEDGE.fiscalia ||
    null;

  if (!Array.isArray(arr)) return null;

  const md = normalize(distrito);
  const mm = normalize(materia);

  // 1) match exact materia + distrito
  let best = arr.find((x) => normalize(x.distrito) === md && normalize(x.materia || x.tipo || x.area) === mm);
  if (best) return best;

  // 2) match distrito, materia similar
  best = arr.find((x) => normalize(x.distrito) === md && normalize(x.materia || x.tipo || x.area).includes(mm));
  if (best) return best;

  // 3) match distrito solo
  best = arr.find((x) => normalize(x.distrito) === md);
  if (best) return best;

  return null;
}

// -------------------- Messenger helpers --------------------
async function callSendAPI(psid, messageData) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
    PAGE_ACCESS_TOKEN
  )}`;

  const payload = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: messageData,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ SendAPI error:", res.status, txt);
  }
}

async function sendText(psid, text) {
  await callSendAPI(psid, { text });
}

async function sendQuickReplies(psid, text, replies) {
  await callSendAPI(psid, {
    text,
    quick_replies: replies.map((r) => ({
      content_type: "text",
      title: r.title,
      payload: r.payload,
    })),
  });
}

async function sendGetStartedOrMenu(psid) {
  // Solo "Denuncia" (como pediste). Mensaje humano, sin “paz y bien”.
  await sendQuickReplies(
    psid,
    "Hola 👋 Soy el asistente virtual de orientación del Ministerio Público (Cajamarca). ¿En qué puedo ayudarte hoy?",
    [{ title: "Denuncia", payload: "DENUNCIA" }]
  );
}

// -------------------- Webhook endpoints --------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  try {
    for (const entry of body.entry || []) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        const psid = event.sender && event.sender.id;
        if (!psid) continue;

        if (event.postback) {
          await handlePostback(psid, event.postback);
        } else if (event.message) {
          await handleMessage(psid, event.message);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error en webhook:", err);
  }

  res.status(200).send("EVENT_RECEIVED");
});

// -------------------- Handlers --------------------
async function handlePostback(psid, postback) {
  const payload = postback.payload;
  const session = getSession(psid);

  if (payload === "GET_STARTED") {
    session.stage = "idle";
    session.materia = null;
    session.distrito = null;
    session.provincia = null;
    await sendGetStartedOrMenu(psid);
    return;
  }

  if (payload === "DENUNCIA") {
    session.stage = "collect_story";
    session.materia = null;
    setLastQuestion(session, "ask_story");
    await sendText(psid, "Cuéntame, por favor, ¿qué ocurrió? (puedes describirlo con tus palabras).");
    return;
  }

  // fallback
  await sendGetStartedOrMenu(psid);
}

function extractDistrictFromText(text) {
  // Muy simple: se queda con el texto completo como “distrito” si viene corto.
  // Puedes mejorar con tu lista de distritos del Excel/knowledge.
  const t = (text || "").trim();
  if (!t) return null;
  if (t.length > 60) return null;
  return t;
}

async function handleMessage(psid, message) {
  const session = getSession(psid);

  // Ignorar ecos/bot
  if (message.is_echo) return;

  const text = (message.text || "").trim();
  if (!text) {
    await sendText(psid, "¿Podrías escribir tu consulta en texto, por favor?");
    return;
  }
  session.lastUserText = text;

  // 1) Si estamos esperando distrito, lo capturamos y continuamos
  if (session.stage === "awaiting_district") {
    const d = extractDistrictFromText(text);
    if (!d) {
      if (!recentlyAskedSame(session, "ask_district")) {
        setLastQuestion(session, "ask_district");
        await sendText(psid, "Indícame el distrito donde ocurrieron los hechos (por ejemplo: Baños del Inca).");
      }
      return;
    }

    session.distrito = d;
    session.stage = "collect_story"; // volvemos a procesar con lo que ya sabemos

    // Continuar: usamos el último análisis guardado si existe
    const lastAnalysis = session.lastAnalysis;
    if (lastAnalysis) {
      await respondWithDerivation(psid, session, lastAnalysis);
      return;
    }

    // Si no hay análisis, pedimos nuevamente relato (pero sin bucle)
    if (!recentlyAskedSame(session, "ask_story")) {
      setLastQuestion(session, "ask_story");
      await sendText(psid, "Gracias. Ahora, cuéntame brevemente qué ocurrió.");
    }
    return;
  }

  // 2) Si no está en flujo de denuncia, mostrar menú
  if (session.stage === "idle") {
    await sendGetStartedOrMenu(psid);
    return;
  }

  // 3) En flujo de denuncia: analizamos el texto con IA
  const analysis = await analyzeMessage({
    userText: text,
    sessionContext: {
      distrito: session.distrito,
      materia: session.materia,
      stage: session.stage,
    },
  });

  // Guardar análisis para continuar si pide distrito
  session.lastAnalysis = analysis;

  // Si la materia cambió (p. ej. de penal a familia), la actualizamos
  if (analysis && analysis.materia) {
    session.materia = analysis.materia;
  }

  // 4) ¿Requiere distrito y aún no lo tenemos?
  if (analysis && analysis.requiere_distrito && !session.distrito) {
    session.stage = "awaiting_district";

    // Anti-bucle: no repetir si ya lo preguntamos recién
    if (!recentlyAskedSame(session, "ask_district")) {
      setLastQuestion(session, "ask_district");
      await sendText(
        psid,
        "Para orientarte mejor, ¿en qué distrito ocurrieron los hechos? (Ej.: Cajamarca, Baños del Inca, San Marcos)"
      );
    }
    return;
  }

  // 5) Responder derivación final (o guía)
  await respondWithDerivation(psid, session, analysis);
}

async function respondWithDerivation(psid, session, analysis) {
  const materia = (analysis && analysis.materia) || session.materia || "penal";
  const distrito = session.distrito;

  // Intentar lookup con knowledge.json si existe
  const fiscalia = lookupFiscalia({ materia, distrito });

  // Construir respuesta humana, institucional, sin tecnicismos
  const intro = analysis && analysis.resumen_ciudadano
    ? analysis.resumen_ciudadano
    : "Gracias por contarlo. Con la información brindada, puedo orientarte de manera general.";

  let body = "";
  if (materia === "familia") {
    body =
      "Por lo que describes, se trataría de un **tema de familia** (por ejemplo, régimen de visitas/tenencia o impedimento de contacto con tu hijo).";
  } else if (materia === "penal") {
    body = "Por lo que describes, podría corresponder a un **hecho de materia penal**. La Fiscalía evaluará el caso y te indicará los pasos a seguir.";
  } else {
    body = `Por lo que describes, podría corresponder a un **caso de materia ${materia}**.`;
  }

  let where = "";
  if (fiscalia) {
    const nombre = fiscalia.nombre || fiscalia.nombre_fiscalia || fiscalia.titulo || "Fiscalía competente";
    const dir = fiscalia.direccion || fiscalia.dirección || "";
    const tel = fiscalia.telefono || fiscalia.teléfono || fiscalia.celular || "";
    const hor = fiscalia.horario || fiscalia.hora || "";

    where =
      `\n\n📍 **${nombre}**` +
      (dir ? `\nDirección: ${dir}` : "") +
      (tel ? `\nTeléfono: ${tel}` : "") +
      (hor ? `\nHorario: ${hor}` : "");
  } else if (distrito) {
    // fallback si no hay knowledge
    where =
      `\n\n📍 Para hechos ocurridos en **${distrito}**, acude a la **Fiscalía competente** de tu zona (Mesa de Partes/Atención al Usuario) para recibir orientación y presentar tu denuncia.`;
  } else {
    where =
      "\n\n📍 Si me indicas el distrito donde ocurrieron los hechos, puedo orientar mejor la fiscalía o sede más cercana.";
  }

  const cierre =
    "\n\nSi deseas, también puedes contarme más detalles (sin datos sensibles) para orientar mejor el tipo de trámite.";

  // Evitar bucles: si ya se respondió esto hace poco, no duplicar exacto
  const responseText = `${intro}\n\n${body}${where}${cierre}`;

  // Reset a “collect_story” para seguir conversando sin preguntar distrito otra vez
  session.stage = "collect_story";
  setLastQuestion(session, "delivered_guidance");
  await sendText(psid, responseText);
}

// -------------------- Start --------------------
app.get("/", (req, res) => {
  res.status(200).send("ChatbotFiscalia OK");
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
