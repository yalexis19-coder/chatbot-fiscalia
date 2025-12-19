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
    const event = entry.messaging && entry.messaging[0];
    if (!event) continue;

    const senderId = event.sender?.id;
    if (!senderId) continue;

    // Ignorar eco
    if (event.message?.is_echo) continue;

    const session = getSession(senderId);

    // ---------------------------
    // Quick Replies
    // ---------------------------
    const qrPayload = event.message?.quick_reply?.payload;
    if (qrPayload) {
      if (qrPayload === 'MENU_DENUNCIA') {
        session.estado = 'ESPERANDO_RELATO';
        session.contexto = null;

        await enviarMensajeMessenger(
          senderId,
          'Por favor, cuénteme brevemente qué ocurrió.'
        );
        continue;
      }

      await enviarMensajeMessenger(
        senderId,
        'Puede escribir su consulta o elegir una opción.'
      );
      continue;
    }

    // ---------------------------
    // Texto libre
    // ---------------------------
    if (event.message?.text) {
      try {
        const { respuestaTexto, session: nuevaSession } =
          await responderIA(session, event.message.text);

        sessions[senderId] = nuevaSession;
        await enviarMensajeMessenger(senderId, respuestaTexto);
      } catch (e) {
        await enviarMensajeMessenger(
          senderId,
          'Ocurrió un inconveniente al procesar su mensaje. Intente nuevamente.'
        );
      }
    }

    // ---------------------------
    // GET_STARTED
    // ---------------------------
    if (event.postback?.payload === 'GET_STARTED') {
      session.estado = 'INICIO';
      session.contexto = null;

      const bienvenida =
        'Paz y bien. Soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca.\n\n' +
        'Puedo orientarle sobre dónde presentar una denuncia, trámites, preguntas frecuentes y datos de contacto.';

      const menu = [
        { content_type: 'text', title: '📝 Denuncia', payload: 'MENU_DENUNCIA' },
        { content_type: 'text', title: '📍 Ubicación de fiscalía', payload: 'MENU_UBICACION' },
        { content_type: 'text', title: '❓ Preguntas frecuentes', payload: 'MENU_FAQ' },
        { content_type: 'text', title: '📄 Trámites', payload: 'MENU_TRAMITES' },
        { content_type: 'text', title: '☎️ Contactos', payload: 'MENU_CONTACTOS' }
      ];

      await enviarMensajeMessenger(senderId, bienvenida, menu);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
