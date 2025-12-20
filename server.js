// server.js
// Backend del chatbot institucional del Ministerio Público – Fiscalía de Cajamarca (Messenger)

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { responderIA } = require('./ia');

const app = express();
const PORT = process.env.PORT || 3000;

// Tokens de entorno
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mp_cajamarca_verify_token';

app.use(express.json());

// Sesiones en memoria (PSID)
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { estado: 'INICIO', contexto: null };
  }
  return sessions[userId];
}

const MENU_QUICK_REPLIES = [
  { content_type: 'text', title: 'Denuncia', payload: 'MENU_DENUNCIA' },
  { content_type: 'text', title: 'Ubicación', payload: 'MENU_UBICACION' },
  { content_type: 'text', title: 'Trámites', payload: 'MENU_TRAMITES' },
  { content_type: 'text', title: 'FAQ', payload: 'MENU_FAQ' },
  { content_type: 'text', title: 'Contacto', payload: 'MENU_CONTACTO' }
];

async function enviarMensajeMessenger(recipientId, text, quickReplies = null) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('❌ PAGE_ACCESS_TOKEN no configurado.');
    return;
  }

  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const message = { text };
  if (Array.isArray(quickReplies) && quickReplies.length) {
    message.quick_replies = quickReplies;
  }

  const payload = {
    recipient: { id: recipientId },
    message
  };

  try {
    await axios.post(url, payload);
    console.log(`✅ Mensaje enviado a ${recipientId}: ${text}`);
  } catch (err) {
    console.error('❌ Error al enviar mensaje a Messenger:', err?.response?.data || err.message);
  }
}

// Salud
app.get('/', (req, res) => res.send('Chatbot Fiscalía de Cajamarca – OK'));

// Webhook verify
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado.');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook POST
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry || []) {
    const webhookEvent = entry.messaging && entry.messaging[0];
    if (!webhookEvent) continue;

    const senderId = webhookEvent.sender && webhookEvent.sender.id;
    if (!senderId) continue;

    // ignorar eco
    if (webhookEvent.message && webhookEvent.message.is_echo) continue;

    const session = getSession(senderId);

    try {
      // 1) QUICK REPLIES (botones del menú)
      if (webhookEvent.message && webhookEvent.message.quick_reply && webhookEvent.message.quick_reply.payload) {
        const payload = webhookEvent.message.quick_reply.payload;

        // Inicializar contexto si no existe
        if (!session.contexto) session.contexto = {};

        if (payload === 'MENU_DENUNCIA') {
          session.estado = 'ESPERANDO_RELATO';
          session.contexto = null;
          await enviarMensajeMessenger(
            senderId,
            'De acuerdo. Cuéntame brevemente qué ocurrió (sin datos sensibles) y, si puedes, el distrito donde sucedió.'
          );
          continue;
        }

        if (payload === 'MENU_UBICACION') {
          session.estado = 'CONSULTA_PENDIENTE';
          session.contexto.ultimaConsulta = { tipo: 'fiscalia', campo: 'direccion' };
          await enviarMensajeMessenger(
            senderId,
            'Perfecto. ¿De qué distrito o provincia necesitas la ubicación de la fiscalía? (Ej.: Cajabamba, San Marcos, Cajamarca)'
          );
          continue;
        }

        if (payload === 'MENU_TRAMITES') {
          session.estado = 'CONSULTA_PENDIENTE';
          session.contexto.ultimaConsulta = { tipo: 'procedimiento' };
          await enviarMensajeMessenger(senderId, 'Perfecto. ¿Qué trámite necesitas (por ejemplo: “poner una denuncia”, “denuncia por violencia”, etc.)?');
          continue;
        }

        if (payload === 'MENU_FAQ') {
          session.estado = 'CONSULTA_PENDIENTE';
          session.contexto.ultimaConsulta = { tipo: 'faq' };
          await enviarMensajeMessenger(senderId, 'Claro. Escríbeme tu pregunta (FAQ) y te respondo.');
          continue;
        }

        if (payload === 'MENU_CONTACTO') {
          session.estado = 'CONSULTA_PENDIENTE';
          session.contexto.ultimaConsulta = { tipo: 'contacto' };
          await enviarMensajeMessenger(senderId, 'Perfecto. ¿De qué distrito o fiscalía necesitas el contacto?');
          continue;
        }
      }

      // 2) MENSAJES DE TEXTO
      if (webhookEvent.message && webhookEvent.message.text) {
        const texto = webhookEvent.message.text;

        const { respuestaTexto, session: nuevaSession } = await responderIA(session, texto);
        sessions[senderId] = nuevaSession;

        await enviarMensajeMessenger(senderId, respuestaTexto);
        continue;
      }

      // 3) POSTBACKS (GET_STARTED)
      if (webhookEvent.postback && webhookEvent.postback.payload) {
        const payload = webhookEvent.postback.payload;

        if (payload === 'GET_STARTED') {
          session.estado = 'INICIO';
          session.contexto = null;

          const bienvenida =
            'Hola, soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca.\n' +
            'Elige una opción para empezar:';

          await enviarMensajeMessenger(senderId, bienvenida, MENU_QUICK_REPLIES);
        }
      }
    } catch (err) {
      console.error('❌ Error general:', err);
      await enviarMensajeMessenger(
        senderId,
        'Ha ocurrido un inconveniente al procesar tu mensaje. Por favor, inténtalo nuevamente en unos momentos.'
      );
    }
  }

  return res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
