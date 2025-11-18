// ia.js — Procesa preguntas en lenguaje natural usando OpenAI

require('dotenv').config();
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Función principal de IA
async function responderIA(preguntaUsuario) {
  try {
    const respuesta = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente de la Fiscalía de Cajamarca. " +
              "Responde de forma clara, formal, útil y sin inventar información. " + 
              "Si no tienes un dato exacto, invita al usuario a contactar a un operador."
          },
          {
            role: "user",
            content: preguntaUsuario
          }
        ],
        max_tokens: 200
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    return respuesta.data.choices[0].message.content;

  } catch (error) {
    console.error("Error IA:", error.response?.data || error.message);
    return "Hubo un inconveniente procesando la consulta. Intente nuevamente o contacte a un operador.";
  }
}

module.exports = { responderIA };
