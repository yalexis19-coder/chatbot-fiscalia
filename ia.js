// ia.js
// Lógica principal de IA – Fiscalía de Cajamarca

const OpenAI = require('openai');
const { resolverFiscalia } = require('./derivacion');
const knowledge = require('./knowledge.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Utilitarios
// ---------------------------
const normalize = (str) =>
  (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

function esRespuestaSiNo(texto) {
  const t = normalize(texto);
  if (t === 'si' || t === 'sí') return 'SI';
  if (t === 'no') return 'NO';
  return null;
}

function pareceCasoFamilia(texto) {
  return [
    'no me deja ver',
    'me impide ver',
    'regimen de visitas',
    'tenencia',
    'custodia',
    'alimentos',
    'pension',
    'hijo',
    'hija',
    'menor'
  ].some(k => normalize(texto).includes(k));
}

// ---------------------------
// Clasificador IA
// ---------------------------
async function clasificarMensaje(texto) {
  const system = `
Devuelve SOLO este JSON:
{
 "tipo": "denuncia" | "consulta" | "otro",
 "delito_especifico": string | null,
 "materia": "Penal" | "Familia" | "Violencia Familiar" | null,
 "distrito": string | null
}`.trim();

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: texto }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}

// ---------------------------
// Flujo principal
// ---------------------------
async function responderIA(session, texto) {
  if (!session.contexto) {
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };
  }

  // ---------------------------
  // Inicio / Relato
  // ---------------------------
  if (session.estado === 'INICIO' || session.estado === 'ESPERANDO_RELATO') {
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'Familia';
      session.estado = 'ESPERANDO_DISTRITO';

      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    }

    const clasif = await clasificarMensaje(texto);

    session.contexto.delitoEspecifico = clasif.delito_especifico;
    session.contexto.materiaDetectada = clasif.materia;
    session.contexto.distritoTexto = clasif.distrito;

    session.estado = 'DERIVACION';
  }

  // ---------------------------
  // Derivación
  // ---------------------------
  if (session.estado === 'DERIVACION' || session.estado === 'ESPERANDO_DISTRITO') {
    if (!session.contexto.distritoTexto) {
      session.contexto.distritoTexto = texto;
    }

    const res = resolverFiscalia(session.contexto);

    if (res.status === 'ASK_VINCULO') {
      session.estado = 'ESPERANDO_VINCULO';
      return { respuestaTexto: res.mensaje, session };
    }

    if (res.status === 'ASK_DISTRITO') {
      session.estado = 'ESPERANDO_DISTRITO';
      return { respuestaTexto: res.mensaje, session };
    }

    if (res.status === 'OK') {
      session.estado = 'FINAL';
      return { respuestaTexto: res.mensaje, session };
    }

    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente. ¿Podría describir nuevamente el caso?',
      session
    };
  }

  // ---------------------------
  // Vínculo familiar
  // ---------------------------
  if (session.estado === 'ESPERANDO_VINCULO') {
    const resp = esRespuestaSiNo(texto);
    if (!resp) {
      return {
        respuestaTexto: 'Por favor responda solo "sí" o "no".',
        session
      };
    }

    session.contexto.vinculoRespuesta = resp;
    session.estado = 'DERIVACION';

    return responderIA(session, texto);
  }

  // ---------------------------
  // Default
  // ---------------------------
  return {
    respuestaTexto:
      'Puede contarme su caso o elegir la opción 📝 Denuncia para iniciar.',
    session
  };
}

module.exports = { responderIA };
