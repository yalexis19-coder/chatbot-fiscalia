// ia.js
// Lógica principal de IA – Ministerio Público (Fiscalía de Cajamarca)
// FUNCIÓN 1: Derivación a fiscalía competente (materia + distrito + vínculo si aplica)
//
// Este archivo mantiene el contrato:
//   responderIA(session, texto) -> { respuestaTexto, session }

const OpenAI = require('openai');
const { resolverFiscalia } = require('./derivacion');
const knowledge = require('./knowledge.json');

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

function levenshtein(a, b) {
  a = normalize(a);
  b = normalize(b);
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function tokensUtiles(texto) {
  const stop = new Set([
    'de','del','la','el','los','las','y','o','u','a','en','por','para','con','sin','un','una','unos','unas',
    'que','se','me','mi','mis','su','sus','al','lo','le','les','ya','ayer','hoy','manana','mañana',
    'es','esta','está','estan','están','estuvo','haber','hay','hubo','fue','eran','soy','eres','somos',
    'quiero','deseo','necesito','porfavor','por favor'
  ]);
  const t = normalize(texto).replace(/[^a-z0-9\s]/g, ' ');
  return t.split(/\s+/).filter(w => w.length >= 3 && !stop.has(w));
}

function esRespuestaSiNo(texto) {
  const t = normalize(texto);
  if (['si','sí','s','sip','claro','afirmativo'].includes(t)) return 'SI';
  if (['no','n','negativo'].includes(t)) return 'NO';
  return null;
}

function pareceCasoFamilia(texto) {
  const t = normalize(texto);
  return [
    'no me deja ver', 'me impide ver', 'regimen de visitas', 'régimen de visitas',
    'tenencia', 'custodia', 'alimentos', 'pension', 'pensión', 'divorcio', 'separacion',
    'separación', 'filiacion', 'filiación', 'reconocimiento', 'visitas', 'hijo', 'hija', 'menor'
  ].some(k => t.includes(normalize(k)));
}

function sugiereAgresorDesconocido(texto) {
  const t = normalize(texto);
  return [
    'desconocido','desconocida','no lo conozco','no la conozco','no conozco a la persona',
    'una persona desconocida','un desconocido','un sujeto','un señor','una señora',
    'no se quien es','no sé quien es','no sé quién es','no se quién es'
  ].some(k => t.includes(normalize(k)));
}

function esComandoMenu(texto) {
  const t = normalize(texto);
  return t === 'menu' || t === 'menú' || t === 'inicio';
}

function esComandoDocumentos(texto) {
  const t = normalize(texto);
  return t === 'documentos' || t === 'docs' || t === 'documento';
}

function esComandoOtraConsulta(texto) {
  const t = normalize(texto);
  return t === 'otra consulta' || t === 'nuevo caso' || t === 'nuevo' || t === 'reiniciar';
}

function esInicioDenuncia(texto) {
  const t = normalize(texto);
  if (!t) return false;
  // acepta "denuncia" con pequeños errores (denncia, denucia, etc.)
  const solo = t.replace(/[^a-z]/g, '');
  if (solo.includes('denunci')) return true;
  return levenshtein(solo, 'denuncia') <= 2;
}

function textoSugiereDenunciaPenal(texto) {
  const t = normalize(texto);
  return ['robaron','robo','asalto','extorsion','extorsión','amenaza','amenazaron','golpearon','agredio','agredió','violacion','violación','matar','homicidio','secuestro','droga'].some(k => t.includes(normalize(k)));
}

// ---------------------------
// Inferencia por Competencias (data-driven)
// 1) Match por ESPECIFICO (cuando el ciudadano lo menciona)
// 2) Match por DESCRIPCION (scoring conservador)
// ---------------------------
function inferirPorCompetencias(texto, competencias) {
  if (!Array.isArray(competencias) || !texto) return null;

  const tNorm = normalize(texto);
  if (!tNorm) return null;

  // 1) Match fuerte por ESPECIFICO
  let bestEsp = null;
  for (const c of competencias) {
    const esp = normalize(c.especifico);
    if (!esp || esp.length < 5) continue;
    if (tNorm.includes(esp)) {
      if (!bestEsp || esp.length > bestEsp.espLen) {
        bestEsp = { row: c, espLen: esp.length };
      }
    }
  }
  if (bestEsp) {
    return {
      materia: bestEsp.row.categoria || null,
      delitoEspecifico: bestEsp.row.especifico || null
    };
  }

  // 2) Scoring por DESCRIPCION (conservador)
  const tokensMsg = tokensUtiles(texto);
  if (tokensMsg.length < 4) return null; // muy poco texto, no arriesgar

  let best = null;
  for (const c of competencias) {
    const desc = normalize(c.descripcion);
    if (!desc || desc.length < 25) continue;

    const tokensDesc = tokensUtiles(desc);
    if (tokensDesc.length < 6) continue;

    // score: intersección de tokens
    const setDesc = new Set(tokensDesc);
    let hit = 0;
    for (const w of tokensMsg) {
      if (setDesc.has(w)) hit++;
    }

    // ratio simple
    const ratio = hit / Math.min(tokensMsg.length, 12);

    // umbral conservador
    if (hit >= 4 && ratio >= 0.35) {
      const score = hit * 10 + Math.round(ratio * 100);
      if (!best || score > best.score) best = { row: c, score };
    }
  }

  if (!best) return null;

  // Re-umbral final por seguridad
  if (best.score < 55) return null;

  return {
    materia: best.row.categoria || null,
    delitoEspecifico: best.row.especifico || null
  };
}

// ---------------------------
// Clasificador IA (solo apoyo)
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
- No inventes distrito. Si no es claro, usa null.
- Si el mensaje trata sobre alimentos/tenencia/visitas/custodia, usa "familia".
- Si se trata de violencia en el grupo familiar, usa "violencia" (pero puede requerir confirmar vínculo).
`.trim();

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
  // init
  if (!session) session = {};
  if (!session.contexto) {
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };
  }
  if (!session.estado) session.estado = 'INICIO';
  if (typeof session.finalTurns !== 'number') session.finalTurns = 0;

  const t = normalize(texto || '');

  // Comandos globales
  if (esComandoMenu(texto)) {
    session.estado = 'INICIO';
    session.finalTurns = 0;
    session.contexto = {
      distritoTexto: null,
      delitoEspecifico: null,
      materiaDetectada: null,
      vinculoRespuesta: null
    };
    return {
      respuestaTexto:
        'Hola 👋 Puedes elegir una opción del menú. Si deseas denunciar, escribe *Denuncia* o cuéntame brevemente qué ocurrió.',
      session
    };
  }

  if (esComandoOtraConsulta(texto)) {
    session.estado = 'ESPERANDO_RELATO';
    session.finalTurns = 0;
    session.contexto.distritoTexto = null;
    session.contexto.delitoEspecifico = null;
    session.contexto.materiaDetectada = null;
    session.contexto.vinculoRespuesta = null;
    return {
      respuestaTexto:
        'Perfecto. Cuéntame, por favor, ¿qué ocurrió? Puedes describir los hechos con tus palabras.',
      session
    };
  }

  if (esComandoDocumentos(texto)) {
    return {
      respuestaTexto:
        '📄 **Documentos sugeridos (orientativo):**\n' +
        '• DNI (si cuenta con él)\n' +
        '• Datos de la persona denunciada (si los conoce)\n' +
        '• Evidencias: fotos, videos, audios, chats, documentos\n' +
        '• Fecha, hora y lugar de los hechos\n\n' +
        'Si desea, escriba *Menú* para volver al inicio o *Denuncia* para iniciar un nuevo caso.',
      session
    };
  }

  // Cierre conversacional: evitar loops
  if (session.estado === 'FINAL') {
    session.finalTurns += 1;

    if (session.finalTurns === 1) {
      return {
        respuestaTexto:
          'La orientación principal ya fue brindada.\n\nPuede:\n' +
          '1️⃣ Presentar su denuncia en la fiscalía indicada.\n' +
          '📄 Escribir *Documentos* para saber qué llevar.\n' +
          '🏠 Escribir *Menú* para volver al inicio.\n' +
          '📝 Escribir *Denuncia* para iniciar un nuevo caso.',
        session
      };
    }

    // si insiste, no repetir lo mismo
    return {
      respuestaTexto:
        'Para continuar, escriba *Menú* (volver al inicio) o *Denuncia* (nuevo caso).',
      session
    };
  }

  // Inicio de Denuncia (con fix: si ya viene relato, usarlo)
  if (session.estado === 'INICIO') {
    if (esInicioDenuncia(texto)) {
      const textoLimpio = (texto || '').replace(/denuncia(r)?/ig, '').trim();

      session.estado = 'ESPERANDO_RELATO';
      session.finalTurns = 0;

      if (normalize(textoLimpio).length > 10) {
        // Tratar el mismo mensaje como relato
        return responderIA(session, textoLimpio);
      }

      return {
        respuestaTexto:
          'Perfecto. Cuéntame, por favor, ¿qué ocurrió? Puedes describir los hechos con tus palabras.',
        session
      };
    }

    // si escribe directo el caso sin decir "denuncia"
    session.estado = 'ESPERANDO_RELATO';
  }

  // Relato / Clasificación / Derivación
  if (session.estado === 'ESPERANDO_RELATO') {
    // si parece familia civil, directo
    if (pareceCasoFamilia(texto)) {
      session.contexto.materiaDetectada = 'familia';
      session.contexto.delitoEspecifico = null;
      session.contexto.distritoTexto = null;
      session.contexto.vinculoRespuesta = null;
      session.estado = 'ESPERANDO_DISTRITO';

      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    }

    const clasif = await clasificarMensaje(texto);

    // 1) Inferencia institucional por Competencias (si matchea, manda)
    const inferido = inferirPorCompetencias(texto, knowledge.competencias);
    if (inferido?.materia) {
      session.contexto.materiaDetectada = inferido.materia;
      session.contexto.delitoEspecifico = inferido.delitoEspecifico || null;
    } else {
      session.contexto.delitoEspecifico = clasif.delito_especifico || null;

      // caso "desconocido" -> evitar ASK_VINCULO, ir a Penal
      if (sugiereAgresorDesconocido(texto)) {
        session.contexto.vinculoRespuesta = 'NO';
        session.contexto.materiaDetectada = 'Penal';
      } else {
        // default Penal si es denuncia y la IA no define materia
        if (!clasif.materia && (clasif.tipo === 'denuncia' || textoSugiereDenunciaPenal(texto))) {
          session.contexto.materiaDetectada = 'Penal';
        } else {
          session.contexto.materiaDetectada = clasif.materia || null;
        }
      }
    }

    session.contexto.distritoTexto = clasif.distrito || null;

    session.estado = 'DERIVACION';
  }

  // Esperando distrito / Derivación
  if (session.estado === 'DERIVACION' || session.estado === 'ESPERANDO_DISTRITO') {
    if (!session.contexto.distritoTexto) {
      // si estamos esperando distrito, usar el texto como distrito
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
      session.finalTurns = 0;
      return { respuestaTexto: res.mensaje, session };
    }

    // NO_MATCH / ASK_CLARIFY
    session.estado = 'ESPERANDO_RELATO';
    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente con esa información. ¿Podría describir nuevamente el caso e indicar el distrito si lo conoce?',
      session
    };
  }

  // Vínculo familiar
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

    // no reinyectar el mismo texto "sí/no" como distrito; mantener distrito actual
    return responderIA(session, session.contexto.distritoTexto || texto);
  }

  // Default
  return {
    respuestaTexto:
      'Hola 👋 Puedes elegir una opción del menú. Si deseas denunciar, escribe *Denuncia* o cuéntame brevemente qué ocurrió.',
    session
  };
}

module.exports = { responderIA };
