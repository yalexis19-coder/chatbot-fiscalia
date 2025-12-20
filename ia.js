// ia.js
// Lógica del chatbot institucional – Ministerio Público – Fiscalía de Cajamarca

const OpenAI = require('openai');
const { resolverFiscalia } = require('./derivacion');
const knowledge = require('./knowledge.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Mensajes
// ---------------------------
const MSG = {
  bienvenida:
    'Hola, soy el asistente virtual del Ministerio Público – Fiscalía de Cajamarca.\n\n' +
    'Puedo orientarte para presentar una denuncia o brindarte información (ubicación, trámites, preguntas frecuentes y contactos).\n' +
    'Cuéntame qué necesitas.',

  inicioDenuncia:
    'Perfecto. Cuéntame brevemente qué ocurrió.\n' +
    'Si puedes, indica también el **distrito** donde pasaron los hechos (por ejemplo: Cajamarca, Baños del Inca, La Encañada).',

  pedirDistrito:
    'Por favor, indícame en qué **distrito** ocurrieron los hechos (por ejemplo: Cajamarca, Baños del Inca, La Encañada).',

  pedirVinculo:
    'Para orientarte correctamente: ¿la persona involucrada es parte de tu grupo familiar?\n' +
    '(pareja, expareja, conviviente, padre, madre, hijo/a, etc.)\n\n' +
    'Responde solo “sí” o “no”.',

  noEntiendo:
    'No logré entender del todo.\n' +
    'Si puedes, dime qué ocurrió o qué información necesitas, y el distrito.',

  consultaNecesitaDistrito:
    'Claro. ¿De qué distrito o provincia necesitas la información?\n' +
    '(Ej.: Cajabamba, San Marcos, Cajamarca, Baños del Inca)',

  preguntaFAQ:
    'Claro. Escríbeme tu pregunta y te respondo.',

  preguntaTramite:
    'De acuerdo. ¿Sobre qué trámite necesitas información?\n' +
    '(Ej.: “poner una denuncia”, “violencia familiar”, “cómo denunciar”, etc.)',

  preguntaContacto:
    'Perfecto. ¿De qué entidad o fiscalía necesitas el contacto?',

  cierre:
    '\n\nSi deseas, puedo ayudarte con otra consulta.'
};

// ---------------------------
// Utilitarios
// ---------------------------
const normalize = (str) =>
  (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function tokenize(str) {
  const t = normalize(str);
  if (!t) return [];
  const stop = new Set([
    'de','la','el','los','las','y','o','a','en','por','para','un','una','que','como',
    'donde','queda','quiero','necesito','me','mi','mis','su','sus','del','al','es','son',
    'info','informacion','datos','porfavor','favor'
  ]);
  return t
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(' ')
    .map(s => s.trim())
    .filter(s => s && !stop.has(s));
}

function includesAny(texto, arr) {
  const t = normalize(texto);
  return arr.some(k => t.includes(normalize(k)));
}

function esRespuestaSiNo(texto) {
  const t = normalize(texto);
  if (t === 'si' || t === 'sí') return 'SI';
  if (t === 'no') return 'NO';
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
      // denuncia
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null,
      opcionesDistritosAmbiguos: null,

      // consultas
      ultimaConsulta: null
    };
  }
  return session;
}

function resetDenuncia(session) {
  session.estado = 'ESPERANDO_RELATO';
  session.contexto.distritoTexto = null;
  session.contexto.delitoEspecifico = null;
  session.contexto.materiaDetectada = null;
  session.contexto.vinculoRespuesta = null;
  session.contexto.opcionesDistritosAmbiguos = null;
  return session;
}

// ---------------------------
// Heurísticas de CONSULTA (para no llamar IA)
// ---------------------------
function pareceConsultaPorHeuristica(texto) {
  return includesAny(texto, [
    'ubicacion','ubicación','direccion','dirección','donde queda','dónde queda','queda',
    'horario','telefono','teléfono','numero','número','llamar',
    'requisitos','pasos','tramite','trámite','procedimiento',
    'faq','preguntas frecuentes','pregunta','duda',
    'contacto','correo','email'
  ]);
}

// ---------------------------
// Clasificador IA (solo para relato/denuncia)
// ---------------------------
async function clasificarMensaje(mensajeUsuario) {
  const sistema = `
Eres un asistente del Ministerio Público – Fiscalía de Cajamarca.
Devuelve SOLO este JSON:

{
  "tipo": "denuncia" | "consulta" | "otro",
  "delito_especifico": string | null,
  "materia": "Penal" | "Violencia Familiar" | "Familia" | "Materia Ambiental" | "Corrupción" | "Crimen Organizado" | "Extinción de Dominio" | "Derechos Humanos" | null,
  "distrito": string | null
}

Reglas:
- Si describe hechos: "denuncia".
- Si pide ubicación, trámites, requisitos, horarios, teléfonos, FAQ: "consulta".
- delito_especifico: término corto (ej. "robo", "amenazas", "lesiones").
- distrito: si lo menciona.

Devuelve solo el JSON.`.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: mensajeUsuario }
    ]
  });

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return { tipo: 'otro', delito_especifico: null, materia: null, distrito: null };
  }
}

// ---------------------------
// Consultas: buscadores en knowledge.json
// ---------------------------
function scoreTokens(queryTokens, targetText) {
  const targetTokens = tokenize(targetText);
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  return queryTokens.filter(t => targetTokens.includes(t)).length;
}

function buscarMejorFAQ(texto) {
  const arr = knowledge.faq || [];
  const qTokens = tokenize(texto);
  if (qTokens.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const item of arr) {
    const s = scoreTokens(qTokens, item.pregunta || '');
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return bestScore >= 2 ? best : null;
}

function buscarMejorProcedimiento(texto) {
  const arr = knowledge.procedimientos || [];
  const qTokens = tokenize(texto);
  if (qTokens.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const item of arr) {
    const s = scoreTokens(qTokens, item.tramite || '');
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return bestScore >= 2 ? best : null;
}

function buscarContactos(texto) {
  const arr = knowledge.contacto || [];
  const qTokens = tokenize(texto);
  if (qTokens.length === 0) return arr.slice(0, 3);

  const scored = arr
    .map(c => ({ c, s: scoreTokens(qTokens, c.entidad || '') }))
    .sort((a, b) => b.s - a.s)
    .filter(x => x.s > 0)
    .slice(0, 3)
    .map(x => x.c);

  return scored.length ? scored : arr.slice(0, 3);
}

// Para ubicación fiscalía: delegamos en tu knowledge de distritos/fiscalías (si existe)
// Si tu knowledge.json ya tiene fiscalias/distritos mapeados como antes, esto funcionará.
function getDistritosMatchesEnTexto(texto) {
  const q = normalize(texto);
  if (!q) return [];
  const matches = [];

  for (const d of knowledge.distritos || []) {
    const nd = normalize(d.distrito);
    if (nd && q.includes(nd)) matches.push(d);
  }
  return matches;
}

function detectarProvinciaEnTexto(texto) {
  const q = normalize(texto);
  if (!q) return null;

  const provincias = Array.from(new Set((knowledge.distritos || []).map(d => d.provincia).filter(Boolean)));
  const matches = provincias.filter(p => q.includes(normalize(p)));
  return matches.length === 1 ? matches[0] : null;
}

function distritosPorProvincia(provincia) {
  const p = normalize(provincia);
  return (knowledge.distritos || []).filter(d => normalize(d.provincia) === p);
}

function buscarFiscaliaPorCodigo(codigo) {
  const c = normalize(codigo);
  if (!c) return null;
  return (knowledge.fiscalias || []).find(f => normalize(f.codigo_fiscalia) === c) || null;
}

function resolverFiscaliaParaConsultaPorDistrito(distritoObj) {
  // Por defecto, penal/mixta
  const codigo = distritoObj?.fiscalia_penal_mixta_codigo || null;
  if (!codigo) return null;
  return buscarFiscaliaPorCodigo(codigo);
}

function formatearFichaFiscalia(f) {
  if (!f) return null;
  const lineas = [];
  lineas.push(`**${f.nombre_fiscalia}**`);
  if (f.direccion) lineas.push(`📍 Dirección: ${f.direccion}`);
  if (f.telefono) lineas.push(`📞 Teléfono: ${f.telefono}`);
  if (f.horario) lineas.push(`🕒 Horario: ${f.horario}`);
  return lineas.join('\n');
}

// ---------------------------
// Router de CONSULTAS (según ultimaConsulta)
// ---------------------------
function responderConsulta(texto, session) {
  const t = normalize(texto);
  const last = session.contexto.ultimaConsulta;

  // 1) Si venimos de menú Ubicación y el usuario escribió solo "Cajabamba"
  if (last?.tipo === 'fiscalia' && last.awaiting === true) {
    // Forzamos a que el texto se trate como ubicación
    session.contexto.ultimaConsulta.awaiting = false;
    return responderConsulta(`ubicacion ${texto}`, session);
  }

  // 2) Si venimos de menú Trámites y el usuario escribió el trámite
  if (last?.tipo === 'procedimiento' && last.awaiting === true) {
    session.contexto.ultimaConsulta.awaiting = false;
    return responderConsulta(`tramite ${texto}`, session);
  }

  // 3) Si venimos de menú FAQ y el usuario escribió la pregunta
  if (last?.tipo === 'faq' && last.awaiting === true) {
    session.contexto.ultimaConsulta.awaiting = false;
    return responderConsulta(`faq ${texto}`, session);
  }

  // 4) Si venimos de menú Contacto y el usuario escribió entidad/fiscalía
  if (last?.tipo === 'contacto' && last.awaiting === true) {
    session.contexto.ultimaConsulta.awaiting = false;
    return responderConsulta(`contacto ${texto}`, session);
  }

  // ---- Ubicación fiscalía
  if (includesAny(t, ['ubicacion','ubicación','direccion','dirección','donde queda','dónde queda','queda','fiscalia','fiscalía'])) {
    session.contexto.ultimaConsulta = { tipo: 'fiscalia', awaiting: false };

    const matches = getDistritosMatchesEnTexto(texto);

    if (matches.length === 1) {
      const distritoObj = matches[0];
      const fiscalia = resolverFiscaliaParaConsultaPorDistrito(distritoObj);
      if (!fiscalia) {
        return { respuestaTexto: 'No encontré la fiscalía de ese distrito en el registro. ¿Podrías confirmar el distrito exacto?', session };
      }
      const ficha = formatearFichaFiscalia(fiscalia);
      return { respuestaTexto: 'Aquí tienes la información:\n\n' + ficha + MSG.cierre, session };
    }

    if (matches.length > 1) {
      // Simplificado: pedir que precise provincia
      return {
        respuestaTexto:
          'Encontré más de un distrito con ese nombre. ¿Podrías indicarme también la provincia?',
        session
      };
    }

    const prov = detectarProvinciaEnTexto(texto);
    if (prov) {
      const ds = distritosPorProvincia(prov);
      const distritoCapital = ds.find(d => normalize(d.distrito) === normalize(prov)) || ds[0] || null;
      if (distritoCapital) {
        const fiscalia = resolverFiscaliaParaConsultaPorDistrito(distritoCapital);
        if (fiscalia) {
          const ficha = formatearFichaFiscalia(fiscalia);
          return {
            respuestaTexto:
              `Entiendo que te refieres a la provincia **${prov}**.\n\n` +
              'Aquí tienes la información:\n\n' +
              ficha +
              MSG.cierre,
            session
          };
        }
      }
    }

    // Si no se identificó
    session.contexto.ultimaConsulta = { tipo: 'fiscalia', awaiting: true };
    return { respuestaTexto: MSG.consultaNecesitaDistrito, session };
  }

  // ---- Trámites
  if (includesAny(t, ['requisitos','pasos','tramite','trámite','procedimiento','como poner','cómo poner','como denunciar','cómo denunciar'])) {
    session.contexto.ultimaConsulta = { tipo: 'procedimiento', awaiting: false };
    const proc = buscarMejorProcedimiento(texto);

    if (!proc) {
      session.contexto.ultimaConsulta = { tipo: 'procedimiento', awaiting: true };
      return { respuestaTexto: MSG.preguntaTramite, session };
    }

    const partes = [];
    partes.push(`**Trámite:** ${proc.tramite}`);
    if (proc.pasos) partes.push(`\n**Pasos:**\n${proc.pasos}`);
    if (proc.requisitos) partes.push(`\n**Requisitos:**\n${proc.requisitos}`);
    if (proc.observaciones) partes.push(`\n**Observaciones:**\n${proc.observaciones}`);

    return { respuestaTexto: 'Aquí tienes la información:\n\n' + partes.join('\n') + MSG.cierre, session };
  }

  // ---- FAQ
  if (includesAny(t, ['faq','preguntas frecuentes','pregunta','duda','dudas'])) {
    session.contexto.ultimaConsulta = { tipo: 'faq', awaiting: false };
    const best = buscarMejorFAQ(texto);

    if (!best) {
      session.contexto.ultimaConsulta = { tipo: 'faq', awaiting: true };
      return { respuestaTexto: MSG.preguntaFAQ, session };
    }

    return {
      respuestaTexto: `**Pregunta:** ${best.pregunta}\n**Respuesta:** ${best.respuesta}` + MSG.cierre,
      session
    };
  }

  // ---- Contacto
  if (includesAny(t, ['contacto','correo','email','entidad','telefono','teléfono'])) {
    session.contexto.ultimaConsulta = { tipo: 'contacto', awaiting: false };
    const hits = buscarContactos(texto);

    const lines = hits.map(c => {
      const l = [];
      l.push(`**${c.entidad}**`);
      if (c.direccion) l.push(`📍 ${c.direccion}`);
      if (c.telefono) l.push(`📞 ${c.telefono}`);
      if (c.correo) l.push(`✉️ ${c.correo}`);
      return l.join('\n');
    });

    return { respuestaTexto: 'Aquí tienes contactos de referencia:\n\n' + lines.join('\n\n') + MSG.cierre, session };
  }

  // Si no matchea, pero estaba en modo consulta por menú
  if (session.contexto.ultimaConsulta?.tipo) {
    return { respuestaTexto: '¿Podrías especificar un poco más tu consulta? ' + MSG.consultaNecesitaDistrito, session };
  }

  return { respuestaTexto: MSG.noEntiendo, session };
}

// ---------------------------
// responderIA (principal)
// ---------------------------
async function responderIA(session, mensajeUsuario) {
  session = initSession(session);
  const texto = (mensajeUsuario || '').trim();

  // ---- Comandos desde MENÚ (server.js)
  if (texto === '__MENU_DENUNCIA__') {
    resetDenuncia(session);
    return { respuestaTexto: MSG.inicioDenuncia, session };
  }

  if (texto === '__MENU_UBICACION__') {
    session.contexto.ultimaConsulta = { tipo: 'fiscalia', awaiting: true };
    // Importante: no cambiar a flujo de denuncia
    session.estado = 'CONSULTA';
    return { respuestaTexto: MSG.consultaNecesitaDistrito, session };
  }

  if (texto === '__MENU_FAQ__') {
    session.contexto.ultimaConsulta = { tipo: 'faq', awaiting: true };
    session.estado = 'CONSULTA';
    return { respuestaTexto: MSG.preguntaFAQ, session };
  }

  if (texto === '__MENU_TRAMITES__') {
    session.contexto.ultimaConsulta = { tipo: 'procedimiento', awaiting: true };
    session.estado = 'CONSULTA';
    return { respuestaTexto: MSG.preguntaTramite, session };
  }

  if (texto === '__MENU_CONTACTO__') {
    session.contexto.ultimaConsulta = { tipo: 'contacto', awaiting: true };
    session.estado = 'CONSULTA';
    return { respuestaTexto: MSG.preguntaContacto, session };
  }

  // ---- Si estamos en modo CONSULTA por menú o por heurística
  if (session.estado === 'CONSULTA' || pareceConsultaPorHeuristica(texto)) {
    return responderConsulta(texto, session);
  }

  // ---- Estados de denuncia ya definidos por tu motor de derivación
  if (session.estado === 'ESPERANDO_VINCULO') {
    const v = esRespuestaSiNo(texto);
    if (!v) return { respuestaTexto: 'Por favor responde solo “sí” o “no”.', session };

    session.contexto.vinculoRespuesta = v;

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

    if (res.status === 'OK') {
      session.estado = 'FINAL';
      return { respuestaTexto: res.mensaje, session };
    }

    return { respuestaTexto: MSG.noEntiendo, session };
  }

  if (session.estado === 'ESPERANDO_DISTRITO') {
    session.contexto.distritoTexto = texto;

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

    if (res.status === 'ASK_DISTRITO') {
      session.estado = 'ESPERANDO_DISTRITO';
      return { respuestaTexto: MSG.pedirDistrito, session };
    }

    if (res.status === 'OK') {
      session.estado = 'FINAL';
      return { respuestaTexto: res.mensaje, session };
    }

    return { respuestaTexto: MSG.noEntiendo, session };
  }

  // ---- Flujo general: clasificar con IA (denuncia vs consulta)
  let clasif;
  try {
    clasif = await clasificarMensaje(texto);
  } catch (e) {
    return { respuestaTexto: 'En este momento tengo un inconveniente para procesar tu mensaje. Intenta nuevamente.', session };
  }

  // Si IA dice consulta, vamos a consultas
  if (clasif.tipo === 'consulta') {
    session.estado = 'CONSULTA';
    return responderConsulta(texto, session);
  }

  // Si no es denuncia, pedir aclaración
  if (clasif.tipo !== 'denuncia') {
    return { respuestaTexto: MSG.noEntiendo, session };
  }

  // Guardar contexto denuncia
  session.contexto.delitoEspecifico = clasif.delito_especifico || null;
  session.contexto.materiaDetectada = clasif.materia || null;
  session.contexto.distritoTexto = clasif.distrito || null;
  session.contexto.vinculoRespuesta = null;

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

  if (res.status === 'ASK_VINCULO') {
    session.estado = 'ESPERANDO_VINCULO';
    return { respuestaTexto: MSG.pedirVinculo, session };
  }

  if (res.status === 'OK') {
    session.estado = 'FINAL';
    return { respuestaTexto: res.mensaje, session };
  }

  return { respuestaTexto: MSG.noEntiendo, session };
}

module.exports = { responderIA };
