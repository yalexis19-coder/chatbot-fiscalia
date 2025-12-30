// ia.js
// Lógica principal de IA – Ministerio Público (Fiscalía de Cajamarca)
//
// FUNCIÓN 1 (Derivación):
// - Relato -> Materia -> Distrito -> (Vínculo si aplica) -> Fiscalía competente
// - Manejo de estado y cierre conversacional

const OpenAI = require('openai');
const { resolverFiscalia } = require('./derivacion');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Utilitarios
// ---------------------------
const normalize = (str) =>
  (str || '')
    .toString()
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
  const saludos = new Set([
    'hola',
    'holi',
    'buenas',
    'buenos dias',
    'buenas tardes',
    'buenas noches',
    'hello',
    'hi'
  ]);
  return saludos.has(t);
}

// ✅ Mejorado: tolera errores de tipeo y variantes
function esInicioDenuncia(texto) {
  const t = normalize(texto);

  if (
    t === 'denuncia' ||
    t === 'denunciar' ||
    t === 'hacer una denuncia' ||
    t === 'quiero denunciar' ||
    t === 'quiero hacer una denuncia'
  ) return true;

  // Cubre "denncia", "denunica", "denuncai", etc.
  if (t.includes('denunc') || t.startsWith('denun')) return true;

  const comunes = new Set([
    'denncia',
    'denunica',
    'denucia',
    'denunsia',
    'denuncia.',
    'denuncia!'
  ]);
  if (comunes.has(t)) return true;

  return false;
}

function pareceCasoFamilia(texto) {
  return [
    'no me deja ver',
    'me impide ver',
    'regimen de visitas',
    'régimen de visitas',
    'tenencia',
    'custodia',
    'alimentos',
    'pension',
    'pensión',
    'divorcio',
    'separacion',
    'separación',
    'filiacion',
    'filiación',
    'reconocimiento',
    'conciliacion',
    'conciliación',
    'hijo',
    'hija',
    'menor'
  ].some(k => normalize(texto).includes(normalize(k)));
}

// Extrae posible distrito desde el texto: "en la encañada", "en cajabamba", etc.
function extraerDistritoDesdeTexto(texto) {
  const t = normalize(texto);
  const m = t.match(/\ben\s+(la|el|los|las)?\s*([a-z0-9ñ\s\-\(\)]+?)(?=$|[.,;:!?\n])/i);
  if (!m) return null;

  let candidato = (m[2] || '').trim();
  if (!candidato) return null;

  candidato = candidato.replace(/\s+/g, ' ').trim();
  if (candidato.length > 40) return null;

  const descartes = new Set(['mi casa', 'casa', 'la calle', 'mi barrio', 'el barrio', 'la ciudad']);
  if (descartes.has(candidato)) return null;

  return candidato;
}

function textoSugiereDenunciaPenal(texto) {
  const t = normalize(texto);
  const claves = [
    'robo', 'me robaron', 'asalto', 'me asaltaron', 'hurto', 'me hurtaron',
    'me quitaron', 'me arrebataron', 'me amenazaron', 'me golpearon',
    'agresion', 'agresión', 'extorsion', 'extorsión',
    'se llevaron mis cosas', 'ingresaron a mi casa', 'allanaron',
    'estafa', 'fraude'
  ];
  return claves.some(k => t.includes(k));
}

// ✅ NUEVO: si el texto indica agresor desconocido, no preguntar vínculo
function sugiereAgresorDesconocido(texto) {
  const t = normalize(texto);
  const claves = [
    'desconocido',
    'desconocida',
    'no lo conozco',
    'no la conozco',
    'no conozco a la persona',
    'una persona desconocida',
    'un desconocido',
    'un sujeto',
    'un señor',
    'una señora',
    'no se quien es',
    'no sé quien es',
    'no sé quién es'
  ];
  return claves.some(k => t.includes(k));

// ---------------------------
// Inferencia por Competencias (data-driven)
// - 1) Match por ESPECIFICO (si el ciudadano lo menciona)
// - 2) Match por DESCRIPCION (scoring por palabras clave)
// ---------------------------

const STOPWORDS_ES = new Set([
  'de','la','el','los','las','y','o','u','a','ante','bajo','con','contra','desde','durante','en',
  'entre','hacia','hasta','mediante','para','por','segun','sin','sobre','tras','del','al',
  'que','quien','quienes','cual','cuales','cuando','como','donde','porque','por que',
  'un','una','unos','unas','mi','mis','tu','tus','su','sus','me','te','se','lo','la','le','les',
  'ya','muy','mas','más','menos','si','sí','no','pero','tambien','también','ahora','ayer','hoy',
  'fue','era','son','es','esta','está','estan','están','estuvo','haber','hay','hubo','tener'
]);

function getField(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function tokensUtiles(texto) {
  const t = normalize(texto)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t) return [];
  const toks = t.split(' ')
    .map(x => x.trim())
    .filter(x => x.length >= 3 && !STOPWORDS_ES.has(x));
  return toks;
}

function scoreOverlap(textTokens, descTokens) {
  if (!textTokens.length || !descTokens.length) return 0;
  const setText = new Set(textTokens);
  let overlap = 0;
  for (const tok of descTokens) {
    if (setText.has(tok)) overlap += 1;
  }
  // Normalización suave para no favorecer descripciones larguísimas
  return overlap / Math.sqrt(descTokens.length);
}

// Retorna { materia, delitoEspecifico } o null
function inferirPorCompetencias(texto, competencias) {
  if (!Array.isArray(competencias) || !texto) return null;

  const tNorm = normalize(texto);

  // 1) Match fuerte por ESPECIFICO (cuando el ciudadano lo menciona)
  let bestExact = null;
  for (const c of competencias) {
    const espRaw = getField(c, 'especifico', 'ESPECIFICO');
    const catRaw = getField(c, 'categoria', 'CATEGORIA');
    const esp = normalize(espRaw);
    if (!esp || esp.length < 5) continue;

    if (tNorm.includes(esp)) {
      // el más largo gana
      if (!bestExact || esp.length > bestExact.espLen) {
        bestExact = { materia: catRaw || null, delitoEspecifico: espRaw || null, espLen: esp.length };
      }
    }
  }
  if (bestExact) {
    return { materia: bestExact.materia, delitoEspecifico: bestExact.delitoEspecifico };
  }

  // 2) Match por DESCRIPCION (cuando no menciona el nombre)
  const tTokens = tokensUtiles(texto);
  if (tTokens.length < 3) return null;

  let best = null;
  let second = null;

  for (const c of competencias) {
    const descRaw = getField(c, 'descripcion', 'DESCRIPCION');
    const espRaw = getField(c, 'especifico', 'ESPECIFICO');
    const catRaw = getField(c, 'categoria', 'CATEGORIA');

    if (!descRaw || !espRaw) continue;

    const dTokens = tokensUtiles(descRaw);
    if (dTokens.length < 5) continue;

    const s = scoreOverlap(tTokens, dTokens);

    // umbrales conservadores para evitar falsos positivos
    // (puedes ajustar luego según pruebas)
    if (s < 0.65) continue;

    const cand = { score: s, materia: catRaw || null, delitoEspecifico: espRaw || null };

    if (!best || cand.score > best.score) {
      second = best;
      best = cand;
    } else if (!second || cand.score > second.score) {
      second = cand;
    }
  }

  // Si hay empate fuerte, preferimos NO forzar y dejar que la IA decida
  if (best && second && Math.abs(best.score - second.score) < 0.10) {
    return null;
  }

  return best ? { materia: best.materia, delitoEspecifico: best.delitoEspecifico } : null;
}

}

// ---------------------------
// Clasificador IA
// ---------------------------
async function clasificarMensaje(texto) {
  const system = `
Devuelve SOLO este JSON (sin texto adicional):

{
  "tipo": "denuncia" | "consulta" | "otro",
  "delito_especifico": string | null,
  "materia": "Corrupción" | "Penal" | "violencia" | "Prevencion" | "familia" | "Crimen Organizado" | "Derechos Humanos" | "Extinción de Dominio" | "Materia Ambiental" | null,
  "distrito": string | null
}

Reglas:
- Si el ciudadano relata hechos para denunciar un delito, usa tipo="denuncia".
- Si pide información general (horarios, ubicación, trámites, etc.), usa tipo="consulta".
- "materia" debe ser UNA de las opciones exactas listadas.
- Si no estás seguro de la materia, devuelve materia=null.
- Si el texto menciona claramente un distrito, colócalo en "distrito"; si no, null.
- No inventes delitos ni distritos.
- Importante: usa "violencia" SOLO si el agresor es familiar/pareja/expareja o integrante del grupo familiar. Si es desconocido, usar "Penal".
`.trim();

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.2,
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
  // Asegurar estructura de sesión
  if (!session || typeof session !== 'object') {
    session = { estado: 'INICIO', contexto: null };
  }
  if (!session.estado) session.estado = 'INICIO';

  if (!session.contexto) {
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null,
      finalTurns: 0,
      cierreDefinitivo: false
    };
  } else {
    if (typeof session.contexto.finalTurns !== 'number') session.contexto.finalTurns = 0;
    if (typeof session.contexto.cierreDefinitivo !== 'boolean') session.contexto.cierreDefinitivo = false;
  }

  const tNorm = normalize(texto);

  // ---------------------------
  // 🔒 CIERRE DEFINITIVO: después del cierre, solo aceptar comandos
  // ---------------------------
  if (session.contexto?.cierreDefinitivo) {
    if (esInicioDenuncia(texto)) {
      session.estado = 'ESPERANDO_RELATO';
      session.contexto = {
        distritoTexto: null,
        delitoEspecifico: null,
        materiaDetectada: null,
        vinculoRespuesta: null,
        finalTurns: 0,
        cierreDefinitivo: false
      };
      return {
        respuestaTexto:
          'Perfecto. Cuéntame, por favor, ¿qué ocurrió? Puedes describir los hechos con tus palabras.',
        session
      };
    }

    if (tNorm === 'menu' || tNorm === 'menú' || tNorm === 'otra consulta') {
      session.estado = 'INICIO';
      session.contexto = null;
      return {
        respuestaTexto: 'De acuerdo. Puedes elegir una opción del menú para continuar.',
        session
      };
    }

    if (tNorm === 'documentos' || tNorm === 'que documentos' || tNorm === 'qué documentos') {
      return {
        respuestaTexto:
          'De forma general, se recomienda llevar: DNI (si lo tiene), una descripción clara de los hechos, datos de testigos (si existen) y cualquier evidencia disponible (fotos, mensajes, capturas, documentos). Si hay lesiones, un certificado o constancia médica puede ayudar.\n\nPara volver al inicio, escriba **Menú**. Para iniciar un nuevo caso, escriba **Denuncia**.',
        session
      };
    }

    return {
      respuestaTexto:
        'La orientación ha finalizado. Para continuar, escriba **Menú** o **Denuncia**.',
      session
    };
  }

  // ✅ Regla fuerte: "denuncia" (incluso con typo) reinicia el flujo completo desde cualquier estado
  if (esInicioDenuncia(texto)) {
    session.estado = 'ESPERANDO_RELATO';
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null,
      finalTurns: 0,
      cierreDefinitivo: false
    };
    return {
      respuestaTexto:
        'Perfecto. Cuéntame, por favor, ¿qué ocurrió? Puedes describir los hechos con tus palabras.',
      session
    };
  }

  // Saludos en INICIO: no intentar derivación
  if (session.estado === 'INICIO' && esSaludo(texto)) {
    return {
      respuestaTexto:
        'Hola 👋 Puedes elegir una opción del menú. Si deseas denunciar, escribe **Denuncia** o cuéntame brevemente qué ocurrió.',
      session
    };
  }

  // 1) Inicio / Relato
  if (session.estado === 'INICIO' || session.estado === 'ESPERANDO_RELATO') {
    // Prioridad: casos civiles de familia
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'familia';
      session.contexto.vinculoRespuesta = null;
      session.estado = 'ESPERANDO_DISTRITO';
      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    }

    const clasif = await clasificarMensaje(texto);

    // ✅ Refuerzo data-driven con Competencias (ESPECIFICO / DESCRIPCION)
    const inferido = inferirPorCompetencias(texto, knowledge.competencias);
    if (inferido) {
      session.contexto.delitoEspecifico = inferido.delitoEspecifico || null;
      session.contexto.materiaDetectada = inferido.materia || null;
    } else {
      session.contexto.delitoEspecifico = clasif.delito_especifico || null;

      // Default Penal si es denuncia y la IA no define materia
      if (!clasif.materia && (clasif.tipo === 'denuncia' || textoSugiereDenunciaPenal(texto))) {
        session.contexto.materiaDetectada = 'Penal';
      } else {
        session.contexto.materiaDetectada = clasif.materia || null;
      }
    }

    // ✅ Si el relato indica agresor desconocido, evitar "violencia" por vínculo:
    // solo forzar Penal cuando la materia actual es violencia/penal o no está definida.
    if (sugiereAgresorDesconocido(texto)) {
      const m = normalize(session.contexto.materiaDetectada);
      if (!m || m === 'penal' || m === 'violencia') {
        session.contexto.vinculoRespuesta = 'NO';
        session.contexto.materiaDetectada = 'Penal';
      }
    }

    // Extraer distrito si la IA no lo detectó
    session.contexto.distritoTexto = clasif.distrito || extraerDistritoDesdeTexto(texto) || null;

    // Reset de finalTurns al entrar a un caso nuevo
    session.contexto.finalTurns = 0;
    session.contexto.cierreDefinitivo = false;

    if (clasif.tipo === 'consulta' && session.estado === 'INICIO') {
      return {
        respuestaTexto:
          'Puedo orientarte mejor si eliges una opción del menú (Ubicación, Preguntas, Trámites, Contactos) o si indicas que deseas presentar una **Denuncia**.',
        session
      };
    }

    session.estado = 'DERIVACION';
  }

  // 2) Vínculo familiar
  if (session.estado === 'ESPERANDO_VINCULO') {
    const resp = esRespuestaSiNo(texto);
    if (!resp) {
      return {
        respuestaTexto: 'Por favor responda solo **sí** o **no**.',
        session
      };
    }

    session.contexto.vinculoRespuesta = resp;
    session.estado = 'DERIVACION';
  }

  // 3) Distrito (solo cuando lo pedimos)
  if (session.estado === 'ESPERANDO_DISTRITO') {
    session.contexto.distritoTexto = texto;
    session.estado = 'DERIVACION';
  }

  // 4) Derivación
  if (session.estado === 'DERIVACION') {
    if (!session.contexto.distritoTexto) {
      session.contexto.distritoTexto = extraerDistritoDesdeTexto(texto) || null;
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

    session.estado = 'ESPERANDO_RELATO';
    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente con esa información. ¿Podría describir nuevamente el caso e indicar el distrito si lo conoce?',
      session
    };
  }

  // 5) FINAL (anti-loop + reconoce 1 vez detalles y luego cierra definitivamente)
  if (session.estado === 'FINAL') {
    if (tNorm === 'menu' || tNorm === 'menú' || tNorm === 'otra consulta') {
      session.estado = 'INICIO';
      session.contexto = null;
      return {
        respuestaTexto: 'De acuerdo. Puedes elegir una opción del menú para continuar.',
        session
      };
    }

    if (tNorm === 'documentos' || tNorm === 'que documentos' || tNorm === 'qué documentos') {
      return {
        respuestaTexto:
          'De forma general, se recomienda llevar: DNI (si lo tiene), una descripción clara de los hechos, datos de testigos (si existen) y cualquier evidencia disponible (fotos, mensajes, capturas, documentos). Si hay lesiones, un certificado o constancia médica puede ayudar.\n\nPara volver al inicio, escriba **Menú**. Para iniciar un nuevo caso, escriba **Denuncia**.',
        session
      };
    }

    if (session.contexto.finalTurns < 1) {
      session.contexto.finalTurns += 1;

      return {
        respuestaTexto:
          'Gracias por el detalle. Con esa información, la orientación se mantiene.\n\n' +
          'Puede:\n' +
          '📂 Escribir **Documentos** para saber qué llevar.\n' +
          '🔁 Escribir **Menú** para volver al inicio.\n' +
          '📝 Escribir **Denuncia** para iniciar un nuevo caso.',
        session
      };
    }

    // ✅ Cierre definitivo
    session.contexto.cierreDefinitivo = true;

    return {
      respuestaTexto:
        'La orientación ha finalizado.\n\n' +
        'Para continuar, puede:\n' +
        '📝 Escribir **Denuncia** para iniciar un nuevo caso.\n' +
        '📂 Escribir **Documentos** para saber qué llevar.\n' +
        '🔁 Escribir **Menú** para volver al inicio.\n\n' +
        'Gracias por comunicarse con el Ministerio Público – Distrito Fiscal de Cajamarca.',
      session
    };
  }

  // Default
  return {
    respuestaTexto: 'Puedes contarme tu caso o escribir **Denuncia** para iniciar.',
    session
  };
}

module.exports = { responderIA };
