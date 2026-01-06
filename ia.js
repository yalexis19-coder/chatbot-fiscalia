// ia.js
// Lógica principal de IA – Ministerio Público (Fiscalía de Cajamarca)
// FUNCIÓN 1: Derivación a fiscalía competente (materia + distrito + vínculo si aplica)
//
// ✅ IMPORTANTE (proyecto):
// - La lógica principal de derivación (Competencias + ReglasCompetencia + distrito + vínculo) NO se modifica.
// - En esta etapa solo se añade/ajusta UX: menú, textos, opciones informativas (FAQ/Contacto/Ubicación/Operador).

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

function bestFuzzyMatch(candidates, input, maxDist = 2) {
  const t = normalize(input);
  if (!t) return null;
  let best = null;
  for (const c of candidates) {
    const d = levenshtein(t, c);
    if (d <= maxDist && (!best || d < best.d)) best = { v: c, d };
  }
  return best ? best.v : null;
}

function isBlank(v) {
  return v === null || v === undefined || normalize(v) === '';
}

function esSaludo(texto) {
  const t = normalize(texto);
  if (!t) return false;
  return ['hola','buenas','buenos dias','buenas tardes','buenas noches','hey','ola','holi'].includes(t);
}

function tokensUtiles(texto) {
  const stop = new Set([
    'de','del','la','el','los','las','y','o','u','a','en','por','para','con','sin','un','una','unos','unas',
    'que','se','me','mi','mis','su','sus','al','lo','le','les','ya','ayer','hoy','manana','mañana',
    'es','esta','está','estan','están','estuvo','haber','hay','hubo','fue','eran','soy','eres','somos',
    'quiero','deseo','necesito','porfavor','por favor','ok','gracias'
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

// Familia CIVIL (visitas, alimentos, etc.). No usar "hijo/menor" como único indicador.
function pareceCasoFamilia(texto) {
  const t = normalize(texto);
  return [
    'no me deja ver', 'me impide ver', 'regimen de visitas', 'régimen de visitas',
    'tenencia', 'custodia', 'alimentos', 'demanda de alimentos',
    'pension', 'pensión', 'pension de alimentos', 'pensión de alimentos',
    'divorcio', 'separacion', 'separación',
    'filiacion', 'filiación', 'reconocimiento', 'visitas'
  ].some(k => t.includes(normalize(k)));
}

// Indicadores de agresor NO familiar (evita violencia familiar/familia por defecto)
function sugiereAgresorNoFamiliar(texto) {
  const t = normalize(texto);
  return [
    'vecino','vecina','desconocido','desconocida','extraño','extrano','persona desconocida',
    'un sujeto','un señor','una señora','no lo conozco','no la conozco','no conozco a la persona',
    'compañero','companero','colega','profesor','docente','director','chofer','taxista','mototaxista'
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
  return t === 'menu' || t === 'menú' || t === 'inicio' || t === 'home';
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
  const solo = t.replace(/[^a-z]/g, '');
  if (solo.includes('denunci')) return true;
  return levenshtein(solo, 'denuncia') <= 2;
}

function textoSugiereDenunciaPenal(texto) {
  const t = normalize(texto);
  return [
    'robaron','robo','asalto','extorsion','extorsión','amenaza','amenazaron',
    'golpearon','agredio','agredió','agredida','agredido','lesion','lesión',
    'violacion','violación','matar','homicidio','secuestro','droga'
  ].some(k => t.includes(normalize(k)));
}

function pareceRelato(texto) {
  const toks = tokensUtiles(texto);
  return toks.length >= 5 || normalize(texto).length >= 25 || textoSugiereDenunciaPenal(texto) || pareceCasoFamilia(texto);
}

// ---------------------------
// MENÚ (UX) – conectado a knowledge.json (sin hardcode de reglas de derivación)
// ---------------------------
function menuPrincipalTexto() {
  return (
`👋 *Ministerio Público – Distrito Fiscal de Cajamarca*
Seleccione una opción (escriba el número o el nombre):

1️⃣ *Presentar denuncia* (orientación por delito y distrito)
2️⃣ *Ubicación de una fiscalía* (dirección / teléfono / horario)
3️⃣ *FAQ* (preguntas frecuentes)
4️⃣ *Datos de contacto* (entidades y líneas útiles)
5️⃣ *Hablar con operador* (WhatsApp)

Puede escribir *Menú* en cualquier momento para volver aquí.`
  );
}

function detectarOpcionMenuPrincipal(texto) {
  const t = normalize(texto);
  if (!t) return null;

  const map = {
    '1': 'DENUNCIA',
    'denuncia': 'DENUNCIA',
    'presentar denuncia': 'DENUNCIA',
    '2': 'UBICACION',
    'ubicacion': 'UBICACION',
    'ubicación': 'UBICACION',
    'fiscalia': 'UBICACION',
    'fiscalía': 'UBICACION',
    'direccion': 'UBICACION',
    'dirección': 'UBICACION',
    '3': 'FAQ',
    'faq': 'FAQ',
    'preguntas': 'FAQ',
    'preguntas frecuentes': 'FAQ',
    '4': 'CONTACTO',
    'contacto': 'CONTACTO',
    'datos de contacto': 'CONTACTO',
    'telefonos': 'CONTACTO',
    'teléfonos': 'CONTACTO',
    '5': 'OPERADOR',
    'operador': 'OPERADOR',
    'whatsapp': 'OPERADOR',
    'hablar con operador': 'OPERADOR',
  };

  if (map[t]) return map[t];

  // tolerancia: si escribe "2 ubicacion", "3 faq", etc.
  if (t.startsWith('1')) return 'DENUNCIA';
  if (t.startsWith('2')) return 'UBICACION';
  if (t.startsWith('3')) return 'FAQ';
  if (t.startsWith('4')) return 'CONTACTO';
  if (t.startsWith('5')) return 'OPERADOR';

  return null;
}

function resetContextoDerivacion(session) {
  session.contexto = {
    distritoTexto: null,
    delitoEspecifico: null,
    materiaDetectada: null,
    vinculoRespuesta: null
  };
}

function limpiarEstadoMenu(session) {
  delete session.menu;
}

function initMenu(session) {
  session.estado = 'INICIO';
  session.finalTurns = 0;
  resetContextoDerivacion(session);
  limpiarEstadoMenu(session);
}

// --- Ubicación: resolver fiscalía por nombre/código o por distrito ---
function buscarFiscaliasPorTexto(texto, fiscalias) {
  const t = normalize(texto);
  if (!t || !Array.isArray(fiscalias)) return [];

  // match por código exacto (si lo escriben)
  const exactCodigo = fiscalias.find(f => normalize(f.codigo_fiscalia) === t);
  if (exactCodigo) return [exactCodigo];

  // match por nombre (contiene)
  const hits = fiscalias.filter(f => normalize(f.nombre_fiscalia).includes(t));
  if (hits.length) return hits.slice(0, 5);

  // fuzzy por nombre (para typos leves)
  const cand = fiscalias.map(f => normalize(f.nombre_fiscalia)).filter(Boolean);
  const hit = bestFuzzyMatch(cand, t, 2);
  if (!hit) return [];
  const row = fiscalias.find(f => normalize(f.nombre_fiscalia) === hit);
  return row ? [row] : [];
}

function resolverDistritoRecordMenu(texto) {
  const { distritos, aliasDistritos } = knowledge || {};
  let t = normalize(texto);
  if (!t) return null;

  // alias exacto
  const aExact = (aliasDistritos || []).find(a => normalize(a.alias) === t);
  if (aExact) t = normalize(aExact.distrito_destino);

  // match exacto
  const exact = (distritos || []).find(d => normalize(d.distrito) === t);
  if (exact) return exact;

  // fuzzy
  const cand = (distritos || []).map(d => normalize(d.distrito)).filter(Boolean);
  const hit = bestFuzzyMatch(cand, t, 2);
  if (!hit) return null;
  return (distritos || []).find(d => normalize(d.distrito) === hit) || null;
}


function resolverProvinciaRecordMenu(texto) {
  const { distritos } = knowledge || {};
  let t = normalize(texto);
  if (!t) return null;

  const provincias = Array.from(new Set((distritos || []).map(d => d.provincia).filter(Boolean)));
  // match exacto
  const exact = provincias.find(p => normalize(p) === t);
  if (exact) return exact;

  // fuzzy
  const cand = provincias.map(p => normalize(p));
  const hit = bestFuzzyMatch(cand, t, 2);
  if (!hit) return null;
  const row = provincias.find(p => normalize(p) === hit);
  return row || null;
}

function fiscaliasPorLugar({ lugarKey, fiscalias }) {
  const key = normalize(lugarKey);
  if (!key) return [];
  return (fiscalias || []).filter(f => {
    const n = normalize(f.nombre_fiscalia);
    const d = normalize(f.direccion);
    return (n && n.includes(key)) || (d && d.includes(key));
  });
}

function fiscaliasPorCodigos(codigos, fiscalias) {
  const set = new Set((codigos || []).map(c => normalize(c)).filter(Boolean));
  if (!set.size) return [];
  const hits = (fiscalias || []).filter(f => set.has(normalize(f.codigo_fiscalia)));
  return hits;
}

function obtenerFiscaliasParaDistritoRec(distritoRec, fiscalias) {
  if (!distritoRec) return [];
  const codigos = [];
  if (distritoRec.fiscalia_penal_mixta_codigo) codigos.push(distritoRec.fiscalia_penal_mixta_codigo);
  if (distritoRec.fiscalia_familia_codigo) codigos.push(distritoRec.fiscalia_familia_codigo);
  if (normalize(distritoRec.tiene_fiscalia_violencia) === 'si' && distritoRec.fiscalia_violencia_codigo) {
    codigos.push(distritoRec.fiscalia_violencia_codigo);
  }
  if (normalize(distritoRec.tiene_fiscalia_prevencion) === 'si' && distritoRec.fiscalia_prevencion_codigo) {
    codigos.push(distritoRec.fiscalia_prevencion_codigo);
  }

  // 1) Por códigos (cuando el distrito deriva a una sede)
  const porCodigo = fiscaliasPorCodigos(codigos, fiscalias);

  // 2) Por “lugar” (provincia normalmente, para incluir 1ra/2da, corporativas, etc.)
  const lugarKey = distritoRec.provincia || distritoRec.distrito;
  const porLugar = fiscaliasPorLugar({ lugarKey, fiscalias });

  // Unir sin duplicados
  const map = new Map();
  for (const f of [...porCodigo, ...porLugar]) map.set(normalize(f.codigo_fiscalia), f);
  return Array.from(map.values()).sort((a, b) => (a.nombre_fiscalia || '').localeCompare(b.nombre_fiscalia || ''));
}

function obtenerFiscaliasParaProvincia(provincia, fiscalias) {
  const { distritos } = knowledge || {};
  const prov = provincia;
  if (!prov) return [];

  // 1) Códigos a partir de todos los distritos de la provincia (cubre sedes asignadas)
  const rows = (distritos || []).filter(d => normalize(d.provincia) === normalize(prov));
  const cods = [];
  for (const r of rows) {
    if (r.fiscalia_penal_mixta_codigo) cods.push(r.fiscalia_penal_mixta_codigo);
    if (r.fiscalia_familia_codigo) cods.push(r.fiscalia_familia_codigo);
    if (normalize(r.tiene_fiscalia_violencia) === 'si' && r.fiscalia_violencia_codigo) cods.push(r.fiscalia_violencia_codigo);
    if (normalize(r.tiene_fiscalia_prevencion) === 'si' && r.fiscalia_prevencion_codigo) cods.push(r.fiscalia_prevencion_codigo);
  }
  const porCodigo = fiscaliasPorCodigos(cods, fiscalias);

  // 2) Por texto del lugar (incluye sedes con el nombre de la provincia)
  const porLugar = fiscaliasPorLugar({ lugarKey: prov, fiscalias });

  const map = new Map();
  for (const f of [...porCodigo, ...porLugar]) map.set(normalize(f.codigo_fiscalia), f);
  return Array.from(map.values()).sort((a, b) => (a.nombre_fiscalia || '').localeCompare(b.nombre_fiscalia || ''));
}

function formatearFichaFiscalia(f) {
  if (!f) return null;
  return (
`📌 *${f.nombre_fiscalia}*
📍 Dirección: ${f.direccion || '—'}
☎️ Teléfono: ${f.telefono || '—'}
🕒 Horario: ${f.horario || '—'}`
  );
}

// ---------------------------
// Inferencia por Competencias (data-driven)
// 1) ESPECIFICO
// 2) DESCRIPCION (scoring conservador)
// ---------------------------
function inferirPorCompetencias(texto, competencias) {
  if (!Array.isArray(competencias) || !texto) return null;
  const tNorm = normalize(texto);
  if (!tNorm) return null;

  const tokensMsg = tokensUtiles(texto);
  if (tokensMsg.length < 3) return null;

  // 1) Match directo por ESPECIFICO (si el ciudadano lo escribe tal cual)
  let bestEsp = null;
  for (const c of competencias) {
    const esp = normalize(c.especifico);
    if (!esp || esp.length < 5) continue;
    if (tNorm.includes(esp)) {
      if (!bestEsp || esp.length > bestEsp.espLen) bestEsp = { row: c, espLen: esp.length };
    }
  }
  if (bestEsp) {
    return { materia: bestEsp.row.categoria || null, delitoEspecifico: bestEsp.row.especifico || null };
  }

  // 2) Scoring por overlap usando: ESPECIFICO + SUBGENERICO + GENERICO + DESCRIPCION
  let best = null;
  for (const c of competencias) {
    const blob = [c.especifico, c.subgenerico, c.generico, c.descripcion].filter(Boolean).join(' | ');
    const blobNorm = normalize(blob);
    if (!blobNorm || blobNorm.length < 15) continue;

    const tokensBlob = tokensUtiles(blobNorm);
    if (tokensBlob.length < 6) continue;

    const setBlob = new Set(tokensBlob);
    let hit = 0;
    for (const w of tokensMsg) if (setBlob.has(w)) hit++;

    const denom = Math.min(tokensMsg.length, 12);
    const ratio = denom ? (hit / denom) : 0;

    if (hit >= 4 && ratio >= 0.28) {
      const score = hit * 10 + Math.round(ratio * 100);
      if (!best || score > best.score) best = { row: c, score };
    }
  }

  if (!best) return null;
  if (best.score < 50) return null;

  return { materia: best.row.categoria || null, delitoEspecifico: best.row.especifico || null };
}

// ---------------------------
// Clasificador IA (apoyo)
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
  if (!session) session = {};
  if (!session.contexto) {
    resetContextoDerivacion(session);
  }
  if (!session.estado) session.estado = 'INICIO';
  if (typeof session.finalTurns !== 'number') session.finalTurns = 0;

  // ---------------------------
  // Saludo / Inicio
  // ---------------------------
  if (esSaludo(texto) && (session.estado === 'INICIO' || session.estado === 'FINAL')) {
    initMenu(session);
    return { respuestaTexto: menuPrincipalTexto(), session };
  }

  // ---------------------------
  // Comandos globales
  // ---------------------------
  if (esComandoMenu(texto)) {
    initMenu(session);
    return { respuestaTexto: menuPrincipalTexto(), session };
  }

  if (esComandoOtraConsulta(texto)) {
    session.estado = 'ESPERANDO_RELATO';
    session.finalTurns = 0;
    resetContextoDerivacion(session);
    limpiarEstadoMenu(session);
    return {
      respuestaTexto:
        'Perfecto. Cuénteme, por favor, ¿qué ocurrió? Puede describir los hechos con sus palabras.',
      session
    };
  }

  if (esComandoDocumentos(texto)) {
    return {
      respuestaTexto:
        '📄 *Documentos sugeridos (orientativo):*\n' +
        '• DNI (si cuenta con él)\n' +
        '• Datos de la persona denunciada (si los conoce)\n' +
        '• Evidencias: fotos, videos, audios, chats, documentos\n' +
        '• Fecha, hora y lugar de los hechos\n\n' +
        'Puede escribir *Menú* para volver al inicio o *Denuncia* para iniciar un nuevo caso.',
      session
    };
  }

  // ---------------------------
  // Estados de MENÚ (FAQ/Contacto/Ubicación/Operador)
  // ---------------------------
  
  if (session.estado === 'MENU_UBICACION') {
    const fiscalias = knowledge?.fiscalias || [];

    // 1) Intentar resolver como DISTRITO (alias + fuzzy) => mostrar TODAS las fiscalías asociadas
    const distritoRec = resolverDistritoRecordMenu(texto);
    if (distritoRec) {
      const lista = obtenerFiscaliasParaDistritoRec(distritoRec, fiscalias);

      if (lista.length) {
        session.estado = 'FINAL';
        session.finalTurns = 0;

        const tope = 12;
        const visibles = lista.slice(0, tope);
        const cuerpo = visibles.map(f => `

${formatearFichaFiscalia(f)}`).join('');
        const extra = lista.length > tope
          ? `

…y ${lista.length - tope} más. Si desea, escriba parte del nombre (ej.: “familia”, “turno”, “penal corporativa”).`
          : '';

        return {
          respuestaTexto:
            `✅ Provincia: *${distritoRec.provincia}*
✅ Distrito: *${distritoRec.distrito}*` +
            cuerpo +
            extra +
            `

Puede escribir *Menú* para ver otras opciones.`,
          session
        };
      }
    }

    // 2) Intentar resolver como PROVINCIA (fuzzy) => mostrar TODAS las fiscalías de la provincia
    const provincia = resolverProvinciaRecordMenu(texto);
    if (provincia) {
      const lista = obtenerFiscaliasParaProvincia(provincia, fiscalias);
      if (lista.length) {
        session.estado = 'FINAL';
        session.finalTurns = 0;

        const tope = 12;
        const visibles = lista.slice(0, tope);
        const cuerpo = visibles.map(f => `

${formatearFichaFiscalia(f)}`).join('');
        const extra = lista.length > tope
          ? `

…y ${lista.length - tope} más. Si desea, escriba parte del nombre (ej.: “familia”, “turno”, “penal corporativa”).`
          : '';

        return {
          respuestaTexto:
            `✅ Provincia: *${provincia}*` +
            cuerpo +
            extra +
            `

Puede escribir *Menú* para ver otras opciones.`,
          session
        };
      }
    }

    // 3) Buscar fiscalía por nombre/código (match flexible)
    const hits = buscarFiscaliasPorTexto(texto, fiscalias);
    if (hits.length === 1) {
      session.estado = 'FINAL';
      session.finalTurns = 0;
      return {
        respuestaTexto:
          formatearFichaFiscalia(hits[0]) +
          `

Puede escribir *Menú* para ver otras opciones.`,
        session
      };
    }
    if (hits.length > 1) {
      const listado = hits.map((f, i) => `${i + 1}) ${f.nombre_fiscalia}`).join('\n');
      session.menu = { tipo: 'UBICACION_LISTA', hits };
      return {
        respuestaTexto:
          `Encontré varias coincidencias. Responda con el número para ver la ubicación:
${listado}

` +
          `O escriba un *distrito/provincia* (ej.: “Celendín”, “Cajamarca”) o parte del nombre.`,
        session
      };
    }

    return {
      respuestaTexto:
        `No encontré coincidencias. Puede intentar:
• escribir solo el *distrito* (ej.: “Jesús”, “Celendín”)
• escribir la *provincia* (ej.: “Cajamarca”, “Chota”)
• escribir parte del *nombre* (ej.: “familia”, “turno”, “penal corporativa”)

También puede escribir *Menú* para volver.`,
      session
    };
  }

  if (session.menu?.tipo === 'UBICACION_LISTA' && session.estado === 'MENU_UBICACION') {
    // (este bloque queda por claridad; el flujo real se maneja arriba)
  }

  if (session.estado === 'MENU_FAQ') {
    const faqs = knowledge?.faq || [];
    if (!Array.isArray(faqs) || faqs.length === 0) {
      initMenu(session);
      return {
        respuestaTexto:
          'Por el momento no tengo cargada la sección de FAQ en la base de conocimiento.\n\n' +
          menuPrincipalTexto(),
        session
      };
    }

    const t = normalize(texto);

    // seleccionar por número
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= faqs.length) {
      const item = faqs[n - 1];
      return {
        respuestaTexto:
          `❓ *${item.pregunta}*\n\n${item.respuesta}\n\n` +
          'Escriba otro número para otra pregunta, o *Menú* para volver.',
        session
      };
    }

    // búsqueda por palabra clave
    const hits = faqs
      .map((x, idx) => ({ idx, p: x.pregunta || '', r: x.respuesta || '' }))
      .filter(x => normalize(x.p).includes(t) || normalize(x.r).includes(t))
      .slice(0, 5);

    if (hits.length) {
      const listado = hits.map((h, i) => `${i + 1}) ${faqs[h.idx].pregunta}`).join('\n');
      session.menu = { tipo: 'FAQ_HITS', hits };
      return {
        respuestaTexto:
          `Encontré estas preguntas relacionadas. Responda con el número:\n${listado}\n\n` +
          'O escriba otra palabra clave, o *Menú* para volver.',
        session
      };
    }

    return {
      respuestaTexto:
        'Escriba el *número* de la pregunta o una *palabra clave* (ej.: “pruebas”, “gratuita”, “turno”).\n\n' +
        'Escriba *Menú* para volver.',
      session
    };
  }

  if (session.estado === 'MENU_CONTACTO') {
    const contactos = knowledge?.contacto || [];
    if (!Array.isArray(contactos) || contactos.length === 0) {
      initMenu(session);
      return {
        respuestaTexto:
          'Por el momento no tengo cargada la sección de contactos en la base de conocimiento.\n\n' +
          menuPrincipalTexto(),
        session
      };
    }

    // paginado simple
    if (!session.menu) session.menu = { tipo: 'CONTACTO', page: 0 };
    const t = normalize(texto);
    if (t === 'mas' || t === 'más' || t === 'siguiente') session.menu.page += 1;
    if (t === 'atras' || t === 'atrás' || t === 'anterior') session.menu.page = Math.max(0, session.menu.page - 1);

    const pageSize = 5;
    const start = session.menu.page * pageSize;
    const slice = contactos.slice(start, start + pageSize);

    if (!slice.length) {
      session.menu.page = 0;
      return {
        respuestaTexto:
          'No hay más resultados. Escriba *Más* para continuar (si corresponde) o *Menú* para volver.',
        session
      };
    }

    const lines = slice.map((c, i) =>
      `• *${c.entidad || '—'}*\n  📍 ${c.direccion || '—'}\n  ☎️ ${c.telefono || '—'}\n  ✉️ ${c.correo || '—'}`
    ).join('\n\n');

    const hayMas = (start + pageSize) < contactos.length;
    return {
      respuestaTexto:
        `📞 *Contactos útiles (página ${session.menu.page + 1})*\n\n${lines}\n\n` +
        (hayMas ? 'Escriba *Más* para ver más contactos, o *Menú* para volver.' : 'Escriba *Menú* para volver.'),
      session
    };
  }

  if (session.estado === 'MENU_OPERADOR') {
    const ops = knowledge?.operadores || [];
    const op = Array.isArray(ops) ? ops.find(o => normalize(o.activo) === 'si') : null;

    if (!op) {
      initMenu(session);
      return {
        respuestaTexto:
          'Por el momento no tengo configurado un operador en la base de conocimiento.\n\n' +
          menuPrincipalTexto(),
        session
      };
    }

    // Armar un mensaje sugerido (sin URL directa)
    const distrito = session.contexto?.distritoTexto || '—';
    const resumen = session.contexto?.delitoEspecifico ? `Delito probable: ${session.contexto.delitoEspecifico}` : (session.contexto?.materiaDetectada ? `Materia: ${session.contexto.materiaDetectada}` : 'Consulta general');
    const sugerido = (op.mensaje_prellenado || 'Hola, solicito orientación general. Mi caso es: {resumen_caso}. Distrito: {distrito}.')
      .replace('{resumen_caso}', resumen)
      .replace('{distrito}', distrito);

    session.estado = 'FINAL';
    session.finalTurns = 0;
    return {
      respuestaTexto:
        `${op.mensaje_inicial || 'Puedo derivarlo con un operador para orientación general.'}\n\n` +
        `📱 *WhatsApp:* +${op.numero_whatsapp}\n` +
        `🕒 *Horario:* ${op.horario || '—'}\n\n` +
        `✍️ *Mensaje sugerido para copiar y pegar:*\n${sugerido}\n\n` +
        `Puede escribir *Menú* para volver.`,
      session
    };
  }

  // Resolver selección dentro de listas (FAQ_HITS / UBICACION_LISTA)
  if (session.menu?.tipo === 'FAQ_HITS' && session.estado === 'MENU_FAQ') {
    const t = normalize(texto);
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= session.menu.hits.length) {
      const faqs = knowledge?.faq || [];
      const idx = session.menu.hits[n - 1].idx;
      const item = faqs[idx];
      return {
        respuestaTexto:
          `❓ *${item.pregunta}*\n\n${item.respuesta}\n\n` +
          'Escriba otro número/palabra clave, o *Menú* para volver.',
        session
      };
    }
  }

  if (session.menu?.tipo === 'UBICACION_LISTA' && session.estado === 'MENU_UBICACION') {
    const t = normalize(texto);
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= session.menu.hits.length) {
      const f = session.menu.hits[n - 1];
      session.estado = 'FINAL';
      session.finalTurns = 0;
      return {
        respuestaTexto:
          formatearFichaFiscalia(f) +
          `\n\nPuede escribir *Menú* para ver otras opciones.`,
        session
      };
    }
  }

  // ---------------------------
  // Cierre conversacional (sin tocar lógica de derivación)
  // ---------------------------
  if (session.estado === 'FINAL') {
    // ✅ Si escribe "Denuncia" en cierre, iniciar nuevo caso
    if (esInicioDenuncia(texto)) {
      const textoLimpio = (texto || '').replace(/denuncia(r)?/ig, '').trim();
      session.estado = 'ESPERANDO_RELATO';
      session.finalTurns = 0;
      resetContextoDerivacion(session);
      limpiarEstadoMenu(session);

      if (normalize(textoLimpio).length > 10) {
        return responderIA(session, textoLimpio);
      }
      return {
        respuestaTexto:
          'Perfecto. Cuénteme, por favor, ¿qué ocurrió? Puede describir los hechos con sus palabras.',
        session
      };
    }

    // Si en cierre piden operador/faq/contacto/ubicación, permitirlo como atajo
    const opt = detectarOpcionMenuPrincipal(texto);
    if (opt === 'UBICACION') { session.estado = 'MENU_UBICACION'; session.menu = null; return { respuestaTexto: 'Indique el *distrito* o el *nombre/código* de la fiscalía que desea ubicar.', session }; }
    if (opt === 'FAQ') { session.estado = 'MENU_FAQ'; session.menu = null; const faqs = knowledge?.faq || []; const listado = (faqs || []).slice(0, 10).map((x,i)=>`${i+1}) ${x.pregunta}`).join('\n'); return { respuestaTexto: `📚 *FAQ*\n${listado}\n\nResponda con el número o una palabra clave.`, session }; }
    if (opt === 'CONTACTO') { session.estado = 'MENU_CONTACTO'; session.menu = { tipo:'CONTACTO', page:0 }; return responderIA(session, ''); }
    if (opt === 'OPERADOR') { session.estado = 'MENU_OPERADOR'; return responderIA(session, texto); }

    session.finalTurns += 1;
    if (session.finalTurns === 1) {
      return {
        respuestaTexto:
          'La orientación principal ya fue brindada.\n\nPuede:\n' +
          '📄 Escribir *Documentos* para saber qué llevar.\n' +
          '🏠 Escribir *Menú* para ver opciones (FAQ / Contacto / Ubicación / Operador).\n' +
          '📝 Escribir *Denuncia* para iniciar un nuevo caso.',
        session
      };
    }
    return { respuestaTexto: 'Para continuar, escriba *Menú* o *Denuncia*.', session };
  }

  // ---------------------------
  // Estado INICIO (MENÚ)
  // ---------------------------
  if (session.estado === 'INICIO') {
    // 1) Si el usuario elige opción del menú
    const opt = detectarOpcionMenuPrincipal(texto);
    if (opt) {
      limpiarEstadoMenu(session);
      if (opt === 'DENUNCIA') {
        // Mantener flujo actual: iniciar relato
        session.estado = 'ESPERANDO_RELATO';
        session.finalTurns = 0;
        resetContextoDerivacion(session);
        return {
          respuestaTexto:
            'Perfecto. Cuénteme, por favor, ¿qué ocurrió? Puede describir los hechos con sus palabras.',
          session
        };
      }

      if (opt === 'UBICACION') {
        session.estado = 'MENU_UBICACION';
        session.menu = null;
        return {
          respuestaTexto:
            'Indique el *distrito* o el *nombre/código* de la fiscalía que desea ubicar.',
          session
        };
      }

      if (opt === 'FAQ') {
        session.estado = 'MENU_FAQ';
        session.menu = null;
        const faqs = knowledge?.faq || [];
        if (!Array.isArray(faqs) || faqs.length === 0) {
          initMenu(session);
          return { respuestaTexto: 'No tengo cargada la sección de FAQ en la base de conocimiento.\n\n' + menuPrincipalTexto(), session };
        }
        const listado = faqs.slice(0, 10).map((x, i) => `${i + 1}) ${x.pregunta}`).join('\n');
        return {
          respuestaTexto:
            `📚 *FAQ*\n${listado}\n\nResponda con el número o una palabra clave.`,
          session
        };
      }

      if (opt === 'CONTACTO') {
        session.estado = 'MENU_CONTACTO';
        session.menu = { tipo: 'CONTACTO', page: 0 };
        return responderIA(session, '');
      }

      if (opt === 'OPERADOR') {
        session.estado = 'MENU_OPERADOR';
        return responderIA(session, texto);
      }
    }

    // 2) Denuncia por palabra clave
    if (esInicioDenuncia(texto)) {
      const textoLimpio = (texto || '').replace(/denuncia(r)?/ig, '').trim();
      session.estado = 'ESPERANDO_RELATO';
      session.finalTurns = 0;
      resetContextoDerivacion(session);
      limpiarEstadoMenu(session);

      if (normalize(textoLimpio).length > 10) {
        return responderIA(session, textoLimpio);
      }
      return {
        respuestaTexto:
          'Perfecto. Cuénteme, por favor, ¿qué ocurrió? Puede describir los hechos con sus palabras.',
        session
      };
    }

    // 3) Si NO parece relato, mostrar menú (antes decía “solo denuncia”)
    if (!pareceRelato(texto)) {
      return { respuestaTexto: menuPrincipalTexto(), session };
    }

    // 4) Si parece relato, pasamos al flujo de denuncia existente
    session.estado = 'ESPERANDO_RELATO';
  }

  // ---------------------------
  // Relato (lógica existente – NO se cambia el fondo)
  // ---------------------------
  if (session.estado === 'ESPERANDO_RELATO') {
    const tRel = normalize(texto);

    // ✅ Caso penal con agresor NO familiar (ej. vecino/desconocido):
    // Primero pedir el distrito (NO intentar derivar sin distrito).
    if (sugiereAgresorNoFamiliar(texto) && (tRel.includes('agred') || tRel.includes('golpe') || tRel.includes('lesion') || tRel.includes('lesión') || tRel.includes('amenaz'))) {
      session.contexto.vinculoRespuesta = 'NO';
      session.contexto.materiaDetectada = 'Penal';
      session.contexto.delitoEspecifico = null;
      session.contexto.distritoTexto = null;
      session.estado = 'ESPERANDO_DISTRITO';

      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    } else if (pareceCasoFamilia(texto) && !sugiereAgresorNoFamiliar(texto)) {
      // Familia civil (visitas/alimentos/etc.)
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
    } else {
      const clasif = await clasificarMensaje(texto);

      // 1) Inferencia institucional por Competencias (manda si matchea)
      const inferido = inferirPorCompetencias(texto, knowledge.competencias);
      if (inferido?.materia) {
        session.contexto.materiaDetectada = inferido.materia;
        session.contexto.delitoEspecifico = inferido.delitoEspecifico || null;
      } else {
        // 2) Fallback IA: cuando no calza con Competencias
        session.contexto.delitoEspecifico = clasif.delito_especifico || null;

        // Si el relato sugiere agresor NO familiar (vecino/desconocido), marcamos NO vínculo y Penal.
        if (sugiereAgresorDesconocido(texto) || sugiereAgresorNoFamiliar(texto)) {
          session.contexto.vinculoRespuesta = 'NO';
          session.contexto.materiaDetectada = 'Penal';
        } else {
          // ✅ NO asumir Penal automáticamente.
          // Si la IA detecta una materia (incluye Familia/Prevencion), la usamos para derivar por ReglasCompetencia.
          session.contexto.materiaDetectada = clasif.materia || null;
        }
      }

      session.contexto.distritoTexto = clasif.distrito || null;

      // Si no se pudo identificar materia ni por Competencias ni por IA, pedir al ciudadano que elija una materia.
      if (!session.contexto.materiaDetectada) {
        session.estado = 'ESPERANDO_MATERIA';
        return {
          respuestaTexto:
            'Para orientarle mejor, indique el tipo de caso (puede escribir una opción):\n' +
            '1) Penal\n' +
            '2) Violencia\n' +
            '3) Familia\n' +
            '4) Prevencion\n' +
            '5) Materia Ambiental\n' +
            '6) Corrupción\n' +
            '7) Crimen Organizado\n' +
            '8) Derechos Humanos\n' +
            '9) Extinción de Dominio',
          session
        };
      }

      session.estado = 'DERIVACION';
    }
  }

  // ---------------------------
  // Derivación / distrito (lógica existente – NO se cambia)
  // ---------------------------
  if (session.estado === 'DERIVACION' || session.estado === 'ESPERANDO_DISTRITO') {
    if (!session.contexto.materiaDetectada) {
      session.estado = 'INICIO';
      return { respuestaTexto: menuPrincipalTexto(), session };
    }

    // Si ya estamos esperando distrito, tomar la respuesta como distrito y continuar
    if (session.estado === 'ESPERANDO_DISTRITO') {
      session.contexto.distritoTexto = texto;
    }

    // ✅ Si aún no tenemos distrito, primero preguntarlo (no usar el mismo relato como distrito)
    if (!session.contexto.distritoTexto) {
      session.estado = 'ESPERANDO_DISTRITO';
      return {
        respuestaTexto:
          'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
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

    session.estado = 'ESPERANDO_RELATO';
    return {
      respuestaTexto:
        'No pude determinar la fiscalía competente con esa información. ¿Podría describir nuevamente el caso e indicar el distrito si lo conoce?',
      session
    };
  }

  // ---------------------------
  // Materia (cuando no se pudo inferir) – lógica existente
  // ---------------------------
  if (session.estado === 'ESPERANDO_MATERIA') {
    const t = normalize(texto);
    const map = {
      '1': 'Penal',
      'penal': 'Penal',
      '2': 'Violencia',
      'violencia': 'Violencia',
      'violencia familiar': 'Violencia',
      '3': 'Familia',
      'familia': 'Familia',
      '4': 'Prevencion',
      'prevencion': 'Prevencion',
      'prevención': 'Prevencion',
      '5': 'Materia Ambiental',
      'ambiental': 'Materia Ambiental',
      'materia ambiental': 'Materia Ambiental',
      '6': 'Corrupción',
      'corrupcion': 'Corrupción',
      'corrupción': 'Corrupción',
      '7': 'Crimen Organizado',
      'crimen organizado': 'Crimen Organizado',
      '8': 'Derechos Humanos',
      'derechos humanos': 'Derechos Humanos',
      '9': 'Extinción de Dominio',
      'extincion de dominio': 'Extinción de Dominio',
      'extinción de dominio': 'Extinción de Dominio'
    };

    const materiaSel = map[t] || null;
    if (!materiaSel) {
      return {
        respuestaTexto:
          'Por favor, escriba una de estas opciones: Penal, Violencia, Familia, Prevencion, Materia Ambiental, Corrupción, Crimen Organizado, Derechos Humanos, Extinción de Dominio.',
        session
      };
    }

    session.contexto.materiaDetectada = materiaSel;

    if (!session.contexto.distritoTexto) {
      session.estado = 'ESPERANDO_DISTRITO';
      return {
        respuestaTexto:
          'Gracias. Ahora indíqueme en qué distrito ocurrieron los hechos.',
        session
      };
    }

    session.estado = 'DERIVACION';
    return responderIA(session, session.contexto.distritoTexto);
  }

  // ---------------------------
  // Vínculo – lógica existente
  // ---------------------------
  if (session.estado === 'ESPERANDO_VINCULO') {
    const resp = esRespuestaSiNo(texto);
    if (!resp) return { respuestaTexto: 'Por favor responda solo "sí" o "no".', session };

    session.contexto.vinculoRespuesta = resp;
    session.estado = 'DERIVACION';

    // volver a derivar sin usar "sí/no" como distrito
    return responderIA(session, session.contexto.distritoTexto || '');
  }

  // fallback
  initMenu(session);
  return { respuestaTexto: menuPrincipalTexto(), session };
}

module.exports = { responderIA };
