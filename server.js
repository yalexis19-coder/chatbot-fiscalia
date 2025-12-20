// server.js
// Backend del chatbot institucional del Ministerio Público – Fiscalía de Cajamarca
// Integración con Facebook Messenger.

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { responderIA } = require('./ia');

const app = express();
const PORT = process.env.PORT || 3000;

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mp_cajamarca_verify_token';

if (!PAGE_ACCESS_TOKEN) console.warn('⚠️ PAGE_ACCESS_TOKEN no está definido.');
if (!process.env.OPENAI_API_KEY) console.warn('⚠️ OPENAI_API_KEY no está definido.');

app.use(express.json());

// ---------------------------
// Sesiones en memoria (PSID)
// ---------------------------
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { estado: 'INICIO', contexto: null };
  }
  return sessions[userId];
}

function normalize(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------
// Messenger send (texto + quick replies)
// ---------------------------
async function enviarMensajeMessenger(recipientId, text, quickReplies = null) {
  if (!PAGE_ACCESS_TOKEN) return;

  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const payload = {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { text }
  };

  if (Array.isArray(quickReplies) && quickReplies.length) {
    payload.message.quick_replies = quickReplies;
  }

  try {
    await axios.post(url, payload);
  } catch (err) {
    console.error('❌ Error al enviar mensaje:', err?.response?.data || err.message);
  }
}

// ---------------------------
// Menú inicial (Quick Replies)
// ---------------------------
const MENU_QUICK_REPLIES = [
  { content_type: 'text', title: '📝 Denuncia', payload: 'MENU_DENUNCIA' },
  { content_type: 'text', title: '📍 Ubicación de fiscalía', payload: 'MENU_UBICACION' },
  { content_type: 'text', title: '❓ Preguntas frecuentes', payload: 'MENU_FAQ' },
  { content_type: 'text', title: '📄 Trámites', payload: 'MENU_TRAMITES' },
  { content_type: 'text', title: '☎️ Contactos', payload: 'MENU_CONTACTO' }
];

async function enviarMenuInicial(senderId) {
  const texto =
    'Hola, soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca.\n\n' +
    'Elige una opción para empezar o escribe tu consulta:';
  await enviarMensajeMessenger(senderId, texto, MENU_QUICK_REPLIES);
}

function esPedidoDeMenu(texto) {
  const t = normalize(texto);
  return ['menu', 'menú', 'inicio', 'empezar', 'hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches'].includes(t);
}

// ---------------------------
// Salud
// ---------------------------
app.get('/', (req, res) => {
  res.send('Chatbot Fiscalía de Cajamarca – OK');
});

// ---------------------------
// Webhook verify (GET)
// ---------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------
// Webhook receive (POST)
// ---------------------------
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const senderId = ev.sender?.id;
      if (!senderId) continue;

      // Ignorar eco
      if (ev.message?.is_echo) continue;

      const session = getSession(senderId);

      try {
        // 1) GET_STARTED
        if (ev.postback?.payload === 'GET_STARTED') {
          sessions[senderId] = { estado: 'INICIO', contexto: null };
          await enviarMenuInicial(senderId);
          continue;
        }

        // 2) QUICK REPLIES
        const qrPayload = ev.message?.quick_reply?.payload;
        if (qrPayload) {
          const cmdMap = {
            MENU_DENUNCIA: '__MENU_DENUNCIA__',
            MENU_UBICACION: '__MENU_UBICACION__',
            MENU_FAQ: '__MENU_FAQ__',
            MENU_TRAMITES: '__MENU_TRAMITES__',
            MENU_CONTACTO: '__MENU_CONTACTO__'
          };

          const cmd = cmdMap[qrPayload];
          if (!cmd) {
            await enviarMenuInicial(senderId);
            continue;
          }

          const { respuestaTexto, session: nuevaSession } = await responderIA(session, cmd);
          sessions[senderId] = nuevaSession;
          await enviarMensajeMessenger(senderId, respuestaTexto);
          continue;
        }

        // 3) TEXTO NORMAL
        if (ev.message?.text) {
          const texto = ev.message.text;

          // Si piden menú por texto → mostrar menú
          if (esPedidoDeMenu(texto)) {
            await enviarMenuInicial(senderId);
            continue;
          }

          const { respuestaTexto, session: nuevaSession } = await responderIA(session, texto);
          sessions[senderId] = nuevaSession;
          await enviarMensajeMessenger(senderId, respuestaTexto);
          continue;
        }

        // 4) Cualquier otro evento → menú
        await enviarMenuInicial(senderId);
      } catch (err) {
        console.error('❌ Error general:', err);
        await enviarMensajeMessenger(
          senderId,
          'Ha ocurrido un inconveniente al procesar tu mensaje. Por favor, inténtalo nuevamente.'
        );
      }
    }
  }

  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
