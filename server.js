/**
 * ChatbotFiscalia - server.js (v2)
 * Menu completo + control de estado + anti-bucle
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
      stage: "idle",
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

// ---------------- MENÚ ----------------
async function send(psid, message) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message
    })
  });
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

      if (event.postback) {
        await handlePostback(psid, event.postback.payload);
      } else if (event.message && event.message.text) {
        await handleMessage(psid, event.message.text);
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
    return menu(psid);
  }

  if (payload === "DENUNCIA") {
    session.stage = "denuncia";
    setAsked(session, "relato");
    return send(psid, { text: "Cuéntame, ¿qué ocurrió?" });
  }

  if (payload === "UBICACION") {
    session.stage = "ubicacion";
    setAsked(session, "distrito");
    return send(psid, { text: "Indícame el distrito o provincia para darte la ubicación." });
  }

  if (payload === "FAQ") {
    session.stage = "faq";
    return send(psid, { text: "Escribe tu pregunta y te responderé." });
  }

  if (payload === "TRAMITES") {
    session.stage = "tramites";
    return send(psid, { text: "¿Qué trámite deseas realizar?" });
  }

  if (payload === "CONTACTOS") {
    session.stage = "contactos";
    return send(psid, { text: "¿De qué sede o entidad necesitas el contacto?" });
  }

  return menu(psid);
}

async function handleMessage(psid, text) {
  const session = getSession(psid);

  if (session.stage === "denuncia") {
    const analysis = await analyzeMessage({
      userText: text,
      sessionContext: session
    });

    session.materia = analysis.materia;

    if (analysis.requiere_distrito && !session.distrito) {
      session.stage = "await_distrito";
      if (!askedRecently(session, "distrito")) {
        setAsked(session, "distrito");
        return send(psid, { text: "¿En qué distrito ocurrieron los hechos?" });
      }
      return;
    }

    return send(psid, {
      text: `Gracias. Según lo descrito, se trata de un caso de *${analysis.materia}*. Acércate a la fiscalía correspondiente para orientación.`
    });
  }

  if (session.stage === "await_distrito") {
    session.distrito = text;
    session.stage = "denuncia";
    return send(psid, {
      text: `Gracias. Con lo ocurrido en *${session.distrito}*, corresponde orientación en fiscalía de *${session.materia || "la materia correspondiente"}*.`
    });
  }

  // Otros flujos simples
  return menu(psid);
}

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log("Servidor activo en puerto", PORT);
});
