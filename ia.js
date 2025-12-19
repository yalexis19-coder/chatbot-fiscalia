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
    'Estoy aquí para ayudarte con orientación sobre denuncias, trámites, preguntas frecuentes y datos de contacto.\n\n' +
    'Cuéntame qué ocurrió o qué información necesitas.',

  disclaimer:
    '\n\n*Esta es una orientación preliminar y no reemplaza la asesoría legal.* ' +
    'Si hay riesgo inmediato para tu integridad, comunícate con los servicios de emergencia.',

  pedirDistrito:
    'Para ayudarte mejor, ¿en qué distrito ocurrieron los hechos o de qué distrito necesitas la información?\n' +
    '(Por ejemplo: Cajamarca, Baños del Inca, La Encañada)',

  pedirVinculo:
    'Para orientarte correctamente, dime por favor:\n' +
    '¿la persona que te agredió o amenazó es parte de tu grupo familiar?\n' +
    '(pareja, expareja, conviviente, padre, madre, hijo/a, etc.)\n\n' +
    'Puedes responder solo “sí” o “no”.',

  noEntiendo:
    'No logré entender del todo.\n' +
    'Si puedes, dime qué pasó (o qué información necesitas) y el distrito, y con gusto te ayudo.',

  consultaGeneral:
    'Entiendo. Para ayudarte mejor, dime qué necesitas:\n' +
    '• “ubicación” o “dirección”\n' +
    '• “horario”\n' +
    '• “teléfono”\n' +
    '• “requisitos” o “pasos” de un trámite\n' +
    '• una “pregunta frecuente” (FAQ)\n\n' +
    'Y si puedes, indícame el distrito o la fiscalía.',

  errorIA:
    'Estoy teniendo un inconveniente en este momento.\n' +
    'Si deseas, indícame el distrito y una breve descripción de lo ocurrido o de la información que necesitas.',

  reinicio:
    'Listo. Si deseas, puedes contarme otro caso o hacerme otra consulta. Estoy aquí para ayudarte.',

  confirmarVinculoSoloSiNo:
    'Disculpa, solo para confirmar: ¿la persona es parte de tu grupo familiar?\n' +
    'Puedes responder simplemente “sí” o “no”.',

  confirmarDistritoAmbiguoIntro:
    'Gracias. Para evitar confusiones, necesito confirmarlo contigo.\n' +
    'Existen varios distritos con ese nombre. ¿A cuál te refieres?\n' +
    'Puedes responder escribiendo **1** o **2**.',

  consultaNecesitaDistrito:
    'Claro. ¿De qué distrito o provincia necesitas la información?\n' +
    '(Ejemplo: Cajabamba, San Marcos, Cajamarca, Baños del Inca)',

  consultaNecesitaTipoFiscalia:
    'Entiendo. En esa provincia puede haber más de una fiscalía.\n' +
    '¿Qué información necesitas?\n' +
    '1) Fiscalía Penal/Mixta\n' +
    '2) Fiscalía de Familia\n\n' +
    'Responde con **1** o **2**.'
};

// ---------------------------
// Normalización y utilitarios
// ---------------------------

const normalize = (str) =>
  (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
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

// ---------------------------
// Detección distrito/provincia desde texto
// ---------------------------

function getDistritosMatchesEnTexto(texto) {
  const q = normalize(texto);
  if (!q) return [];
  const matches = [];

  for (const d of knowledge.distritos || []) {
    const nd = normalize(d.distrito);
    if (!nd) continue;
    if (q.includes(nd)) matches.push(d);
  }

  // si hay muchos por coincidencias cortas, dejamos tal cual (se resuelve por ambigüedad)
  return matches;
}

function detectarDistritoEnTexto(texto) {
  const matches = getDistritosMatchesEnTexto(texto);
  if (matches.length === 1) return matches[0].distrito;
  return null;
}

function detectarProvinciaEnTexto(texto) {
  const q = normalize(texto);
  if (!q) return null;

  const provincias = Array.from(new Set((knowledge.distritos || []).map(d => d.provincia).filter(Boolean)));
  const matches = provincias.filter(p => q.includes(normalize(p)));

  if (matches.length === 1) return matches[0];
  return null;
}

function distritosPorProvincia(provincia) {
  const p = normalize(provincia);
  return (knowledge.distritos || []).filter(d => normalize(d.provincia) === p);
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
      opcionesDistritosAmbiguos: null,

      // consultas
      ultimaConsulta: null, // { tipo: 'ubicacion'|'horario'|'telefono'|'correo'|'procedimiento'|'faq'|'contacto', distritoTexto?, codigoFiscalia?, tramite?, entidad? }
      opcionesConsultaDistritos: null,
      opcionesConsultaTipoFiscalia: null
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
    opcionesDistritosAmbiguos: null,

    ultimaConsulta: null,
    opcionesConsultaDistritos: null,
    opcionesConsultaTipoFiscalia: null
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

function pareceConsultaPorHeuristica(texto) {
  return includesAny(texto, [
    'ubicacion','ubicación','direccion','dirección','donde queda','dónde queda','queda',
    'horario','telefon','número','numero','llamar',
    'requisitos','pasos','tramite','trámite','procedimiento',
    'faq','preguntas frecuentes','duda',
    'contacto','correo','email'
  ]);
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
- Si hace preguntas (requisitos, trámites, ubicación, teléfonos, horarios), es "consulta".
- "delito_especifico": nombre corto y general (ej. "robo", "amenazas", "lesiones").
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
// Consultas: buscadores en knowledge.json
// ---------------------------

function buscarFiscaliaPorCodigo(codigo) {
  const c = normalize(codigo);
  if (!c) return null;
  return (knowledge.fiscalias || []).find(f => normalize(f.codigo_fiscalia) === c) || null;
}

function buscarFiscaliaPorNombre(texto) {
  const q = normalize(texto);
  if (!q) return null;

  // si el usuario escribió parte del nombre exacto
  const candidates = (knowledge.fiscalias || []).filter(f => normalize(f.nombre_fiscalia).includes(q));
  if (candidates.length === 1) return candidates[0];

  // si escribió palabras sueltas
  const tokens = tokenize(texto);
  if (tokens.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const f of knowledge.fiscalias || []) {
    const nameTokens = tokenize(f.nombre_fiscalia);
    const score = tokens.filter(t => nameTokens.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }

  return bestScore >= 2 ? best : null;
}

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
  const q = normalize(texto);
  if (!q) return [];

  // si menciona entidad
  const hits = arr.filter(c => normalize(c.entidad).includes(q));
  if (hits.length) return hits.slice(0, 3);

  // por tokens
  const qTokens = tokenize(texto);
  if (qTokens.length === 0) return arr.slice(0, 3);

  const scored = arr
    .map(c => ({ c, s: scoreTokens(qTokens, c.entidad || '') }))
    .sort((a,b) => b.s - a.s)
    .filter(x => x.s > 0)
    .slice(0, 3)
    .map(x => x.c);

  return scored.length ? scored : arr.slice(0, 3);
}

function detectarTipoFiscaliaEnConsulta(texto) {
  const t = normalize(texto);
  if (t.includes('familia')) return 'familia';
  if (t.includes('violencia') || t.includes('mujer') || t.includes('grupo familiar')) return 'violencia';
  if (t.includes('prevencion') || t.includes('prevención')) return 'prevencion';
  if (t.includes('penal') || t.includes('mixta')) return 'penal';
  return null; // no especificó
}

function detectarCampoFiscaliaEnConsulta(texto) {
  const t = normalize(texto);

  if (t.includes('horario')) return 'horario';
  if (t.includes('telefono') || t.includes('teléfono') || t.includes('numero') || t.includes('número') || t.includes('llamar')) return 'telefono';
  if (t.includes('correo') || t.includes('email')) return 'correo';
  if (t.includes('direccion') || t.includes('dirección') || t.includes('ubicacion') || t.includes('ubicación') || t.includes('donde queda') || t.includes('dónde queda') || t.includes('queda')) return 'direccion';

  return null;
}

function formatearFichaFiscalia(f, campoPreferido) {
  if (!f) return null;

  const lineas = [];
  lineas.push(`**${f.nombre_fiscalia}**`);

  // campoPreferido primero
  if (campoPreferido === 'direccion' && f.direccion) lineas.push(`📍 Dirección: ${f.direccion}`);
  if (campoPreferido === 'telefono' && f.telefono) lineas.push(`📞 Teléfono: ${f.telefono}`);
  if (campoPreferido === 'horario' && f.horario) lineas.push(`🕒 Horario: ${f.horario}`);

  // luego lo demás
  if (campoPreferido !== 'direccion' && f.direccion) lineas.push(`📍 Dirección: ${f.direccion}`);
  if (campoPreferido !== 'telefono' && f.telefono) lineas.push(`📞 Teléfono: ${f.telefono}`);
  if (campoPreferido !== 'horario' && f.horario) lineas.push(`🕒 Horario: ${f.horario}`);

  return lineas.join('\n');
}

/**
 * Resuelve fiscalía desde distrito/provincia para consultas (sin denuncia)
 */
function resolverFiscaliaParaConsultaPorDistrito(distritoObj, tipoFiscaliaDeseada) {
  if (!distritoObj) return null;

  // Elegimos el código más apropiado según lo pedido.
  const map = {
    violencia: distritoObj.fiscalia_violencia_codigo,
    prevencion: distritoObj.fiscalia_prevencion_codigo,
    familia: distritoObj.fiscalia_familia_codigo,
    penal: distritoObj.fiscalia_penal_mixta_codigo
  };

  let codigo = null;

  if (tipoFiscaliaDeseada && map[tipoFiscaliaDeseada]) {
    codigo = map[tipoFiscaliaDeseada];
  }

  // fallback: penal/mixta
  if (!codigo) codigo = distritoObj.fiscalia_penal_mixta_codigo;

  if (!codigo) return null;
  return buscarFiscaliaPorCodigo(codigo);
}

/**
 * Router principal de consultas
 */
function responderConsulta(texto, session) {
  const campoFiscalia = detectarCampoFiscaliaEnConsulta(texto); // direccion/telefono/horario/correo
  const tipoFiscaliaDeseada = detectarTipoFiscaliaEnConsulta(texto); // familia/violencia/prevencion/penal
  const tNorm = normalize(texto);

  // 0) Si el usuario respondió 1/2 para seleccionar tipo de fiscalía (penal vs familia)
  if (session.estado === 'CONSULTA_TIPO_FISCALIA') {
    if (!esOpcionNumerica(texto)) {
      return { respuestaTexto: MSG.consultaNecesitaTipoFiscalia, session };
    }

    const choice = normalize(texto) === '2' ? 'familia' : 'penal';
    const distritoObj = session.contexto.ultimaConsulta?.distritoObj || null;

    const fiscalia = resolverFiscaliaParaConsultaPorDistrito(distritoObj, choice);
    if (!fiscalia) {
      session.estado = 'ESPERANDO_RELATO';
      return { respuestaTexto: 'Gracias. No encontré la fiscalía en el registro. ¿Podrías indicarme el distrito exacto o el nombre de la fiscalía?', session };
    }

    session.estado = 'ESPERANDO_RELATO';
    session.contexto.ultimaConsulta = {
      ...(session.contexto.ultimaConsulta || {}),
      codigoFiscalia: fiscalia.codigo_fiscalia
    };

    const ficha = formatearFichaFiscalia(fiscalia, session.contexto.ultimaConsulta?.campo || null);
    return {
      respuestaTexto:
        'Aquí tienes la información:\n\n' +
        ficha +
        '\n\n' +
        'Si deseas, también puedo ayudarte con otra consulta.',
      session
    };
  }

  // 1) Si el usuario solo escribe "ubicacion/horario/telefono/correo", usar el contexto previo
  const soloCampo = ['ubicacion','ubicación','direccion','dirección','horario','telefono','teléfono','correo','email'];
  if (session.contexto.ultimaConsulta && soloCampo.includes(tNorm)) {
    const last = session.contexto.ultimaConsulta;
    if (last.codigoFiscalia) {
      const f = buscarFiscaliaPorCodigo(last.codigoFiscalia);
      if (f) {
        const campo = detectarCampoFiscaliaEnConsulta(texto) || last.campo || null;
        const ficha = formatearFichaFiscalia(f, campo);
        return {
          respuestaTexto:
            'Claro, aquí está:\n\n' +
            ficha +
            '\n\n' +
            '¿Te ayudo con algo más?',
          session
        };
      }
    }

    // si no hay fiscalía previa, pedimos distrito
    return { respuestaTexto: MSG.consultaNecesitaDistrito, session };
  }

  // 2) Procedimientos
  if (includesAny(texto, ['requisitos','pasos','tramite','trámite','procedimiento','como hago','cómo hago'])) {
    const proc = buscarMejorProcedimiento(texto);
    if (!proc) {
      session.contexto.ultimaConsulta = { tipo: 'procedimiento' };
      return {
        respuestaTexto:
          'Claro. ¿Sobre qué trámite necesitas información?\n' +
          'Por ejemplo: “Denuncia”, “constancia”, “copia de denuncia”, etc.',
        session
      };
    }

    session.contexto.ultimaConsulta = { tipo: 'procedimiento', tramite: proc.tramite };

    const partes = [];
    partes.push(`**Trámite:** ${proc.tramite}`);
    if (proc.pasos) partes.push(`\n**Pasos:**\n${proc.pasos}`);
    if (proc.requisitos) partes.push(`\n**Requisitos:**\n${proc.requisitos}`);
    if (proc.observaciones) partes.push(`\n**Observaciones:**\n${proc.observaciones}`);

    return {
      respuestaTexto:
        'Aquí tienes la información del trámite:\n\n' +
        partes.join('\n') +
        '\n\n' +
        'Si deseas, puedo ayudarte con otra consulta.',
      session
    };
  }

  // 3) Contacto (entidades / correos)
  if (includesAny(texto, ['contacto','correo','email','entidad'])) {
    const contactos = buscarContactos(texto);
    session.contexto.ultimaConsulta = { tipo: 'contacto' };

    const lines = contactos.map(c => {
      const l = [];
      l.push(`**${c.entidad}**`);
      if (c.direccion) l.push(`📍 ${c.direccion}`);
      if (c.telefono) l.push(`📞 ${c.telefono}`);
      if (c.correo) l.push(`✉️ ${c.correo}`);
      return l.join('\n');
    });

    return {
      respuestaTexto:
        'Aquí tienes contactos de referencia:\n\n' +
        lines.join('\n\n') +
        '\n\n' +
        'Si necesitas un contacto específico, dime el nombre de la entidad.',
      session
    };
  }

  // 4) FAQ
  if (includesAny(texto, ['faq','preguntas frecuentes','pregunta','duda','dudas'])) {
    const best = buscarMejorFAQ(texto);
    session.contexto.ultimaConsulta = { tipo: 'faq' };

    if (!best) {
      return {
        respuestaTexto:
          'Puedo ayudarte con preguntas frecuentes.\n' +
          'Cuéntame tu duda con una frase (por ejemplo: “¿cómo denunciar?”, “¿qué documentos necesito?”) y te respondo.',
        session
      };
    }

    return {
      respuestaTexto:
        `**Pregunta:** ${best.pregunta}\n` +
        `**Respuesta:** ${best.respuesta}\n\n` +
        '¿Deseas otra pregunta frecuente?',
      session
    };
  }

  // 5) Fiscalías: ubicación / horario / teléfono (por distrito/provincia o por nombre)
  if (campoFiscalia || includesAny(texto, ['fiscalia','fiscalía','ubicacion','ubicación','direccion','dirección','horario','telefono','teléfono','donde queda','dónde queda'])) {
    // 5.1 Si el usuario escribió un código (tipo FPT-CAJ-TURNO), lo buscamos
    const codigoMatch = texto.match(/[A-Z]{2,5}-[A-Z]{2,5}-[A-Z0-9]{2,}|FPT-[A-Z0-9-]+|FPV-[A-Z0-9-]+|FPM-[A-Z0-9-]+|FPF-[A-Z0-9-]+/i);
    if (codigoMatch) {
      const f = buscarFiscaliaPorCodigo(codigoMatch[0]);
      if (f) {
        session.contexto.ultimaConsulta = { tipo: 'fiscalia', codigoFiscalia: f.codigo_fiscalia, campo: campoFiscalia || 'direccion' };
        const ficha = formatearFichaFiscalia(f, campoFiscalia || 'direccion');
        return { respuestaTexto: 'Aquí tienes la información:\n\n' + ficha + '\n\n¿Te ayudo con algo más?', session };
      }
    }

    // 5.2 Si el usuario menciona una fiscalía por nombre
    const fiscaliaPorNombre = buscarFiscaliaPorNombre(texto);
    if (fiscaliaPorNombre) {
      session.contexto.ultimaConsulta = { tipo: 'fiscalia', codigoFiscalia: fiscaliaPorNombre.codigo_fiscalia, campo: campoFiscalia || 'direccion' };
      const ficha = formatearFichaFiscalia(fiscaliaPorNombre, campoFiscalia || 'direccion');
      return { respuestaTexto: 'Aquí tienes la información:\n\n' + ficha + '\n\n¿Te ayudo con algo más?', session };
    }

    // 5.3 Intentar por distrito
    const matches = getDistritosMatchesEnTexto(texto);

    if (matches.length > 1) {
      // ambigüedad tipo Bambamarca
      session.estado = 'CONSULTA_DISTRITO_AMBIGUO';
      session.contexto.opcionesConsultaDistritos = matches.slice(0, 2).map(d => ({
        etiqueta: `${d.distrito} (Provincia ${d.provincia})`,
        distrito: d.distrito,
        provincia: d.provincia,
        distritoObj: d
      }));

      const m = session.contexto.opcionesConsultaDistritos;
      session.contexto.ultimaConsulta = { tipo: 'fiscalia', campo: campoFiscalia || 'direccion' };

      return {
        respuestaTexto:
          MSG.confirmarDistritoAmbiguoIntro +
          '\n\n' +
          `1. ${m[0].etiqueta}\n` +
          `2. ${m[1].etiqueta}`,
        session
      };
    }

    if (matches.length === 1) {
      const distritoObj = matches[0];

      // si no especificó si quiere penal o familia y en el distrito existen ambos códigos, preguntamos
      const tieneFamilia = !!(distritoObj.fiscalia_familia_codigo && normalize(distritoObj.fiscalia_familia_codigo));
      const pideTipo = detectarTipoFiscaliaEnConsulta(texto);

      // si pide familia/violencia/prevención, usamos eso; si no pide, default penal/mixta
      // pero: si el usuario preguntó “fiscalía de X” (sin penal/familia) y ese distrito tiene familia, le damos penal/mixta y ofrecemos familia como opción
      const fiscalia = resolverFiscaliaParaConsultaPorDistrito(distritoObj, pideTipo || 'penal');

      if (!fiscalia) {
        session.contexto.ultimaConsulta = { tipo: 'fiscalia', distritoTexto: distritoObj.distrito, distritoObj, campo: campoFiscalia || 'direccion' };
        return {
          respuestaTexto:
            'No encontré la fiscalía de ese distrito en el registro.\n' +
            '¿Podrías indicarme el nombre exacto de la fiscalía o confirmar el distrito?',
          session
        };
      }

      session.contexto.ultimaConsulta = {
        tipo: 'fiscalia',
        codigoFiscalia: fiscalia.codigo_fiscalia,
        distritoTexto: distritoObj.distrito,
        distritoObj,
        campo: campoFiscalia || 'direccion'
      };

      const ficha = formatearFichaFiscalia(fiscalia, campoFiscalia || 'direccion');

      // si hay familia y el usuario no especificó, ofrecemos
      if (tieneFamilia && !pideTipo && !includesAny(texto, ['penal','mixta','familia','violencia','prevencion','prevención'])) {
        return {
          respuestaTexto:
            'Aquí tienes la información principal (Penal/Mixta):\n\n' +
            ficha +
            '\n\n' +
            'Si deseas información de la **Fiscalía de Familia** de esa provincia/distrito, dime: “familia” o responde “2”.',
          session
        };
      }

      return { respuestaTexto: 'Aquí tienes la información:\n\n' + ficha + '\n\n¿Te ayudo con algo más?', session };
    }

    // 5.4 Si no hay distrito, intentar por provincia
    const prov = detectarProvinciaEnTexto(texto);
    if (prov) {
      const ds = distritosPorProvincia(prov);

      // si existe un distrito con el mismo nombre que la provincia, lo usamos
      const distritoCapital = ds.find(d => normalize(d.distrito) === normalize(prov)) || null;

      if (distritoCapital) {
        const fiscalia = resolverFiscaliaParaConsultaPorDistrito(distritoCapital, tipoFiscaliaDeseada || 'penal');
        if (fiscalia) {
          session.contexto.ultimaConsulta = {
            tipo: 'fiscalia',
            codigoFiscalia: fiscalia.codigo_fiscalia,
            distritoTexto: distritoCapital.distrito,
            distritoObj: distritoCapital,
            campo: campoFiscalia || 'direccion'
          };

          const ficha = formatearFichaFiscalia(fiscalia, campoFiscalia || 'direccion');
          return {
            respuestaTexto:
              `Entiendo que te refieres a la provincia **${prov}**.\n\n` +
              'Aquí tienes la información:\n\n' +
              ficha +
              '\n\n¿Te ayudo con algo más?',
            session
          };
        }
      }

      // si no tenemos distrito capital claro, pedimos distrito (si son pocos, damos opciones)
      if (ds.length > 0 && ds.length <= 6) {
        const opciones = ds.map(d => `• ${d.distrito}`).join('\n');
        session.contexto.ultimaConsulta = { tipo: 'fiscalia', campo: campoFiscalia || 'direccion' };
        return {
          respuestaTexto:
            `En la provincia **${prov}** hay varios distritos.\n` +
            '¿De cuál distrito necesitas la información?\n\n' +
            opciones,
          session
        };
      }

      session.contexto.ultimaConsulta = { tipo: 'fiscalia', campo: campoFiscalia || 'direccion' };
      return { respuestaTexto: `Entiendo que te refieres a **${prov}**. ¿De qué distrito de esa provincia necesitas la información?`, session };
    }

    // No se pudo
    session.contexto.ultimaConsulta = { tipo: 'fiscalia', campo: campoFiscalia || 'direccion' };
    return { respuestaTexto: MSG.consultaNecesitaDistrito, session };
  }

  // 6) Si llegó aquí, no identificó bien la consulta
  session.contexto.ultimaConsulta = { tipo: 'otro' };
  return { respuestaTexto: MSG.consultaGeneral, session };
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
  // CONSULTA: distrito ambiguo (en modo consultas)
  // ---------------------------
  if (session.estado === 'CONSULTA_DISTRITO_AMBIGUO') {
    const ops = session.contexto.opcionesConsultaDistritos || [];
    if (!ops.length) {
      session.estado = 'ESPERANDO_RELATO';
      return { respuestaTexto: MSG.consultaNecesitaDistrito, session };
    }

    let elegido = texto;
    if (esOpcionNumerica(texto)) {
      const idx = Number(normalize(texto)) - 1;
      if (ops[idx]) elegido = ops[idx].distrito;
    }

    // encontrar distritoObj correspondiente
    const distritoObj = ops.find(o => normalize(o.distrito) === normalize(elegido))?.distritoObj || null;

    if (!distritoObj) {
      return { respuestaTexto: MSG.confirmarDistritoAmbiguoIntro + '\n\n' + `1. ${ops[0].etiqueta}\n2. ${ops[1].etiqueta}`, session };
    }

    session.estado = 'ESPERANDO_RELATO';

    // Si el usuario no especificó tipo de fiscalía y hay familia, preguntamos 1/2
    const tieneFamilia = !!(distritoObj.fiscalia_familia_codigo && normalize(distritoObj.fiscalia_familia_codigo));
    const last = session.contexto.ultimaConsulta || {};
    const campo = last.campo || 'direccion';

    session.contexto.ultimaConsulta = { ...last, distritoObj, distritoTexto: distritoObj.distrito, campo };

    if (tieneFamilia && !last.tipoFiscalia) {
      session.estado = 'CONSULTA_TIPO_FISCALIA';
      return { respuestaTexto: MSG.consultaNecesitaTipoFiscalia, session };
    }

    const fiscalia = resolverFiscaliaParaConsultaPorDistrito(distritoObj, last.tipoFiscalia || 'penal');
    if (!fiscalia) return { respuestaTexto: 'Gracias. No encontré la fiscalía en el registro. ¿Podrías confirmar el distrito exacto?', session };

    session.contexto.ultimaConsulta.codigoFiscalia = fiscalia.codigo_fiscalia;

    const ficha = formatearFichaFiscalia(fiscalia, campo);
    return {
      respuestaTexto:
        'Perfecto, gracias por confirmarlo.\n\n' +
        'Aquí tienes la información:\n\n' +
        ficha +
        '\n\n¿Te ayudo con algo más?',
      session
    };
  }

  // ---------------------------
  // Estados de DENUNCIA ya existentes
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

    session.estado = 'ESPERANDO_DISTRITO';
    return { respuestaTexto: MSG.pedirDistrito, session };
  }

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
  // Si el usuario está en FINAL y pregunta algo, lo atendemos igual
  // ---------------------------
  if (session.estado === 'FINAL') {
    // si parece consulta, atendemos la consulta (sin reiniciar primero)
    if (pareceConsultaPorHeuristica(texto)) {
      return responderConsulta(texto, session);
    }

    session = resetSession(session);
    return { respuestaTexto: MSG.reinicio, session };
  }

  // ---------------------------
  // CONSULTAS por heurística (sin gastar OpenAI)
  // ---------------------------
  if (pareceConsultaPorHeuristica(texto)) {
    session.estado = 'ESPERANDO_RELATO';
    return responderConsulta(texto, session);
  }

  // ---------------------------
  // Estado: INICIO / ESPERANDO_RELATO
  // Aquí sí usamos IA (si no fue consulta)
  // ---------------------------

  session.estado = session.estado === 'INICIO' ? 'ESPERANDO_RELATO' : session.estado;

  if (normalize(texto).length < 3) {
    return { respuestaTexto: MSG.noEntiendo, session };
  }

  let clasif;
  try {
    clasif = await clasificarMensaje(texto);
  } catch (err) {
    return { respuestaTexto: MSG.errorIA, session };
  }

  // distrito por IA + texto literal
  const distritoPorTexto = detectarDistritoEnTexto(texto);
  const distritoFinal = clasif.distrito || distritoPorTexto || null;

  // Guardar contexto
  session.contexto.delitoEspecifico = clasif.delito_especifico;
  session.contexto.materiaDetectada = clasif.materia;
  session.contexto.distritoTexto = distritoFinal;
  session.contexto.vinculoRespuesta = null;

  // Consultas (si la IA lo clasificó como consulta)
  if (clasif.tipo === 'consulta') {
    session.estado = 'ESPERANDO_RELATO';
    return responderConsulta(texto, session);
  }

  // Si no es denuncia clara
  if (clasif.tipo !== 'denuncia') {
    return { respuestaTexto: MSG.noEntiendo, session };
  }

  // Derivación denuncia
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
