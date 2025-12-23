// ia.js
// Lógica principal de IA – Ministerio Público (Fiscalía de Cajamarca)
//
// Responsabilidades:
// - Clasificar el mensaje del ciudadano (materia / delito específico / distrito)
// - Gestionar el estado conversacional mínimo para la FUNCIÓN 1 (derivación a fiscalía)
// - Delegar la lógica normativa de competencia a derivacion.js (resolverFiscalia)

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

  // Coincidencias directas
  if (
    t === 'denuncia' ||
    t === 'denunciar' ||
    t === 'hacer una denuncia' ||
    t === 'quiero denunciar' ||
    t === 'quiero hacer una denuncia'
  ) return true;

  // Tolerancia por inclusión (cubre "denncia", "denunica", "denuncai", etc.)
  if (t.includes('denunc') || t.startsWith('denun')) return true;

  // Casos típicos de error corto
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
      vinculoRespuesta: null
    };
  }

  // ✅ Regla fuerte: cualquier "denuncia" (incluso con typo) reinicia el flujo completo
  if (esInicioDenuncia(texto)) {
    session.estado = 'ESPERANDO_RELATO';
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
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
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'familia';
      session.estado = 'ESPERANDO_DISTRITO';
      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    }

    const clasif = await clasificarMensaje(texto);

    session.contexto.delitoEspecifico = clasif.delito_especifico || null;

    // Default Penal si es denuncia y la IA no define materia
    if (!clasif.materia && (clasif.tipo === 'denuncia' || textoSugiereDenunciaPenal(texto))) {
      session.contexto.materiaDetectada = 'Penal';
    } else {
      session.contexto.materiaDetectada = clasif.materia || null;
    }

    // Extraer distrito si la IA no lo detectó
    session.contexto.distritoTexto = clasif.distrito || extraerDistritoDesdeTexto(texto) || null;

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

  // 5) FINAL (anti-loop)
  if (session.estado === 'FINAL') {
    const t = normalize(texto);

    if (t === 'otra consulta' || t === 'menu' || t === 'menú') {
      session.estado = 'INICIO';
      session.contexto = null;
      return {
        respuestaTexto: 'De acuerdo. Puedes elegir una opción del menú para continuar.',
        session
      };
    }

    if (t === 'documentos' || t === 'que documentos' || t === 'qué documentos') {
      return {
        respuestaTexto:
          'De forma general, se recomienda llevar: DNI (si lo tiene), una descripción clara de los hechos, datos de testigos (si existen) y cualquier evidencia disponible (fotos, mensajes, capturas, documentos). Si hay lesiones, un certificado o constancia médica puede ayudar.\n\nSi deseas, puedo orientarte mejor si me indicas el distrito y el tipo de caso.',
        session
      };
    }

    return {
      respuestaTexto:
        'La orientación principal ya fue brindada.\n\n' +
        'Puede:\n' +
        '1️⃣ Presentar su denuncia en la fiscalía indicada.\n' +
        '2️⃣ Escribir **Documentos** para saber qué llevar.\n' +
        '3️⃣ Escribir **Otra consulta** para iniciar un nuevo caso.',
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
