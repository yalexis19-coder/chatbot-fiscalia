require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_token';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

// Simple health check
app.get('/', (req, res) => res.send('Chatbot Fiscalía — servidor activo'));

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook events (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      if (!entry.messaging) continue;
      for (const event of entry.messaging) {
        const sender = event.sender.id;
        if (event.message && event.message.text) {
          // Simple echo + menu prompt
          const text = event.message.text;
          await callSendAPI(sender, { text: `Recibimos: ${text}\nSeleccione una opción escribiendo: presentar denuncia / oficinas / requisitos / operador` });
        } else if (event.postback) {
          await callSendAPI(sender, { text: 'Postback recibido: ' + event.postback.payload });
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Send API helper
async function callSendAPI(sender_psid, response) {
  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: sender_psid },
      message: response
    });
  } catch (err) {
    console.error('Send API error:', err.response ? err.response.data : err.message);
  }
}

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
