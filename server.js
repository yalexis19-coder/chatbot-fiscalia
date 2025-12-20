/**
 * ChatbotFiscalia - server.js (FIX)
 * - Menú completo (Quick Replies)
 * - Manejo correcto de Quick Replies (message.quick_reply.payload)
 * - Flujo de Denuncia sin volver al saludo
 * - Anti-bucle básico para preguntas repetidas
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

  // Log mínimo si hay error
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

      // 1) Postbacks (botón GET_STARTED / templates)
      if (event.postback?.payload) {
        await handlePostback(psid, event.postback.payload);
        continue;
      }

      // 2) Mensajes
      if (event.message) {
        // ✅ FIX: Quick Replies llegan aquí, NO como postback
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
    return menu(psid);
  }

  if (payload === "DENUNCIA") {
    session.stage = "denuncia";
    // No limpiamos distrito si ya se obtuvo, pero sí puedes hacerlo si tu UX lo requiere.
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

  // Si llega algo desconocido, mostramos menú
  session.stage = "idle";
  return menu(psid);
}

async function handleMessage(psid, text) {
  const session = getSession(psid);

  // Si el usuario escribe algo como "menu", le mostramos el menú
  const tnorm = (text || "").toLowerCase();
  if (tnorm === "menu" || tnorm === "menú" || tnorm === "inicio") {
    session.stage = "idle";
    return menu(psid);
  }

  // --------------- DENUNCIA ---------------
  if (session.stage === "denuncia") {
    const analysis = await analyzeMessage({
      userText: text,
      sessionContext: session
    });

    session.materia = analysis?.materia || session.materia || "penal";

    if (analysis?.requiere_distrito && !session.distrito) {
      session.stage = "await_distrito";
      if (!askedRecently(session, "distrito")) {
        setAsked(session, "distrito");
        await send(psid, { text: "¿En qué distrito ocurrieron los hechos? (Ej.: Cajamarca, Baños del Inca, San Marcos)" });
      }
      return;
    }

    await send(psid, {
      text:
        `Gracias. Por lo descrito, se trataría de un caso de **${session.materia}**. ` +
        `Para recibir orientación y presentar tu denuncia, acércate a la fiscalía competente de tu zona.`
    });
    // Opcional: mostrar menú después de orientar
    session.stage = "idle";
    return menu(psid);
  }

  if (session.stage === "await_distrito") {
    session.distrito = text;
    session.stage = "denuncia";
    await send(psid, { text: `Gracias. Registré el distrito: **${session.distrito}**.` });

    // Continuamos pidiendo relato (si no lo tenemos claro)
    if (!askedRecently(session, "relato")) {
      setAsked(session, "relato");
      await send(psid, { text: "Ahora, por favor, cuéntame brevemente qué ocurrió." });
    }
    return;
  }

  // --------------- OTROS FLUJOS (básico) ---------------
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
  // Si está idle, mostramos menú directamente
  session.stage = "idle";
  return menu(psid);
}

// ---------------- START ----------------
app.get("/", (req, res) => res.status(200).send("ChatbotFiscalia OK"));
app.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
