// ia.js
// Lógica de IA para el chatbot institucional del Ministerio Público – Fiscalía de Cajamarca
// (Opción 2: institucional moderno, cercano y conversacional)

const OpenAI = require('openai');
const { resolverFiscalia } = require('./derivacion');
const knowledge = require('./knowledge.json');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---------------------------
// Mensajes (voz institucional moderna)
// ---------------------------

const MSG = {
  bienvenida:
    'Hola, soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca 👋\n' +
    'Estoy aquí para ayudarte a orientarte sobre denuncias, trámites, preguntas frecuentes y datos de contacto.\n\n' +
    'Cuéntame con confianza qué ocurrió o en qué necesitas orientación.',

  disclaimer:
    '\n\n*Esta es una orientación preliminar y no reemplaza la asesoría legal.* ' +
    'Si hay riesgo inmediato para tu integridad, comunícate con los servicios de emergencia.',

  pedirDistrito:
    'Para ayudarte mejor, ¿en qué distrito ocurrieron los hechos?\n' +
    '(Por ejemplo: Cajamarca, Baños del Inca, La Encañada)',

  pedirVinculo:
    'Para orientarte correctamente, dime por favor:\n' +
    '¿la persona que te agredió o amenazó es parte de tu grupo familiar?\n' +
    '(pareja, expareja, conviviente, padre, madre, hijo/a, etc.)\n\n' +
    'Puedes responder solo “sí” o “no”.',

  noEntiendo:
    'No logré entender del todo lo ocurrido.\n' +
    'Si puedes, cuéntame un poco más qué pasó y dónde ocurrió, y con gusto te ayudo.',

  consultaGeneral:
    'Entiendo. Veo que tu mensaje es una consulta general.\n' +
    'Si deseas, dime qué trámite o duda tienes (por ejemplo: “cómo denunciar”, “requisitos”, “horarios”, “ubicación”), ' +
    'o cuéntame lo ocurrido para orientarte sobre la fiscalía que corresponde.',

  errorIA:
    'Estoy teniendo un inconveniente en este momento.\n' +
    'Si deseas, indícame el distrito y una breve descripción de lo ocurrido para orientarte.',

  reinicio:
    'Listo. Si deseas, puedes contarme otro caso o hacerme otra consulta. Estoy aquí para ayudarte.',

  confirmarVinculoSoloSiNo:
    'Disculpa, solo para confirmar: ¿la persona es parte de tu grupo familiar?\n' +
    'Puedes responder simplemente “sí” o “no”.',

  confirmarDistritoAmbiguoIntro:
    'Gracias. Para evitar confusiones, necesito confirmarlo contigo.\n' +
    'Existen varios distritos con ese nombre. ¿A cuál te refieres?\n' +
    'Puedes responder escribiendo **1** o **2**.'
};

// ---------------------------
// Normalizador y detector de distrito desde texto
// ---------------------------

const normalize = (str) =>
  (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Detecta un distrito en el texto del usuario comparando contra knowledge.distritos.
 * Devuelve el nombre del distrito (string) si encuentra UNO solo.
 * Si hay 0 o >1 coincidencias, devuelve null para no arriesgar.
 */
function detectarDistritoEnTexto(texto) {
  const q = normalize(texto);
  if (!q) return null;

  const matches = [];

  for (const d of knowledge.distritos) {
    const nd = normalize(d.distrito);
    if (!nd) continue;

    // Match por inclusión
    if (q.includes(nd)) matches.push(d);
  }

  if (matches.length === 1) return matches[0].distrito;
  return null;
}

// ---------------------------
// Sesión
// ---------------------------

function initSession(session) {
  if (!session) session = {};
  if (!session.estado) session.estado = 'INICIO';

  if (!session.contexto) {
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null,
      opcionesDistritosAmbiguos: null
    };
  }

  return session;
}

function resetSession(session) {
  session.estado = 'ESPERANDO_RELATO';
  session.contexto = {
    distritoTexto: null,
    delitoEspecifico: null,
    materiaDetectada: null,
    vinculoRespuesta: null,
    opcionesDistritosAmbiguos: null
  };
  return session;
}

// ---------------------------
// Heurísticas para NO llamar a OpenAI cuando no hace falta
// ---------------------------

function esSaludoCorto(texto) {
  const t = normalize(texto);
  return ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'holi'].includes(t);
}

function esAgradecimientoCorto(texto) {
  const t = normalize(texto);
  return ['gracias', 'muchas gracias', 'ok gracias', 'listo gracias', 'genial gracias'].includes(t);
}

function esRespuestaSiNo(texto) {
  const t = normalize(texto);
  if (!t) return null;
  if (t === 'si' || t === 'sí' || t.startsWith('si ') || t.startsWith('sí ')) return 'SI';
  if (t === 'no' || t.startsWith('no ')) return 'NO';
  return null;
}

function esOpcionNumerica(texto) {
  const t = normalize(texto);
  return t === '1' || t === '2';
}

function esComandoReinicio(texto) {
  const t = normalize(texto);
  return ['reiniciar', 'empezar de nuevo', 'nuevo', 'cancelar', 'reset'].includes(t);
}

// ---------------------------
// Clasificador IA
// ---------------------------

async function clasificarMensaje(mensajeUsuario) {
  const sistema = `
Eres un asistente del Ministerio Público – Fiscalía de Cajamarca.
Analiza el mensaje del ciudadano y devuelve SOLO el siguiente JSON:

{
  "tipo": "denuncia" | "consulta" | "otro",
  "delito_especifico": string | null,
  "materia": "Penal" | "Violencia Familiar" | "Familia" | "Prevención" | "Materia Ambiental" | "Corrupción" | "Crimen Organizado" | "Extinción de Dominio" | "Derechos Humanos" | null,
  "distrito": string | null
}

Instrucciones:
- Si describe hechos (golpes, amenazas, robo, abuso, etc.), es "denuncia".
- Si hace preguntas (requisitos, trámites, plazos, ubicación), es "consulta".
- "delito_especifico": nombre corto y general (ej. "robo", "amenazas", "lesiones", "violencia psicológica").
- "materia": elige la más probable. Si no estás seguro, null.
- "distrito": si menciona el lugar (ej. "Cajamarca", "La Encañada", "Baños del Inca"), devuélvelo. Si no, null.

Devuelve solo el JSON.`.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: mensajeUsuario }
    ]
  });

  let data;
  try {
    data = JSON.parse(completion.choices[0].message.content);
  } catch {
    data = { tipo: 'otro', delito_especifico: null, materia: null, distrito: null };
  }

  return {
    tipo: data.tipo || 'otro',
    delito_especifico: data.delito_especifico || null,
    materia: data.materia || null,
    distrito: data.distrito || null
  };
}

// ---------------------------
// Responder IA (principal)
// ---------------------------

async function responderIA(session, mensajeUsuario) {
  session = initSession(session);
  const texto = (mensajeUsuario || '').trim();

  // Comando de reinicio
  if (esComandoReinicio(texto)) {
    session = resetSession(session);
    return { respuestaTexto: MSG.bienvenida, session };
  }

  // Saludo
  if ((session.estado === 'INICIO' || session.estado === 'ESPERANDO_RELATO') && esSaludoCorto(texto)) {
    session.estado = 'ESPERANDO_RELATO';
    return { respuestaTexto: MSG.bienvenida, session };
  }

  // Agradecimiento corto
  if (esAgradecimientoCorto(texto)) {
    return { respuestaTexto: '¡De nada! 😊 ' + MSG.reinicio, session };
  }

  // ---------------------------
  // Estado: ESPERANDO_DISTRITO_AMBIGUO (si el usuario responde 1/2)
  // (lo manejamos antes de llamar a OpenAI)
  // ---------------------------
  if (session.estado === 'ESPERANDO_DISTRITO_AMBIGUO') {
    const opciones = session.contexto.opcionesDistritosAmbiguos || [];

    let elegido = texto;
    if (esOpcionNumerica(texto)) {
      const idx = Number(normalize(texto)) - 1;
      if (opciones[idx]) elegido = opciones[idx].distrito;
    }

    session.contexto.distritoTexto = elegido;

    const res = resolverFiscalia({
      distritoTexto: session.contexto.distritoTexto,
      delitoEspecifico: session.contexto.delitoEspecifico,
      materiaDetectada: session.contexto.materiaDetectada,
      vinculoRespuesta: session.contexto.vinculoRespuesta
    });

    if (res.status === 'ASK_VINCULO') {
      session.estado = 'ESPERANDO_VINCULO';
      return { respuestaTexto: MSG.pedirVinculo, session };
    }

    if (res.status === 'OK') {
      session.estado = 'FINAL';
      return {
        respuestaTexto:
          'Gracias por la aclaración.\n\n' +
          res.mensaje +
          MSG.disclaimer +
          '\n\n' +
          'Si quieres, puedo ayudarte con otra consulta o con los pasos a seguir.',
        session
      };
    }

    // Si aún no se puede resolver, pedimos distrito nuevamente
    session.estado = 'ESPERANDO_DISTRITO';
    return { respuestaTexto: MSG.pedirDistrito, session };
  }

  // ---------------------------
  // Estado: ESPERANDO_VINCULO (si el usuario responde sí/no)
  // ---------------------------
  if (session.estado === 'ESPERANDO_VINCULO') {
    const vinculo = esRespuestaSiNo(texto);

    if (!vinculo) {
      return { respuestaTexto: MSG.confirmarVinculoSoloSiNo, session };
    }

    session.contexto.vinculoRespuesta = vinculo;

    const res = resolverFiscalia({
      distritoTexto: session.contexto.distritoTexto || '',
      delitoEspecifico: session.contexto.delitoEspecifico,
      materiaDetectada: session.contexto.materiaDetectada,
      vinculoRespuesta: session.contexto.vinculoRespuesta
    });

    if (res.status === 'ASK_DISTRITO') {
      session.estado = 'ESPERANDO_DISTRITO';
      return { respuestaTexto: MSG.pedirDistrito, session };
    }

    if (res.status === 'ASK_DISTRITO_AMBIGUO') {
      session.estado = 'ESPERANDO_DISTRITO_AMBIGUO';
      session.contexto.opcionesDistritosAmbiguos = res.opciones;
      return { respuestaTexto: MSG.confirmarDistritoAmbiguoIntro + '\n\n' + res.mensaje, session };
    }

    if (res.status === 'OK') {
      session.estado = 'FINAL';
      return {
        respuestaTexto:
          'Gracias por confirmarlo.\n\n' +
          res.mensaje +
          MSG.disclaimer +
          '\n\n' +
          'Si quieres, también puedo orientarte sobre los pasos a seguir.',
        session
      };
    }

    return { respuestaTexto: MSG.noEntiendo, session };
  }

  // ---------------------------
  // Estado: ESPERANDO_DISTRITO (cuando el usuario responde con un distrito)
  // ---------------------------
  if (session.estado === 'ESPERANDO_DISTRITO') {
    session.contexto.distritoTexto = texto;

    const res = resolverFiscalia({
      distritoTexto: session.contexto.distritoTexto,
      delitoEspecifico: session.contexto.delitoEspecifico,
      materiaDetectada: session.contexto.materiaDetectada,
      vinculoRespuesta: session.contexto.vinculoRespuesta
    });

    if (res.status === 'ASK_DISTRITO_AMBIGUO') {
      session.estado = 'ESPERANDO_DISTRITO_AMBIGUO';
      session.contexto.opcionesDistritosAmbiguos = res.opciones;
      return { respuestaTexto: MSG.confirmarDistritoAmbiguoIntro + '\n\n' + res.mensaje, session };
    }

    if (res.status === 'ASK_VINCULO') {
      session.estado = 'ESPERANDO_VINCULO';
      return { respuestaTexto: MSG.pedirVinculo, session };
    }

    if (res.status === 'OK') {
      session.estado = 'FINAL';
      return {
        respuestaTexto:
          'Gracias.\n\n' +
          res.mensaje +
          MSG.disclaimer +
          '\n\n' +
          'Si quieres, puedo ayudarte con otra consulta.',
        session
      };
    }

    return { respuestaTexto: MSG.noEntiendo, session };
  }

  // ---------------------------
  // Estado: FINAL (cualquier nuevo mensaje inicia un nuevo caso)
  // ---------------------------
  if (session.estado === 'FINAL') {
    session = resetSession(session);
    return { respuestaTexto: MSG.reinicio, session };
  }

  // ---------------------------
  // Estado: INICIO / ESPERANDO_RELATO
  // Aquí sí usamos IA (salvo casos simples ya manejados arriba)
  // ---------------------------
  session.estado = session.estado === 'INICIO' ? 'ESPERANDO_RELATO' : session.estado;

  // Si el usuario manda algo muy corto, guiamos
  if (normalize(texto).length < 3) {
    return { respuestaTexto: MSG.noEntiendo, session };
  }

  let clasif;
  try {
    clasif = await clasificarMensaje(texto);
  } catch (err) {
    return { respuestaTexto: MSG.errorIA, session };
  }

  // Detectar distrito por IA + texto literal
  const distritoPorTexto = detectarDistritoEnTexto(texto);
  const distritoFinal = clasif.distrito || distritoPorTexto || null;

  // Guardar contexto (sin sobrescribir luego)
  session.contexto.delitoEspecifico = clasif.delito_especifico;
  session.contexto.materiaDetectada = clasif.materia;
  session.contexto.distritoTexto = distritoFinal;
  session.contexto.vinculoRespuesta = null;

  // Consultas generales (por ahora respondemos sin IA extra)
  if (clasif.tipo === 'consulta') {
    return { respuestaTexto: MSG.consultaGeneral, session };
  }

  // Si no es denuncia clara, pedir más detalle
  if (clasif.tipo !== 'denuncia') {
    return { respuestaTexto: MSG.noEntiendo, session };
  }

  // Intentar derivar con lo que tenemos
  const res = resolverFiscalia({
    distritoTexto: session.contexto.distritoTexto || '',
    delitoEspecifico: session.contexto.delitoEspecifico,
    materiaDetectada: session.contexto.materiaDetectada,
    vinculoRespuesta: session.contexto.vinculoRespuesta
  });

  if (res.status === 'ASK_DISTRITO') {
    session.estado = 'ESPERANDO_DISTRITO';
    return { respuestaTexto: MSG.pedirDistrito, session };
  }

  if (res.status === 'ASK_DISTRITO_AMBIGUO') {
    session.estado = 'ESPERANDO_DISTRITO_AMBIGUO';
    session.contexto.opcionesDistritosAmbiguos = res.opciones;
    return { respuestaTexto: MSG.confirmarDistritoAmbiguoIntro + '\n\n' + res.mensaje, session };
  }

  if (res.status === 'ASK_VINCULO') {
    session.estado = 'ESPERANDO_VINCULO';
    return { respuestaTexto: MSG.pedirVinculo, session };
  }

  if (res.status === 'OK') {
    session.estado = 'FINAL';
    return {
      respuestaTexto:
        'Gracias por contarlo.\n\n' +
        res.mensaje +
        MSG.disclaimer +
        '\n\n' +
        'Si quieres, puedo ayudarte con otra consulta o con los pasos a seguir.',
      session
    };
  }

  return { respuestaTexto: MSG.noEntiendo, session };
}

// ---------------------------
// Exportar
// ---------------------------

module.exports = { responderIA };
