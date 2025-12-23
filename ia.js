// ia.js
// Lógica principal de IA – Ministerio Público (Fiscalía de Cajamarca)
//
// Responsabilidades:
// - Clasificar el mensaje del ciudadano (materia / delito específico / distrito)
// - Gestionar el estado conversacional mínimo para la FUNCIÓN 1 (derivación a fiscalía)
// - Delegar la lógica normativa de competencia a derivacion.js (resolverFiscalia)
//
// Requiere:
// - derivacion.js (exporta resolverFiscalia)

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

function esInicioDenuncia(texto) {
  const t = normalize(texto);
  return t === 'denuncia' || t === 'hacer una denuncia' || t === 'quiero denunciar';
}

function pareceCasoFamilia(texto) {
  // Heurística simple para consultas típicas de familia
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

// ✅ Extrae un posible distrito desde el texto: "en la encañada", "en cajabamba", etc.
function extraerDistritoDesdeTexto(texto) {
  const t = normalize(texto);

  // Buscar " en <algo>" o " en la/el/los/las <algo>"
  // Capturamos hasta 40 caracteres o hasta un separador
  const m = t.match(/\ben\s+(la|el|los|las)?\s*([a-z0-9ñ\s\-\(\)]+?)(?=$|[.,;:!?\n])/i);
  if (!m) return null;

  let candidato = (m[2] || '').trim();
  if (!candidato) return null;

  // Limpiar espacios dobles
  candidato = candidato.replace(/\s+/g, ' ').trim();

  // Si viene muy largo, probablemente no es un distrito (evitar "en la encañada y luego...")
  if (candidato.length > 40) return null;

  // Evitar cosas demasiado genéricas
  const descartes = new Set(['mi casa', 'casa', 'la calle', 'mi barrio', 'el barrio', 'la ciudad']);
  if (descartes.has(candidato)) return null;

  // Reponer mayúsculas tipo título solo para guardar más bonito (resolverFiscalia normaliza igual)
  // "la encanada" -> "la encanada" (no hace falta perfecto)
  return candidato;
}

// ---------------------------
// Clasificador IA
// ---------------------------
async function clasificarMensaje(texto) {
  // ⚠️ Importante: las materias deben coincidir con tu modelo/ReglasCompetencia
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
- Si el texto menciona claramente un distrito (p. ej. "La Encañada", "Cachachi"), colócalo en "distrito"; si no, null.
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

  // 0) Saludos en INICIO: no intentar derivación
  if (session.estado === 'INICIO' && esSaludo(texto)) {
    return {
      respuestaTexto:
        'Hola 👋 Puedes elegir una opción del menú. Si deseas denunciar, escribe **Denuncia** o cuéntame brevemente qué ocurrió.',
      session
    };
  }

  // 0.1) Si el usuario escribe "Denuncia" (sin usar botón)
  if (session.estado === 'INICIO' && esInicioDenuncia(texto)) {
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

  // 1) Inicio / Relato
  if (session.estado === 'INICIO' || session.estado === 'ESPERANDO_RELATO') {
    // Heurística familia (consulta típica): no forzar "penal" si es civil/familia
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'familia';
      session.estado = 'ESPERANDO_DISTRITO';
      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    }

    // Clasificar con IA
    const clasif = await clasificarMensaje(texto);

    // Guardar contexto
    session.contexto.delitoEspecifico = clasif.delito_especifico || null;
    session.contexto.materiaDetectada = clasif.materia || null;

    // ✅ Si la IA no encontró distrito, intentamos extraerlo del texto
    session.contexto.distritoTexto = clasif.distrito || extraerDistritoDesdeTexto(texto) || null;

    // Si claramente es consulta y no denuncia, responder neutro (por ahora)
    if (clasif.tipo === 'consulta' && session.estado === 'INICIO') {
      return {
        respuestaTexto:
          'Puedo orientarte mejor si eliges una opción del menú (Ubicación, Preguntas, Trámites, Contactos) o si indicas que deseas presentar una **Denuncia**.',
        session
      };
    }

    // Pasar a derivación
    session.estado = 'DERIVACION';
  }

  // 2) Vínculo familiar (si se está esperando)
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

  // 3) Distrito (si se está esperando)
  if (session.estado === 'ESPERANDO_DISTRITO') {
    // Capturar distrito SOLO aquí (evita que "hola" sea distrito)
    session.contexto.distritoTexto = texto;
    session.estado = 'DERIVACION';
  }

  // 4) Derivación
  if (session.estado === 'DERIVACION') {
    // ✅ Fix adicional: si aún no hay distrito, intentar extraerlo del texto actual
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

    // Si no se pudo derivar, pedimos más detalle sin resetear todo
    session.estado = 'ESPERANDO_RELATO';
    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente con esa información. ¿Podría describir nuevamente el caso e indicar el distrito si lo conoce?',
      session
    };
  }

  // 5) Estado FINAL: permitir que el ciudadano continúe sin reiniciar
  if (session.estado === 'FINAL') {
    if (esInicioDenuncia(texto)) {
      session.estado = 'ESPERANDO_RELATO';
      session.contexto = {
        distritoTexto: null,
        delitoEspecifico: null,
        materiaDetectada: null,
        vinculoRespuesta: null
      };
      return {
        respuestaTexto: 'De acuerdo. Cuéntame, por favor, ¿qué ocurrió?',
        session
      };
    }

    return {
      respuestaTexto:
        '¿Deseas agregar algún detalle adicional del caso (por ejemplo, fecha, lugar o si conoces a la persona involucrada)?',
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
