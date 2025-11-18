require('dotenv').config();
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Mensaje seguro en caso de error o información no disponible
const fallbackMessage =
  "Lo siento, no puedo brindar información sobre eso. " +
  "Por favor, comuníquese con un operador de la Fiscalía para asistencia directa.";

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
        model: "gpt-4o-mini",
        max_tokens: 200,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente virtual oficial del Ministerio Público – Fiscalía de Cajamarca. " +
              "Responde de manera clara, formal y respetuosa. " +
              "Solo proporciona información basada en procedimientos y datos públicos oficiales. " +
              "Nunca inventes información ni nombres de personas o casos reales. " +
              "Si alguien pregunta sobre trámites legales, proporciona orientación general y recuerda que para casos específicos debe acudir a un operador humano. " +
              "Si la pregunta no es sobre la Fiscalía, indica amablemente que solo puedes ayudar con trámites y consultas oficiales."
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

    let texto = response.data.choices?.[0]?.message?.content;

    // Validación adicional para evitar respuestas vacías o inventadas
    if (!texto || texto.toLowerCase().includes("no sé") || texto.length < 5) {
      return fallbackMessage;
    }

    return texto.trim();

  } catch (error) {
    console.error("❌ Error en OpenAI:", error.response?.data || error.message);
    return fallbackMessage;
  }
}

module.exports = { responderIA };
