// ia.js
// Lógica del chatbot institucional – Ministerio Público – Fiscalía de Cajamarca

const OpenAI = require('openai');
const { resolverFiscalia } = require('./derivacion');
const knowledge = require('./knowledge.json');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --------------------------------------------------
// Utilitarios
// --------------------------------------------------

const normalize = (str) =>
  (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

function esSaludo(texto) {
  return [
    'hola', 'buenas', 'buenos dias', 'buenas tardes',
    'buenas noches', 'menu', 'menú', 'inicio'
  ].includes(normalize(texto));
}

function esComandoReinicio(texto) {
  return ['fin', 'cancelar', 'reiniciar', 'salir', 'nuevo'].includes(normalize(texto));
}

function esRespuestaSiNo(texto) {
  const t = normalize(texto);
  if (t === 'si' || t === 'sí') return 'SI';
  if (t === 'no') return 'NO';
  return null;
}

// --------------------------------------------------
// Heurísticas
// --------------------------------------------------

function pareceCasoFamilia(texto) {
  const t = normalize(texto);
  const claves = [
    'no me deja ver',
    'me impide ver',
    'regimen de visitas',
    'tenencia',
    'custodia',
    'alimentos',
    'pension',
    'pensión',
    'filiacion',
    'reconocimiento',
    'mi hijo',
    'mi hija',
    'menor'
  ];
  return claves.some(k => t.includes(normalize(k)));
}

function pareceConsultaInformativa(texto) {
  const t = normalize(texto);
  const claves = [
    'ubicacion', 'ubicación', 'direccion', 'dirección',
    'horario', 'telefono', 'teléfono',
    'tramite', 'trámite', 'requisitos',
    'faq', 'pregunta', 'duda',
    'contacto', 'correo', 'email'
  ];
  return claves.some(k => t.includes(k));
}

// --------------------------------------------------
// Clasificador IA (solo cuando hace falta)
// --------------------------------------------------

async function clasificarMensaje(texto) {
  const system = `
Devuelve SOLO este JSON:
{
  "tipo": "denuncia" | "consulta" | "otro",
  "delito_especifico": string | null,
  "materia": "Penal" | "Familia" | "Violencia Familiar" | null,
  "distrito": string | null
}`.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: texto }
    ]
  });

  return JSON.parse(completion.choices[0].message.content);
}

// --------------------------------------------------
// Router de consultas informativas
// --------------------------------------------------

function responderConsulta(texto, session) {
  const t = normalize(texto);

  // Ubicación / fiscalía
  if (t.includes('ubicacion') || t.includes('ubicación') || t.includes('direccion') || t.includes('dirección')) {
    session.estado = 'CONSULTA_UBICACION';
    return {
      respuestaTexto:
        'Claro. ¿De qué distrito o provincia necesitas la ubicación de la fiscalía? (Ej.: Cajabamba, San Marcos, Cajamarca)',
      session
    };
  }

  // Trámites
  if (t.includes('tramite') || t.includes('trámite') || t.includes('requisitos')) {
    session.estado = 'CONSULTA_TRAMITE';
    return {
      respuestaTexto:
        'De acuerdo. ¿Sobre qué trámite necesitas información? (por ejemplo: “poner una denuncia”, “denuncia por violencia familiar”)',
      session
    };
  }

  // FAQ
  if (t.includes('faq') || t.includes('pregunta') || t.includes('duda')) {
    session.estado = 'CONSULTA_FAQ';
    return {
      respuestaTexto:
        'Claro. Escríbeme tu pregunta y te respondo.',
      session
    };
  }

  // Contacto
  if (t.includes('contacto') || t.includes('correo') || t.includes('email')) {
    session.estado = 'CONSULTA_CONTACTO';
    return {
      respuestaTexto:
        'Perfecto. ¿De qué fiscalía o entidad necesitas el contacto?',
      session
    };
  }

  return {
    respuestaTexto:
      '¿Deseas presentar una denuncia o necesitas información (ubicación, trámites, preguntas frecuentes, contacto)?',
    session
  };
}

// --------------------------------------------------
// Flujo principal
// --------------------------------------------------

async function responderIA(session, texto) {
  // Inicializar contexto
  if (!session.contexto) {
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };
  }

  // --------------------------------------------------
  // Reinicio
  // --------------------------------------------------
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
        'Puedes contarme tu caso para orientarte o decirme qué información necesitas.',
      session
    };
  }

  // --------------------------------------------------
  // CONSULTAS (informativas)
  // --------------------------------------------------
  if (session.estado?.startsWith('CONSULTA')) {
    // Ubicación
    if (session.estado === 'CONSULTA_UBICACION') {
      session.estado = 'INICIO';
      return {
        respuestaTexto:
          'Gracias. Puedes acercarte a la Fiscalía de la provincia o distrito indicado. ' +
          'Si deseas, dime el distrito exacto y te doy la dirección específica.',
        session
      };
    }

    // Trámite / FAQ / Contacto (placeholder estable)
    session.estado = 'INICIO';
    return {
      respuestaTexto:
        'Gracias. Si deseas, dime el distrito o especifica mejor tu consulta para ayudarte.',
      session
    };
  }

  // --------------------------------------------------
  // Inicio / Relato
  // --------------------------------------------------
  if (session.estado === 'INICIO' || session.estado === 'ESPERANDO_RELATO') {
    // Casos de familia
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'Familia';
      session.estado = 'ESPERANDO_DISTRITO';

      return {
        respuestaTexto:
          'Entiendo la situación. Para orientarte correctamente, indícame en qué distrito ocurrieron los hechos.',
        session
      };
    }

    // Consultas informativas directas
    if (pareceConsultaInformativa(texto)) {
      return responderConsulta(texto, session);
    }

    // Clasificación IA (denuncia)
    const clasif = await clasificarMensaje(texto);

    session.contexto.delitoEspecifico = clasif.delito_especifico;
    session.contexto.materiaDetectada = clasif.materia;
    session.contexto.distritoTexto = clasif.distrito || null;

    if (!session.contexto.materiaDetectada && !session.contexto.delitoEspecifico) {
      session.estado = 'ESPERANDO_RELATO';
      return {
        respuestaTexto:
          'Para orientarte mejor, ¿podrías contarme un poco más sobre lo ocurrido?',
        session
      };
    }

    session.estado = 'DERIVACION';
  }

  // --------------------------------------------------
  // Derivación (Penal / Familia)
  // --------------------------------------------------
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
      session.estado = 'INICIO';
      return { respuestaTexto: res.mensaje, session };
    }

    session.estado = 'INICIO';
    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente con la información brindada. ' +
        'Si deseas, puedes intentar nuevamente.',
      session
    };
  }

  // --------------------------------------------------
  // Vínculo familiar
  // --------------------------------------------------
  if (session.estado === 'ESPERANDO_VINCULO') {
    const resp = esRespuestaSiNo(texto);
    if (!resp) {
      return {
        respuestaTexto: 'Por favor responde solo "sí" o "no".',
        session
      };
    }

    session.contexto.vinculoRespuesta = resp;
    session.estado = 'DERIVACION';
    return responderIA(session, session.contexto.distritoTexto || texto);
  }

  // --------------------------------------------------
  // Fallback
  // --------------------------------------------------
  return {
    respuestaTexto:
      'Puedes contarme tu caso o decirme qué información necesitas.',
    session
  };
}

module.exports = { responderIA };
