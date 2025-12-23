/**
 * server.js — Chatbot Messenger (Ministerio Público – Distrito Fiscal de Cajamarca)
 * Mejoras incluidas (sin cambiar la lógica base):
 *  - Tolerancia a errores de escritura para el comando "Denuncia"
 *  - "Denuncia" reinicia el flujo en cualquier estado (evita loops)
 *  - Si el bot está esperando distrito y el usuario manda otra cosa, repregunta sin “romper” el estado
 *
 * Nota: Este archivo asume que ya tienes:
 *  - ia.js (lógica IA principal)
 *  - knowledge.json (opcional, para lista de distritos/fiscalías si existe)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

// ---------------------------
// Config
// ---------------------------
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;

if (!PAGE_ACCESS_TOKEN) {
  console.warn('[WARN] Falta PAGE_ACCESS_TOKEN en variables de entorno.');
}
if (!VERIFY_TOKEN) {
  console.warn('[WARN] Falta VERIFY_TOKEN en variables de entorno.');
}

// ---------------------------
// Cargar IA + knowledge (si existen)
// ---------------------------
let iaModule = null;
try {
  iaModule = require('./ia');
} catch (e) {
  console.warn('[WARN] No se pudo cargar ./ia.js. Asegúrate de que exista. Detalle:', e.message);
}

let knowledge = null;
try {
  knowledge = require('./knowledge.json');
} catch (e) {
  // knowledge es opcional
  knowledge = null;
}

// ---------------------------
// Sesiones (memoria en RAM)
// ---------------------------
const sessions = new Map();

function getSession(psid) {
  if (!sessions.has(psid)) {
    sessions.set(psid, {
      estado: 'INICIO',
      distrito: null,
      relacion: null,
      delito_probable: null,
      last_intent: null,
      last_bot_msg: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  const s = sessions.get(psid);
  s.updated_at = new Date().toISOString();
  return s;
}

// ---------------------------
// Utilitarios
// ---------------------------
const normalize = (str) =>
  (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

function distanciaEdicion(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function pareceDenuncia(texto) {
  const t = normalize(texto);
  if (!t) return false;

  // Exactos
  if (t === 'denuncia' || t === 'denunciar') return true;

  // Contiene raíz
  if (t.includes('denunc')) return true;

  // Tolerancia por distancia de edición (errores típicos: denncia, denucia, denunica)
  const candidatos = ['denuncia', 'denunciar'];
  return candidatos.some(cmd => distanciaEdicion(t, cmd) <= 2);
}

function pareceSaludo(texto) {
  const t = normalize(texto);
  return ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hi', 'hello'].includes(t);
}

// ---------------------------
// Distritos (opcional: si knowledge incluye lista)
// ---------------------------
function extraerListaDistritos(knowledgeObj) {
  if (!knowledgeObj) return [];
  // Soportamos varios formatos posibles: knowledge.distritos, knowledge.Distritos, knowledge.ubicacion.distritos, etc.
  const candidatos = [];
  const pushAll = (arr) => Array.isArray(arr) && arr.forEach(x => candidatos.push(x));

  if (Array.isArray(knowledgeObj.distritos)) pushAll(knowledgeObj.distritos);
  if (Array.isArray(knowledgeObj.Distritos)) pushAll(knowledgeObj.Distritos);

  if (knowledgeObj.ubicacion) {
    if (Array.isArray(knowledgeObj.ubicacion.distritos)) pushAll(knowledgeObj.ubicacion.distritos);
    if (Array.isArray(knowledgeObj.ubicacion.Distritos)) pushAll(knowledgeObj.ubicacion.Distritos);
  }

  // Si viene como lista de objetos: {distrito:"Cajamarca"} o similar
  const normalizados = [];
  for (const item of candidatos) {
    if (!item) continue;
    if (typeof item === 'string') normalizados.push(item);
    else if (typeof item === 'object') {
      const val = item.distrito || item.nombre || item.name || item.Distrito || item.NOMBRE;
      if (val) normalizados.push(String(val));
    }
  }
  // Unificar
  return Array.from(new Set(normalizados.map(x => x.trim()).filter(Boolean)));
}

const DISTRITOS = extraerListaDistritos(knowledge);
const DISTRITOS_NORM = DISTRITOS.map(d => ({ raw: d, norm: normalize(d) }));

function encontrarDistritoEnTexto(texto) {
  const t = normalize(texto);
  if (!t) return null;

  // match directo por inclusión
  for (const d of DISTRITOS_NORM) {
    if (d.norm && (t === d.norm || t.includes(d.norm))) return d.raw;
  }

  // tolerancia: si el usuario escribió parecido al distrito (solo cuando el texto es corto)
  if (t.length <= 25) {
    let best = null;
    for (const d of DISTRITOS_NORM) {
      if (!d.norm) continue;
      const dist = distanciaEdicion(t, d.norm);
      if (dist <= 2) {
        if (!best || dist < best.dist) best = { raw: d.raw, dist };
      }
    }
    if (best) return best.raw;
  }

  return null;
}

function ejemplosDistritos() {
  // ejemplos razonables aunque no tengamos knowledge
  const base = ['Cajamarca', 'Baños del Inca', 'Celendín', 'Chota', 'Jaén', 'Cutervo', 'San Marcos', 'Contumazá'];
  if (DISTRITOS && DISTRITOS.length) {
    // toma 6 ejemplos de tu propia lista
    return DISTRITOS.slice(0, 6).join(', ');
  }
  return base.join(', ');
}

// ---------------------------
// Envío Messenger
// ---------------------------
async function callSendAPI(senderPsid, response) {
  const requestBody = {
    recipient: { id: senderPsid },
    message: response,
  };

  return axios.post(
    `https://graph.facebook.com/v18.0/me/messages`,
    requestBody,
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

async function sendText(psid, text) {
  const msg = { text };
  await callSendAPI(psid, msg);
}

function menuInicialTexto() {
  return (
    "Hola 👋 Puedes elegir una opción del menú.\n" +
    "• Escribe *Denuncia* para contar un hecho.\n" +
    "• También puedes hacer una consulta (ubicación, horarios, teléfonos, etc.)."
  );
}

// ---------------------------
// Webhook: verificación
// ---------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[OK] WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------------------------
// Webhook: recepción de mensajes
// ---------------------------
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  const entries = body.entry || [];
  for (const entry of entries) {
    const webhookEvents = entry.messaging || [];
    for (const event of webhookEvents) {
      try {
        if (event.message) {
          await handleMessage(event.sender.id, event.message);
        } else if (event.postback) {
          await handlePostback(event.sender.id, event.postback);
        }
      } catch (err) {
        console.error('[ERROR] handle event:', err?.response?.data || err.message || err);
        // responder algo genérico para no dejar en visto
        try { await sendText(event.sender.id, "Tuve un inconveniente al procesar el mensaje. ¿Podrías intentar nuevamente?"); } catch (_) {}
      }
    }
  }

  res.status(200).send('EVENT_RECEIVED');
});

// ---------------------------
// Lógica de mensajes
// ---------------------------
async function handleMessage(senderPsid, receivedMessage) {
  const session = getSession(senderPsid);

  // Texto del usuario
  const userText = receivedMessage.text ? receivedMessage.text : '';
  const tNorm = normalize(userText);

  // 0) Ignorar mensajes vacíos
  if (!tNorm) {
    return sendText(senderPsid, "¿Podrías escribir tu mensaje en texto, por favor?");
  }

  // 1) PRIORIDAD: "Denuncia" reinicia flujo en cualquier estado (evita loop)
  if (pareceDenuncia(userText)) {
    session.estado = 'DENUNCIA_INICIO';
    session.distrito = null;
    session.relacion = null;
    session.delito_probable = null;
    session.last_intent = 'DENUNCIA';
    session.last_bot_msg = 'PIDE_HECHOS_Y_DISTRITO';
    return sendText(
      senderPsid,
      "Entendido. Cuéntame brevemente qué ocurrió y dime *en qué distrito* sucedieron los hechos."
    );
  }

  // 2) Si está esperando distrito, intentar extraerlo sin “romper” el estado
  if (session.estado === 'ESPERANDO_DISTRITO') {
    const distrito = encontrarDistritoEnTexto(userText);

    // Si no se reconoce distrito, REPREGUNTA (no llames IA ni cambies estado)
    if (!distrito) {
      session.last_bot_msg = 'REPREGUNTA_DISTRITO';
      return sendText(
        senderPsid,
        `Para ubicar la fiscalía competente, necesito el *distrito* donde ocurrieron los hechos.\nEjemplos: ${ejemplosDistritos()}.\n\nEscribe solo el distrito, por favor.`
      );
    }

    session.distrito = distrito;
    session.estado = 'DENUNCIA_CONTEXTO'; // seguimos el flujo
    // Caemos a la IA para determinar fiscalía con distrito + relato previo (si existe)
  }

  // 3) Si es inicio y saludo, mostrar menú
  if (session.estado === 'INICIO' && pareceSaludo(userText)) {
    session.last_bot_msg = 'MENU_INICIAL';
    return sendText(senderPsid, menuInicialTexto());
  }

  // 4) Si en denuncia inicio pero usuario no dio distrito, se lo pedimos
  if (session.estado === 'DENUNCIA_INICIO') {
    const distrito = encontrarDistritoEnTexto(userText);
    if (distrito) {
      session.distrito = distrito;
      session.estado = 'DENUNCIA_CONTEXTO';
    } else {
      // No reconocemos distrito: preguntamos distrito y pasamos a estado esperando distrito
      session.estado = 'ESPERANDO_DISTRITO';
      session.last_bot_msg = 'PIDE_DISTRITO';
      return sendText(senderPsid, "Indíqueme por favor *en qué distrito* ocurrieron los hechos.");
    }
  }

  // 5) En cualquier otro caso, delegamos a ia.js manteniendo compatibilidad
  const aiReply = await responderConIA(userText, session);

  // Si IA detecta que necesita distrito, fijamos estado esperando distrito
  // (esto evita loop: solo pasamos a esperar distrito, no respondemos “no pude determinar” en bucle)
  if (aiReply && aiReply.__need_district === true) {
    session.estado = 'ESPERANDO_DISTRITO';
    session.last_bot_msg = 'PIDE_DISTRITO_AI';
    return sendText(senderPsid, "Indíqueme por favor *en qué distrito* ocurrieron los hechos.");
  }

  // Respuesta normal
  if (typeof aiReply === 'string') {
    session.last_bot_msg = 'IA_TEXT';
    return sendText(senderPsid, aiReply);
  }

  if (aiReply && typeof aiReply.text === 'string') {
    session.last_bot_msg = 'IA_OBJ_TEXT';
    return sendText(senderPsid, aiReply.text);
  }

  // Fallback
  session.last_bot_msg = 'FALLBACK';
  return sendText(senderPsid, "¿Podrías contarme un poco más para poder orientarte mejor?");
}

async function handlePostback(senderPsid, receivedPostback) {
  const session = getSession(senderPsid);
  const payload = receivedPostback.payload ? normalize(receivedPostback.payload) : '';

  // Mantén tu lógica previa si ya usabas postbacks. Aquí damos soporte básico.
  if (payload === 'get_started' || payload === 'inicio') {
    session.estado = 'INICIO';
    session.distrito = null;
    session.relacion = null;
    session.delito_probable = null;
    session.last_intent = 'INICIO';
    session.last_bot_msg = 'MENU_INICIAL';
    return sendText(senderPsid, menuInicialTexto());
  }

  // Si tienes payloads del menú, podrías mapearlos aquí.
  // Por compatibilidad, lo enviamos a IA.
  const aiReply = await responderConIA(receivedPostback.payload || '', session);
  if (typeof aiReply === 'string') return sendText(senderPsid, aiReply);
  if (aiReply && typeof aiReply.text === 'string') return sendText(senderPsid, aiReply.text);
  return sendText(senderPsid, menuInicialTexto());
}

// ---------------------------
// Compatibilidad ia.js (no rompe si exportas distintos nombres)
// ---------------------------
async function responderConIA(userText, session) {
  if (!iaModule) {
    return "Aún no tengo configurada la lógica de IA. (No se pudo cargar ia.js)";
  }

  // Intentamos varios nombres de función para no romper tu proyecto.
  const candidates = [
    iaModule.handleUserMessage,
    iaModule.procesarMensaje,
    iaModule.procesarMensajeIA,
    iaModule.responder,
    iaModule.run,
    iaModule.default
  ].filter(fn => typeof fn === 'function');

  if (!candidates.length) {
    return "No encontré una función exportada en ia.js para procesar mensajes.";
  }

  const fn = candidates[0];

  // Llamada flexible: algunas implementaciones reciben (texto, session, knowledge)
  try {
    const out = await fn(userText, session, knowledge);
    return out;
  } catch (e1) {
    // fallback: (texto, session)
    try {
      const out = await fn(userText, session);
      return out;
    } catch (e2) {
      console.error('[ERROR] IA:', e2?.response?.data || e2.message || e2);
      // Señal especial: pedir distrito si IA no pudo por falta de distrito
      const msg = (e2?.message || '').toLowerCase();
      if (msg.includes('distrito')) return { __need_district: true };
      return "No pude procesar tu consulta en este momento. ¿Podrías reformularla brevemente?";
    }
  }
}

// ---------------------------
// Start server
// ---------------------------
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
