// server.js
// Backend del chatbot institucional del Ministerio Público – Fiscalía de Cajamarca
// Integración con Facebook Messenger

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { responderIA } = require('./ia');

const app = express();
const PORT = process.env.PORT || 3000;

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mp_cajamarca_verify_token';

app.use(express.json());

// ---------------------------
// Sesiones en memoria
// ---------------------------
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { estado: 'INICIO', contexto: null };
  }
  return sessions[userId];
}

// ---------------------------
// Helpers – Quick Replies
// ---------------------------
// ✅ IMPORTANTE: Para no duplicar lógica ni textos en server.js,
// los quick replies se traducen a un texto simple ("1".."5") y se
// envían a responderIA(). Así, el menú/FAQ/ubicación siempre se manejan
// por ia.js (una sola fuente de verdad).
function mapQuickReplyToText(payload) {
  switch (payload) {
    case 'MENU_DENUNCIA': return '1';
    case 'MENU_UBICACION': return '2';
    case 'MENU_FAQ': return '3';
    case 'MENU_CONTACTOS': return '4';
    case 'MENU_OPERADOR': return '5';
    default: return null;
  }
}

function buildMainMenuQuickReplies() {
  return [
    { content_type: 'text', title: '📝 Denuncia', payload: 'MENU_DENUNCIA' },
    { content_type: 'text', title: '📍 Ubicación', payload: 'MENU_UBICACION' },
    { content_type: 'text', title: '❓ FAQ', payload: 'MENU_FAQ' },
    { content_type: 'text', title: '☎️ Contactos', payload: 'MENU_CONTACTOS' },
    { content_type: 'text', title: '💬 Operador (WhatsApp)', payload: 'MENU_OPERADOR' }
  ];
}

// ---------------------------
// Enviar mensaje a Messenger (con quick replies opcionales)
// ---------------------------
async function enviarMensajeMessenger(recipientId, text, quickReplies = null) {
  if (!PAGE_ACCESS_TOKEN) return;

  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const payload = {
    recipient: { id: recipientId },
    message: { text }
  };

  if (Array.isArray(quickReplies) && quickReplies.length) {
    payload.message.quick_replies = quickReplies;
  }

  await axios.post(url, payload);
}

// ---------------------------
// Salud
// ---------------------------
app.get('/', (req, res) => {
  res.send('Chatbot Fiscalía de Cajamarca – OK');
});

// ---------------------------
// Verificación Webhook
// ---------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------
// Recepción de mensajes
// ---------------------------
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry || []) {
    // ✅ OJO: puede venir más de un evento por entry
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      if (!senderId) continue;

      // Ignorar eco
      if (event.message?.is_echo) continue;

      const session = getSession(senderId);

      // ---------------------------
      // 1) POSTBACKS (GET_STARTED)
      // ---------------------------
      if (event.postback?.payload === 'GET_STARTED') {
        session.estado = 'INICIO';
        session.contexto = null;

        // ✅ Fuente única: el texto del menú y la lógica están en ia.js.
        // Enviamos un saludo para que ia.js responda con el menú principal.
        const { respuestaTexto, session: nuevaSession } = await responderIA(session, 'hola');
        sessions[senderId] = nuevaSession;

        // Quick replies opcionales (solo UI). La selección se procesa por ia.js.
        await enviarMensajeMessenger(senderId, respuestaTexto, buildMainMenuQuickReplies());
        continue; // ✅ evita caer a otros bloques
      }

      // ---------------------------
      // 2) QUICK REPLIES
      // ---------------------------
      const qrPayload = event.message?.quick_reply?.payload;
      if (qrPayload) {
        const mapped = mapQuickReplyToText(qrPayload);
        if (!mapped) {
          await enviarMensajeMessenger(senderId, 'Puede escribir su consulta o elegir una opción.');
          continue;
        }

        try {
          const { respuestaTexto, session: nuevaSession } = await responderIA(session, mapped);
          sessions[senderId] = nuevaSession;

          // Si el usuario vuelve al menú, mostramos quick replies.
          const showQR = (nuevaSession?.estado === 'INICIO');
          await enviarMensajeMessenger(senderId, respuestaTexto, showQR ? buildMainMenuQuickReplies() : null);
        } catch (e) {
          console.error('Error QR:', e);
          await enviarMensajeMessenger(
            senderId,
            'Ocurrió un inconveniente al procesar su selección. Intente nuevamente o escriba *Menú*.'
          );
        }
        continue;
      }

      // ---------------------------
      // 3) TEXTO LIBRE
      // ---------------------------
      if (event.message?.text) {
        try {
          const { respuestaTexto, session: nuevaSession } =
            await responderIA(session, event.message.text);

          sessions[senderId] = nuevaSession;
          // Si la respuesta vuelve al menú, mostramos quick replies (solo UI).
          const showQR = (nuevaSession?.estado === 'INICIO');
          await enviarMensajeMessenger(senderId, respuestaTexto, showQR ? buildMainMenuQuickReplies() : null);
        } catch (e) {
          console.error('Error texto:', e);
          await enviarMensajeMessenger(
            senderId,
            'Ocurrió un inconveniente al procesar su mensaje. Intente nuevamente.'
          );
        }
        continue; // ✅ IMPORTANTÍSIMO: evita ejecutar cualquier otra cosa después
      }
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
