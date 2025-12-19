// server.js
// Backend del chatbot institucional del Ministerio Público – Fiscalía de Cajamarca
// para integrar con Facebook Messenger.

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { responderIA } = require('./ia');

const app = express();
const PORT = process.env.PORT || 3000;

// Tokens de entorno
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // Token de la página de Facebook
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mp_cajamarca_verify_token';

if (!PAGE_ACCESS_TOKEN) {
  console.warn('⚠️  PAGE_ACCESS_TOKEN no está definido en las variables de entorno.');
}
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY no está definido en las variables de entorno.');
}

// Para parsear JSON del webhook
app.use(express.json());

// Almacén simple de sesiones en memoria (por PSID de Messenger)
const sessions = {};

// ---------------------------
// Utilidades
// ---------------------------

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      estado: 'INICIO',
      contexto: null
    };
  }
  return sessions[userId];
}

/**
 * Envía un mensaje de texto a un usuario de Messenger
 */
async function enviarMensajeMessenger(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('❌ PAGE_ACCESS_TOKEN no configurado, no se puede enviar el mensaje.');
    return;
  }

  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const payload = {
    recipient: { id: recipientId },
    message: { text }
  };

  try {
    await axios.post(url, payload);
    console.log(`✅ Mensaje enviado a ${recipientId}: ${text}`);
  } catch (err) {
    console.error('❌ Error al enviar mensaje a Messenger:', err?.response?.data || err.message);
  }
}

// ---------------------------
// Endpoint de salud
// ---------------------------

app.get('/', (req, res) => {
  res.send('Chatbot Fiscalía de Cajamarca – OK');
});

// ---------------------------
// Verificación del Webhook (GET)
// ---------------------------

app.get('/webhook', (req, res) => {
  // Parámetros enviados por Meta al configurar el webhook
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Verificar si el modo y token son correctos
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente.');
      res.status(200).send(challenge);
    } else {
      console.warn('⚠️ Intento de verificación con token incorrecto.');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// ---------------------------
// Recepción de mensajes (POST)
// ---------------------------

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Verificar que el evento proviene de una página
  if (body.object === 'page') {
    // Iterar sobre las entradas (por si llegan varias)
    for (const entry of body.entry || []) {
      const webhookEvent = entry.messaging && entry.messaging[0];
      if (!webhookEvent) continue;

      const senderId = webhookEvent.sender && webhookEvent.sender.id;
      if (!senderId) continue;

      console.log('📩 Evento recibido:', JSON.stringify(webhookEvent, null, 2));

      // Ignorar mensajes de eco (enviados por la propia página)
      if (webhookEvent.message && webhookEvent.message.is_echo) {
        continue;
      }

      // Manejo de mensajes de texto
      if (webhookEvent.message && webhookEvent.message.text) {
        const texto = webhookEvent.message.text;

        // Recuperar o crear sesión
        const session = getSession(senderId);

        try {
          const { respuestaTexto, session: nuevaSession } = await responderIA(session, texto);
          sessions[senderId] = nuevaSession; // guardar cambios en la sesión

          await enviarMensajeMessenger(senderId, respuestaTexto);
        } catch (err) {
          console.error('❌ Error en responderIA:', err);
          await enviarMensajeMessenger(
            senderId,
            'Ha ocurrido un inconveniente al procesar su mensaje. Por favor, inténtelo nuevamente en unos momentos.'
          );
        }
      }

      // Manejo de postbacks (ej. botón "Empezar")
      if (webhookEvent.postback && webhookEvent.postback.payload) {
        const payload = webhookEvent.postback.payload;
        const session = getSession(senderId);

        if (payload === 'GET_STARTED') {
          // Reiniciar sesión y enviar mensaje de bienvenida
          session.estado = 'INICIO';
          session.contexto = null;

          const bienvenida =
            'Paz y bien. Soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca. ' +
            'Puedo orientarle sobre dónde presentar una denuncia, dudas frecuentes, trámites y datos de contacto de las fiscalías.\n\n' +
            'Por favor, cuénteme brevemente qué ha ocurrido o en qué necesita orientación.';

          await enviarMensajeMessenger(senderId, bienvenida);
        } else {
          // Otros posibles payloads futuros
          await enviarMensajeMessenger(
            senderId,
            'Gracias por comunicarse con el Ministerio Público – Fiscalía de Cajamarca. Por favor, cuénteme brevemente su consulta o denuncia para poder orientarle.'
          );
        }
      }
    }

    // Responder 200 OK siempre que el evento venga de "page"
    res.sendStatus(200);
  } else {
    // No es de tipo page
    res.sendStatus(404);
  }
});

// ---------------------------
// Iniciar servidor
// ---------------------------

app.listen(PORT, () => {
  console.log(`🚀 Servidor del chatbot escuchando en el puerto ${PORT}`);
});
