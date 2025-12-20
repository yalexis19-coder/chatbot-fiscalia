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

function esSaludo(texto) {
  const t = normalize(texto);
  return [
    'hola',
    'buenas',
    'buenos dias',
    'buenas tardes',
    'buenas noches',
    'inicio',
    'empezar',
    'menu',
    'menú'
  ].includes(t);
}

function esComandoReinicio(texto) {
  const t = normalize(texto);
  return ['fin', 'cancelar', 'reiniciar', 'salir', 'nuevo', 'empezar de nuevo'].includes(t);
}

// Heurística: temas de familia tratados como CASO (no consulta informativa)
function pareceCasoFamilia(texto) {
  const t = normalize(texto);
  const claves = [
    'no me deja ver',
    'me impide ver',
    'no me permite ver',
    'regimen de visitas',
    'régimen de visitas',
    'visitas',
    'tenencia',
    'custodia',
    'alimentos',
    'pension',
    'pensión',
    'demanda de alimentos',
    'filiacion',
    'filiación',
    'reconocimiento',
    'hijo',
    'hija',
    'menor',
    'mi bebe',
    'mi bebé'
  ];
  return claves.some((k) => t.includes(normalize(k)));
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
  // Asegurar contexto base
  if (!session.contexto) {
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };
  }

  // ---------------------------
  // Reinicio por saludo o comando
  // ---------------------------
  if (esSaludo(texto) || esComandoReinicio(texto)) {
    session.estado = 'INICIO';
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };

    return {
      respuestaTexto:
        'Hola, soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca.\n\n' +
        'Puedo orientarte para presentar una denuncia o brindarte información.\n' +
        'Cuéntame brevemente qué ocurrió o qué necesitas.',
      session
    };
  }

  // ---------------------------
  // Inicio / Relato
  // ---------------------------
  if (session.estado === 'INICIO' || session.estado === 'ESPERANDO_RELATO') {
    // Casos de familia → se tratan como relato
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'Familia';
      session.contexto.delitoEspecifico = null;
      session.contexto.distritoTexto = null;
      session.estado = 'ESPERANDO_DISTRITO';

      return {
        respuestaTexto:
          'Entiendo la situación.\n\n' +
          'Para orientarte correctamente, indícame en qué **distrito** ocurrieron los hechos ' +
          '(por ejemplo: Cajamarca, Baños del Inca, La Encañada).',
        session
      };
    }

    // Clasificación IA
    const clasif = await clasificarMensaje(texto);

    session.contexto.delitoEspecifico = clasif.delito_especifico;
    session.contexto.materiaDetectada = clasif.materia;
    session.contexto.distritoTexto = clasif.distrito || null;

    if (!session.contexto.materiaDetectada && !session.contexto.delitoEspecifico) {
      session.estado = 'ESPERANDO_RELATO';
      return {
        respuestaTexto:
          'Para ayudarte mejor, ¿podrías contarme un poco más sobre lo ocurrido?',
        session
      };
    }

    session.estado = 'DERIVACION';
  }

  // ---------------------------
  // Derivación / Distrito
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

    // Fallback seguro
    session.estado = 'ESPERANDO_RELATO';
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };

    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente con la información brindada.\n\n' +
        'Si deseas, puedes describir nuevamente el caso o escribir "menu" para empezar de nuevo.',
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
        respuestaTexto: 'Por favor responde solo **"sí"** o **"no"**.',
        session
      };
    }

    session.contexto.vinculoRespuesta = resp;
    session.estado = 'DERIVACION';

    return responderIA(session, session.contexto.distritoTexto || texto);
  }

  // ---------------------------
  // Default
  // ---------------------------
  return {
    respuestaTexto:
      'Puedes contarme tu caso para orientarte, o escribir "menu" para iniciar nuevamente.',
    session
  };
}

module.exports = { responderIA };
