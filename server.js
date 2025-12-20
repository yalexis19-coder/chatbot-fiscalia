/**
 * ChatbotFiscalia - server.js (v3)
 * Cambios puntuales (sin romper lo que ya funciona):
 * 1) ✅ Manejo correcto de Quick Replies: event.message.quick_reply.payload
 * 2) ✅ Si el ciudadano YA menciona el distrito en su relato (ej. "en Contumaza"), lo capturamos y NO lo volvemos a pedir
 * 3) ✅ Si falta distrito y lo pedimos, guardamos el relato (pendingStory) para NO pedirlo de nuevo después
 *
 * Requisitos (env):
 *  - PAGE_ACCESS_TOKEN
 *  - VERIFY_TOKEN
 *  - PORT (opcional)
 */

const express = require("express");
const bodyParser = require("body-parser");
const { analyzeMessage } = require("./ia");

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 10000;

const app = express();
app.use(bodyParser.json());

// ---------------- SESIONES ----------------
const sessions = new Map();

function getSession(psid) {
  if (!sessions.has(psid)) {
    sessions.set(psid, {
      stage: "idle",        // idle | denuncia | await_distrito | ubicacion | faq | tramites | contactos
      distrito: null,
      materia: null,
      pendingStory: null,   // ✅ relato guardado cuando falta distrito
      lastQuestion: null,
      lastAt: 0
    });
  }
  return sessions.get(psid);
}

function askedRecently(session, key, ms = 40000) {
  return session.lastQuestion === key && Date.now() - session.lastAt < ms;
}

function setAsked(session, key) {
  session.lastQuestion = key;
  session.lastAt = Date.now();
}

// ---------------- EXTRACCIÓN SIMPLE DE DISTRITO DESDE RELATO ----------------
// Nota: Esto es una heurística "segura" para tu caso ("en Contumaza").
// Ideal (futuro): validar contra lista real de distritos desde tu Excel/knowledge.
function extractDistritoFromStory(text) {
  const t = (text || "").trim();
  if (!t) return null;

  // Captura "en Contumaza", "en Baños del Inca", etc.
  // Evita capturar frases muy largas.
  const m = t.match(/\ben\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s]{3,40})/i);
  if (!m) return null;

  let cand = (m[1] || "").trim();

  // Cortar si luego viene "provincia", "distrito", "departamento" u otra palabra común
  cand = cand.split(/\b(provincia|distrito|departamento|regi[oó]n)\b/i)[0].trim();

  // Limpiar puntuación final
  cand = cand.replace(/[.,;:]+$/, "").trim();

  // Filtro mínimo para evitar capturar cosas tipo "mi casa"
  const low = cand.toLowerCase();
  const blacklist = ["mi casa", "casa", "mi hogar", "el mercado", "mercado", "la calle", "la plaza"];
  if (blacklist.includes(low)) return null;

  return cand || null;
}

// ---------------- MENSAJERÍA ----------------
async function send(psid, message) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("Send API error:", resp.status, txt);
  }
}

async function menu(psid) {
  await send(psid, {
    text: "Hola 👋 Soy el asistente virtual del Ministerio Público (Cajamarca). ¿Qué deseas hacer?",
    quick_replies: [
      { content_type: "text", title: "Denuncia", payload: "DENUNCIA" },
      { content_type: "text", title: "Ubicación", payload: "UBICACION" },
      { content_type: "text", title: "Preguntas", payload: "FAQ" },
      { content_type: "text", title: "Trámites", payload: "TRAMITES" },
      { content_type: "text", title: "Contactos", payload: "CONTACTOS" }
    ]
  });
}

// ---------------- WEBHOOK ----------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const entries = req.body.entry || [];

  for (const entry of entries) {
    const events = entry.messaging || [];

    for (const event of events) {
      const psid = event.sender?.id;
      if (!psid) continue;

      // 1) Postbacks (GET_STARTED / templates)
      if (event.postback?.payload) {
        await handlePostback(psid, event.postback.payload);
        continue;
      }

      // 2) Mensajes
      if (event.message) {
        // ✅ FIX: Quick Replies llegan aquí
        const qrPayload = event.message.quick_reply?.payload;
        if (qrPayload) {
          await handlePostback(psid, qrPayload);
          continue;
        }

        const text = event.message.text;
        if (text) {
          await handleMessage(psid, text.trim());
        }
      }
    }
  }

  res.sendStatus(200);
});

// ---------------- HANDLERS ----------------
async function handlePostback(psid, payload) {
  const session = getSession(psid);

  if (payload === "GET_STARTED") {
    session.stage = "idle";
    session.distrito = null;
    session.materia = null;
    session.pendingStory = null;
    return menu(psid);
  }

  if (payload === "DENUNCIA") {
    session.stage = "denuncia";
    setAsked(session, "relato");
    await send(psid, { text: "Perfecto. Cuéntame, por favor, ¿qué ocurrió? Puedes describir los hechos con tus palabras." });
    return;
  }

  if (payload === "UBICACION") {
    session.stage = "ubicacion";
    setAsked(session, "ubicacion");
    await send(psid, { text: "Indícame el distrito o provincia y te digo la sede/fiscalía más cercana." });
    return;
  }

  if (payload === "FAQ") {
    session.stage = "faq";
    await send(psid, { text: "Escribe tu pregunta y te responderé con la información disponible." });
    return;
  }

  if (payload === "TRAMITES") {
    session.stage = "tramites";
    await send(psid, { text: "¿Qué trámite necesitas? (Ej.: denunciar, copias, orientación, etc.)" });
    return;
  }

  if (payload === "CONTACTOS") {
    session.stage = "contactos";
    await send(psid, { text: "¿Qué entidad o sede deseas contactar? Indica distrito/provincia si aplica." });
    return;
  }

  session.stage = "idle";
  return menu(psid);
}

async function handleMessage(psid, text) {
  const session = getSession(psid);

  // Atajo al menú
  const tnorm = (text || "").toLowerCase();
  if (tnorm === "menu" || tnorm === "menú" || tnorm === "inicio") {
    session.stage = "idle";
    return menu(psid);
  }

  // --------------- DENUNCIA ---------------
  if (session.stage === "denuncia") {
    // ✅ NUEVO: si en el relato ya viene el distrito, lo guardamos y NO lo pedimos
    if (!session.distrito) {
      const d = extractDistritoFromStory(text);
      if (d) session.distrito = d;
    }

    const analysis = await analyzeMessage({
      userText: text,
      sessionContext: session
    });

    session.materia = analysis?.materia || session.materia || "penal";

    // Si requiere distrito y aún no lo tenemos, lo pedimos y guardamos el relato
    if (analysis?.requiere_distrito && !session.distrito) {
      session.pendingStory = text; // ✅ guardar relato para continuar luego
      session.stage = "await_distrito";

      if (!askedRecently(session, "distrito")) {
        setAsked(session, "distrito");
        await send(psid, { text: "¿En qué distrito ocurrieron los hechos? (Ej.: Cajamarca, Baños del Inca, San Marcos)" });
      }
      return;
    }

    // ✅ Respuesta (ya con distrito si estaba en relato o ya estaba en sesión)
    const d = session.distrito ? ` en **${session.distrito}**` : "";
    await send(psid, {
      text:
        `Gracias. Por lo descrito, se trataría de un caso de **${session.materia}**${d}. ` +
        `Para recibir orientación y presentar tu denuncia, acércate a la fiscalía competente de tu zona.`
    });

    // Opcional: volver a menú
    session.stage = "idle";
    return menu(psid);
  }

  // --------------- ESPERANDO DISTRITO ---------------
  if (session.stage === "await_distrito") {
    session.distrito = text;

    // ✅ Si tenemos relato guardado, continuamos sin pedirlo otra vez
    const story = session.pendingStory;
    session.pendingStory = null;

    if (story) {
      const analysis = await analyzeMessage({
        userText: story,
        sessionContext: session
      });

      session.materia = analysis?.materia || session.materia || "penal";

      await send(psid, {
        text:
          `Gracias. Para hechos ocurridos en **${session.distrito}**, por lo descrito se trataría de un caso de **${session.materia}**. ` +
          `Acércate a la fiscalía competente de tu zona para orientación y recepción de la denuncia.`
      });

      session.stage = "idle";
      return menu(psid);
    }

    // Si por alguna razón no hay relato guardado, pedimos el relato (fallback)
    session.stage = "denuncia";
    if (!askedRecently(session, "relato")) {
      setAsked(session, "relato");
      await send(psid, { text: "Gracias. Ahora, por favor, cuéntame brevemente qué ocurrió." });
    }
    return;
  }

  // --------------- OTROS FLUJOS (básico, sin romper lo actual) ---------------
  if (session.stage === "ubicacion") {
    await send(psid, { text: `Gracias. Estoy tomando nota de: **${text}**. (Aquí conectaremos la búsqueda de ubicación desde tu Excel/knowledge).` });
    session.stage = "idle";
    return menu(psid);
  }

  if (session.stage === "faq") {
    await send(psid, { text: `Recibí tu pregunta: **${text}**. (Aquí conectaremos la respuesta desde tu hoja FAQ/knowledge).` });
    session.stage = "idle";
    return menu(psid);
  }

  if (session.stage === "tramites") {
    await send(psid, { text: `Trámite consultado: **${text}**. (Aquí conectaremos pasos/requisitos desde tu hoja Procedimiento).` });
    session.stage = "idle";
    return menu(psid);
  }

  if (session.stage === "contactos") {
    await send(psid, { text: `Contacto solicitado: **${text}**. (Aquí conectaremos datos desde tu hoja Contacto).` });
    session.stage = "idle";
    return menu(psid);
  }

  // --------------- IDLE ---------------
  session.stage = "idle";
  return menu(psid);
}

// ---------------- START ----------------
app.get("/", (req, res) => res.status(200).send("ChatbotFiscalia OK"));
app.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
