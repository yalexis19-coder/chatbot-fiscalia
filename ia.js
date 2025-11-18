require('dotenv').config();
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Mensaje seguro en caso de error
const fallbackMessage =
  "Lamento las molestias. En este momento no puedo procesar su solicitud. " +
  "Por favor, inténtelo nuevamente o comuníquese con un operador.";

// ---------------------------------------------
// FUNCIÓN PRINCIPAL: Generar respuesta con IA
// ---------------------------------------------
async function responderIA(mensajeUsuario) {

  if (!OPENAI_API_KEY) {
    console.error("❌ ERROR: No se encontró la variable OPENAI_API_KEY en .env");
    return fallbackMessage;
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",   // ✔ económico, rápido y preciso
        max_tokens: 200,        // ✔ control de costos
        temperature: 0.2,       // ✔ respuestas formales y coherentes
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente virtual del Ministerio Público – Fiscalía de Cajamarca. " +
              "Responde siempre de manera formal, clara y respetuosa. " +
              "Nunca inventes información. " +
              "Si alguien pregunta sobre un trámite oficial, ofrece orientación general, " +
              "pero evita emitir opiniones legales o juicios. " +
              "Si la pregunta no tiene relación con temas de la Fiscalía, " +
              "intenta redirigir amablemente a información útil."
          },
          {
            role: "user",
            content: mensajeUsuario
          }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    const texto = response.data.choices?.[0]?.message?.content;

    if (!texto) {
      console.error("⚠️ Respuesta vacía de OpenAI:", response.data);
      return fallbackMessage;
    }

    return texto.trim();

  } catch (error) {
    console.error("❌ Error en OpenAI:", error.response?.data || error.message);
    return fallbackMessage;
  }
}

module.exports = { responderIA };
