/**
 * ChatbotFiscalia - ia.js
 * Analiza el texto del ciudadano y devuelve un JSON estructurado para que server.js controle el flujo.
 *
 * Usa OpenAI Responses/Chat Completions vía fetch. (Node 18+)
 *
 * Env vars:
 * - OPENAI_API_KEY
 * - OPENAI_MODEL (opcional, default: gpt-4o-mini)
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

function stripCodeFences(s) {
  return (s || "").replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
}

/**
 * Devuelve:
 * {
 *   materia: "penal"|"familia"|"ambiental"|"corrupcion"|...,
 *   caso: string,
 *   requiere_distrito: boolean,
 *   requiere_vinculo_familiar: boolean,
 *   resumen_ciudadano: string
 * }
 */
async function analyzeMessage({ userText, sessionContext = {} }) {
  // Fallback si no hay API key: regla heurística básica para familia
  if (!OPENAI_API_KEY) {
    const t = (userText || "").toLowerCase();
    const esFamilia =
      t.includes("no puedo ver a mi hijo") ||
      t.includes("no puedo ver a mi hija") ||
      t.includes("no me deja ver") ||
      t.includes("tenencia") ||
      t.includes("visitas") ||
      t.includes("régimen de visitas") ||
      t.includes("pensión") ||
      t.includes("alimentos") ||
      t.includes("custodia");
    return {
      materia: esFamilia ? "familia" : (sessionContext.materia || "penal"),
      caso: esFamilia ? "visitas/tenencia o impedimento de contacto" : "orientación general",
      requiere_distrito: !sessionContext.distrito,
      requiere_vinculo_familiar: esFamilia,
      resumen_ciudadano: "Gracias por tu mensaje. Puedo orientarte de forma general con la información brindada.",
    };
  }

  const system = `
Eres un asistente institucional del Ministerio Público (Perú). Tu tarea es CLASIFICAR la consulta del ciudadano para orientar el flujo del chatbot.
NO des asesoría legal compleja ni cites artículos. Usa lenguaje neutral y respetuoso.

Devuelve SIEMPRE un JSON válido (sin markdown, sin texto extra) con estas claves EXACTAS:
- materia: una de ["penal","familia","ambiental","corrupcion","derechos_humanos","crimen_organizado","extincion_dominio","otra"]
- caso: texto corto (máx 12 palabras) describiendo el tema (ej. "impedimento de ver a hijo", "lesiones", "amenazas")
- requiere_distrito: true/false (si el distrito es necesario para orientar sede/fiscalía y no está en contexto)
- requiere_vinculo_familiar: true/false (si se necesita saber relación familiar/pareja para orientar)
- resumen_ciudadano: 1–2 oraciones, humanas e institucionales, sin tecnicismos.

Reglas importantes:
- Si el ciudadano menciona no poder ver a su hijo/hija, visitas, tenencia, pensión de alimentos, custodia: materia="familia".
- Si menciona violencia contra la mujer o integrantes del grupo familiar: materia puede ser "familia" (orientación inicial).
- Si habla de delitos ambientales: "ambiental". Corrupción: "corrupcion".
- Si no estás seguro, usa "penal" u "otra" pero sé conservador.

Contexto disponible (puede venir vacío):
- distrito: ${JSON.stringify(sessionContext.distrito || null)}
- materia_actual: ${JSON.stringify(sessionContext.materia || null)}
- stage: ${JSON.stringify(sessionContext.stage || null)}
`.trim();

  const user = `
Texto del ciudadano:
${userText}
`.trim();

  // Usamos Chat Completions (compatible)
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ OpenAI error:", res.status, txt);

    // fallback
    return {
      materia: sessionContext.materia || "penal",
      caso: "orientación general",
      requiere_distrito: !sessionContext.distrito,
      requiere_vinculo_familiar: false,
      resumen_ciudadano: "Gracias por tu mensaje. Puedo orientarte de forma general con la información brindada.",
    };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(stripCodeFences(content));

  // Normalizar y validar
  const out = parsed && typeof parsed === "object" ? parsed : {};

  const materia = typeof out.materia === "string" ? out.materia : (sessionContext.materia || "penal");
  const caso = typeof out.caso === "string" ? out.caso : "orientación general";
  const requiere_distrito = typeof out.requiere_distrito === "boolean" ? out.requiere_distrito : !sessionContext.distrito;
  const requiere_vinculo_familiar = typeof out.requiere_vinculo_familiar === "boolean" ? out.requiere_vinculo_familiar : false;
  const resumen_ciudadano =
    typeof out.resumen_ciudadano === "string" && out.resumen_ciudadano.trim()
      ? out.resumen_ciudadano.trim()
      : "Gracias por tu mensaje. Puedo orientarte de forma general con la información brindada.";

  return { materia, caso, requiere_distrito, requiere_vinculo_familiar, resumen_ciudadano };
}

module.exports = { analyzeMessage };
