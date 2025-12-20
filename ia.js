/**
 * ChatbotFiscalia - ia.js (v2)
 * Clasificación de intención / materia
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function analyzeMessage({ userText, sessionContext }) {
  const t = userText.toLowerCase();

  // Heurística rápida para familia
  if (
    t.includes("mi hijo") ||
    t.includes("mi hija") ||
    t.includes("ver a mi hijo") ||
    t.includes("tenencia") ||
    t.includes("visitas") ||
    t.includes("alimentos")
  ) {
    return {
      materia: "familia",
      requiere_distrito: !sessionContext.distrito
    };
  }

  return {
    materia: "penal",
    requiere_distrito: !sessionContext.distrito
  };
}

module.exports = { analyzeMessage };
