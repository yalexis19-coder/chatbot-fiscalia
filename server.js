require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { responderIA } = require('./ia');

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_token';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

// ------------------------------
//  SALUD
// ------------------------------
app.get('/', (req, res) => res.send('Chatbot Fiscalía — servidor activo'));

// ------------------------------
//  VERIFICACIÓN DEL WEBHOOK
// ------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// ------------------------------
//  RESPUESTAS FIJAS
// ------------------------------
function respuestasFijas(texto) {
  const msg = texto.toLowerCase().trim();

  if (msg.includes("presentar denuncia")) {
    return {
      text:
        "Para presentar una denuncia:\n\n" +
        "1️⃣ Acérquese a la sede más cercana.\n" +
        "2️⃣ Lleve su DNI.\n" +
        "3️⃣ Narre los hechos de forma clara.\n" +
        "4️⃣ No se requiere abogado.\n\n"
    };
  }

  if (msg.includes("oficinas")) {
    return {
      text:
        "📍 Oficinas de la Fiscalía en Cajamarca:\n\n" +
        "• Jr. Del Comercio 540\n" +
        "• Horario: L–V de 8:00 am a 5:00 pm\n\n"
    };
  }

  if (msg.includes("requisitos")) {
    return {
      text:
        "📄 Requisitos para denunciar:\n\n" +
        "• DNI\n" +
        "• Narración de hechos\n" +
        "• Pruebas si las tuviera\n\n"
    };
  }

  if (msg.includes("operador")) {
    return {
      text:
        "Para hablar con un operador:\n📞 RPM: 0800-12345\n📧 correo@mpfn.gob.pe\n\n"
    };
  }

  return null; // Si no coincide con ninguna palabra clave
}

// ------------------------------
//  WEBHOOK PRINCIPAL
// ------------------------------
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {

    for (let entry of body.entry) {
      for (let event of entry.messaging) {

        const sender = event.sender.id;

        if (event.message && event.message.text) {
          const texto = event.message.text;
          console.log("Mensaje del ciudadano:", texto);

// 🔵 Enviar menú con botones rápidos
await sendMessage(sender, {
  text: "Seleccione una opción:",
  quick_replies: [
    {
      content_type: "text",
      title: "Presentar denuncia",
      payload: "DENUNCIA"
    },
    {
      content_type: "text",
      title: "Oficinas",
      payload: "OFICINAS"
    },
    {
      content_type: "text",
      title: "Requisitos",
      payload: "REQUISITOS"
    },
    {
      content_type: "text",
      title: "Operador",
      payload: "OPERADOR"
    }
  ]
});



          // 1️⃣ Intentar respuesta fija
          const fija = respuestasFijas(texto);

          if (fija) {
            await sendMessage(sender, fija);
          } else {
            // 2️⃣ Si no hay respuesta fija, usar IA
            const respuestaIA = await responderIA(texto);
            await sendMessage(sender, { text: respuestaIA });
          }
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  res.sendStatus(404);
});

// ------------------------------
//  FUNCIÓN PARA ENVIAR MENSAJES
// ------------------------------
async function sendMessage(sender, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: sender },
        message
      }
    );
  } catch (error) {
    console.error("Error enviando mensaje:", error.response?.data || error.message);
  }
}

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
