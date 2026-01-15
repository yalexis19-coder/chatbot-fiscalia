// derivacion.js
// Motor de derivación basado en knowledge.json
// Ajustes clave:
// - AliasDistritos + tolerancia a typos leves (fuzzy match)
// - Vínculo familiar SOLO se pregunta si el distrito tiene Fiscalía de Violencia
// - Si el relato sugiere agresión y el distrito tiene violencia, pero no se identificó delito_especifico, se pregunta vínculo.

const knowledge = require('./knowledge.json');

const normalize = (str) =>
  (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

function isBlank(v) {
  return v === null || v === undefined || normalize(v) === '';
}

function esAlcanceDistrito(valor) {
  const v = normalize(valor).replace(/_/g, ' ');
  return v === 'distrito';
}

function esAlcanceDistritoFiscal(valor) {
  const v = normalize(valor).replace(/_/g, ' ');
  return v === 'distrito fiscal';
}

function normalizarRequiereVinculo(v) {
  const t = normalize(v);
  if (!t) return null;
  if (t === 'si' || t === 'sí') return 'SI';
  if (t === 'no') return 'NO';
  if (t === 'depende') return 'DEPENDE';
  return null;
}

function normalizeDistritoKey(str) {
  let s = normalize(str);
  if (!s) return '';
  s = s.replace(/\([^)]*\)/g, '').trim();          // sin paréntesis
  s = s.replace(/^(el|la|los|las)\s+/g, '').trim(); // sin artículo inicial
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------
// Fuzzy matching (typos leves)
// ---------------------------
function levenshtein(a, b) {
  a = normalize(a); b = normalize(b);
  if (a === b) return 0;
  if (!a) return (b || '').length;
  if (!b) return (a || '').length;
  const m = a.length, n = b.length;
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

// ---------------------------
// Resolver distrito (alias + fuzzy)
// ---------------------------
function resolverAliasDistrito(aliasDistritos, texto) {
  const t = normalize(texto);
  if (!t) return null;

  const exact = (aliasDistritos || []).find(a => normalize(a.alias) === t);
  if (exact) return exact.distrito_destino;

  const cand = (aliasDistritos || []).map(a => normalize(a.alias)).filter(Boolean);
  const hit = bestFuzzyMatch(cand, t, 2);
  if (!hit) return null;

  const row = (aliasDistritos || []).find(a => normalize(a.alias) === hit);
  return row ? row.distrito_destino : null;
}

function findDistritoRecord(distritos, distritoTexto) {
  // 1) Intento exacto por nombre COMPLETO (incluye paréntesis).
  //    Esto permite desambiguar casos como "Bolívar (Bolívar)" vs "Bolívar (San Miguel)"
  //    cuando el usuario ya eligió una opción específica.
  const full = normalize(distritoTexto);
  if (!full) return null;
  const exactFull = (distritos || []).find(x => normalize(x.distrito) === full);
  if (exactFull) return exactFull;

  // 2) Fallback: matching tolerante sin paréntesis (comportamiento previo)
  const d = normalizeDistritoKey(distritoTexto);
  if (!d) return null;

  const exact = (distritos || []).find(x => normalizeDistritoKey(x.distrito) === d);
  if (exact) return exact;

  const cand = (distritos || []).map(x => normalizeDistritoKey(x.distrito)).filter(Boolean);
  const hit = bestFuzzyMatch(cand, d, 2);
  if (!hit) return null;

  return (distritos || []).find(x => normalizeDistritoKey(x.distrito) === hit) || null;
}

function tieneFiscaliaViolencia(distritoRec) {
  if (!distritoRec) return false;
  const tv = normalize(distritoRec.tiene_fiscalia_violencia);
  if (tv === 'si' || tv === 'sí' || tv === 'true' || tv === '1') return true;
  const cod = normalize(distritoRec.fiscalia_violencia_codigo);
  return cod !== '';
}

function findFiscaliaByCodigo(fiscalias, codigo) {
  const c = normalize(codigo);
  if (!c) return null;
  return (fiscalias || []).find(f => normalize(f.codigo_fiscalia) === c) || null;
}

function findReglaDistrito(reglas, materia, distrito) {
  const m = normalize(materia);
  const d = normalizeDistritoKey(distrito);
  return (reglas || []).find(r =>
    normalize(r.materia) === m &&
    esAlcanceDistrito(r.alcance) &&
    normalizeDistritoKey(r.distrito) === d
  ) || null;
}

function findReglaDistritoFiscal(reglas, materia) {
  const m = normalize(materia);
  return (reglas || []).find(r =>
    normalize(r.materia) === m &&
    esAlcanceDistritoFiscal(r.alcance) &&
    isBlank(r.distrito)
  ) || null;
}

function formatearRespuestaFiscalia({ fiscalia, materia, distrito, delito, nota }) {
  let msg =
    `Según la información brindada, su caso correspondería a la materia *${materia}*.
` +
    `Distrito indicado: *${distrito}*.
`;

  // Mostrar el supuesto delito identificado solo cuando exista y no sea Familia/Prevencion
  if (delito && normalize(materia) !== 'familia' && normalize(materia) !== 'prevencion') {
    msg += `Delito probable identificado: *${delito}*.
`;
  }

  msg +=
    `
📌 *Fiscalía sugerida:* ${fiscalia.nombre_fiscalia}
` +
    `📍 Dirección: ${fiscalia.direccion}
` +
    `☎️ Teléfono: ${fiscalia.telefono}
` +
    `🕒 Horario: ${fiscalia.horario}`;

  if (nota) msg += `

ℹ️ Nota: ${nota}`;
  return msg;
}


function findCompetenciaByEspecifico(competencias, delitoEspecifico) {
  const e = normalize(delitoEspecifico);
  if (!e) return null;
  return (competencias || []).find(c => normalize(c.especifico) === e) || null;
}


// ---------------------------
// Motor principal
// ---------------------------
function resolverFiscalia(contexto) {
  const { competencias, reglasCompetencia, distritos, fiscalias, aliasDistritos } = knowledge;

  let materia = contexto.materiaDetectada || null;
  const delitoEspecifico = contexto.delitoEspecifico || null;
  const vinculoRespuesta = contexto.vinculoRespuesta || null;

  // Distrito (alias + fuzzy)
  let distritoTexto = contexto.distritoTexto;
  if (isBlank(distritoTexto)) {
    return {
      status: 'ASK_DISTRITO',
      mensaje: 'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.'
    };
  }

  const alias = resolverAliasDistrito(aliasDistritos, distritoTexto);
  if (alias) distritoTexto = alias;

  const distritoRec = findDistritoRecord(distritos, distritoTexto);
  const distritoFinal = distritoRec ? distritoRec.distrito : distritoTexto;

  // Prioridad Familia si ya viene como familia
  if (normalize(materia) === 'familia' && distritoRec?.fiscalia_familia_codigo) {
    const fiscaliaFam = findFiscaliaByCodigo(fiscalias, distritoRec.fiscalia_familia_codigo);
    if (fiscaliaFam) {
      return {
        status: 'OK',
        fiscalia: fiscaliaFam,
        mensaje: formatearRespuestaFiscalia({ fiscalia: fiscaliaFam, materia: 'Familia', distrito: distritoFinal, delito: null })
      };
    }
  }

  const comp = findCompetenciaByEspecifico(competencias, delitoEspecifico);
  const requiere = normalizarRequiereVinculo(
    comp?.['Requiere vinculo familiar'] ?? comp?.requiere_vinculo_familiar ?? comp?.requiereVinculoFamiliar
  );
  const categoriaSiFamiliar =
    comp?.['Categoria_si_familiar'] ?? comp?.categoria_si_familiar ?? comp?.categoriaSiFamiliar ?? null;

  const hayViolencia = tieneFiscaliaViolencia(distritoRec);

  // 1) Si la materia es Violencia, SOLO preguntar vínculo si hay fiscalía de violencia.
  if (normalize(materia) === 'violencia' && !vinculoRespuesta) {
    if (hayViolencia) {
      return {
        status: 'ASK_VINCULO',
        mensaje: 'Para orientarle mejor: ¿la persona denunciada es su pareja, expareja o un familiar cercano? Responda solo “sí” o “no”.'
      };
    }
    materia = 'Penal';
  }

  // 2) Si Penal y requiere vínculo (SI/DEPENDE), preguntar SOLO si hayViolencia
  if ((requiere === 'SI' || requiere === 'DEPENDE') && !vinculoRespuesta) {
    if (hayViolencia) {
      return {
        status: 'ASK_VINCULO',
        mensaje: 'Para orientarle mejor: ¿la persona denunciada es su pareja, expareja o un familiar cercano? Responda solo “sí” o “no”.'
      };
    }
    materia = 'Penal';
  }

  // 4) Resolver DEPENDE con respuesta
  if (requiere === 'DEPENDE' && vinculoRespuesta) {
    if (vinculoRespuesta === 'SI' && !isBlank(categoriaSiFamiliar)) materia = categoriaSiFamiliar;
    if (vinculoRespuesta === 'NO') materia = 'Penal';
  }

  // 5) Si respondió NO, no debe quedar Violencia familiar
  if (vinculoRespuesta === 'NO' && normalize(materia) === 'violencia') {
    materia = 'Penal';
  }

  if (isBlank(materia)) return { status: 'NO_MATCH' };

  // ReglasCompetencia
  let regla = findReglaDistrito(reglasCompetencia, materia, distritoFinal);
  if (!regla) regla = findReglaDistritoFiscal(reglasCompetencia, materia);
  if (!regla) return { status: 'NO_MATCH' };

  const fiscalia = findFiscaliaByCodigo(fiscalias, regla.fiscalia_destino_codigo);
  if (!fiscalia) return { status: 'NO_MATCH' };

  return {
    status: 'OK',
    fiscalia,
    mensaje: formatearRespuestaFiscalia({
      fiscalia,
      materia,
      distrito: distritoFinal,
      delito: delitoEspecifico || null,
      nota: regla.observacion_opcional || null
    })
  };
}

module.exports = { resolverFiscalia };