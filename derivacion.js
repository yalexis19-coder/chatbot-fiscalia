// derivacion.js
// Motor de derivación con:
// - AliasDistritos
// - Soporte alcance distrito / distrito_fiscal (también "distrito_fiscal")
// - Prioridad absoluta para FAMILIA
// - Decisión de VÍNCULO según knowledge.json (Competencias: "Requiere vinculo familiar" y "Categoria_si_familiar")

const knowledge = require('./knowledge.json');

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

function isBlank(v) {
  return v === null || v === undefined || normalize(v) === '';
}

function esAlcanceDistrito(valor) {
  const v = normalize(valor).replace(/_/g, ' ');
  return v === 'distrito';
}

function esAlcanceDistritoFiscal(valor) {
  const v = normalize(valor).replace(/_/g, ' ');
  // soporta: "distrito fiscal" y "distrito_fiscal"
  return v === 'distrito fiscal';
}

function findDistritoRecord(distritos, distritoTexto) {
  const d = normalize(distritoTexto);
  if (!d) return null;
  return distritos.find(x => normalize(x.distrito) === d) || null;
}

function tieneFiscaliaViolencia(distritoRec) {
  if (!distritoRec) return false;
  const tv = normalize(distritoRec.tiene_fiscalia_violencia);
  if (tv === 'si' || tv === 'sí' || tv === 'true' || tv === '1') return true;
  const cod = normalize(distritoRec.fiscalia_violencia_codigo);
  return cod !== '';
}

function resolverAliasDistrito(aliasDistritos, texto) {
  const t = normalize(texto);
  if (!t) return null;
  const hit = aliasDistritos.find(a => normalize(a.alias) === t);
  return hit ? hit.distrito_destino : null;
}

function findFiscaliaByCodigo(fiscalias, codigo) {
  const c = normalize(codigo);
  if (!c) return null;
  return fiscalias.find(f => normalize(f.codigo_fiscalia) === c) || null;
}

function findReglaDistrito(reglas, materia, distrito) {
  const m = normalize(materia);
  const d = normalize(distrito);
  return reglas.find(r =>
    normalize(r.materia) === m &&
    esAlcanceDistrito(r.alcance) &&
    normalize(r.distrito) === d
  ) || null;
}

function findReglaDistritoFiscal(reglas, materia) {
  const m = normalize(materia);
  return reglas.find(r =>
    normalize(r.materia) === m &&
    esAlcanceDistritoFiscal(r.alcance) &&
    isBlank(r.distrito)
  ) || null;
}

function formatearRespuestaFiscalia({ fiscalia, materia, distrito, nota }) {
  let msg =
    `Según la información brindada, su caso correspondería a la materia *${materia}*.\n` +
    `Distrito indicado: *${distrito}*.\n\n` +
    `📌 *Fiscalía sugerida:* ${fiscalia.nombre_fiscalia}\n` +
    `📍 Dirección: ${fiscalia.direccion}\n` +
    `☎️ Teléfono: ${fiscalia.telefono}\n` +
    `🕒 Horario: ${fiscalia.horario}`;

  if (nota) msg += `\n\nℹ️ Nota: ${nota}`;
  return msg;
}

function normalizarRequiereVinculo(v) {
  const t = normalize(v);
  if (!t) return null;
  if (t === 'si' || t === 'sí') return 'SI';
  if (t === 'no') return 'NO';
  if (t === 'depende') return 'DEPENDE';
  return null;
}

// Busca competencia por delito específico (si está disponible)
function findCompetenciaByEspecifico(competencias, delitoEspecifico) {
  const e = normalize(delitoEspecifico);
  if (!e) return null;
  return competencias.find(c => normalize(c.especifico) === e) || null;
}

// ---------------------------
// Motor principal
// ---------------------------
function resolverFiscalia(contexto) {
  const { competencias, reglasCompetencia, distritos, fiscalias, aliasDistritos } = knowledge;

  let materia = contexto.materiaDetectada;         // ej. "Penal", "violencia", "familia", etc.
  const delitoEspecifico = contexto.delitoEspecifico || null;
  const vinculoRespuesta = contexto.vinculoRespuesta || null; // "SI" / "NO" / null

  // ---------------------------
  // Distrito (con alias)
  // ---------------------------
  let distritoTexto = contexto.distritoTexto;

  if (isBlank(distritoTexto)) {
    return {
      status: 'ASK_DISTRITO',
      mensaje: 'Entiendo. Para orientarle correctamente, indíqueme en qué distrito ocurrieron los hechos.'
    };
  }

  const alias = resolverAliasDistrito(aliasDistritos || [], distritoTexto);
  if (alias) distritoTexto = alias;

  const distritoRec = findDistritoRecord(distritos || [], distritoTexto);
  const distritoFinal = distritoRec ? distritoRec.distrito : distritoTexto;

  // ---------------------------
  // PRIORIDAD ABSOLUTA PARA FAMILIA (cuando la materia ya es familia)
  // ---------------------------
  if (normalize(materia) === 'familia' && distritoRec?.fiscalia_familia_codigo) {
    const fiscaliaFam = findFiscaliaByCodigo(fiscalias || [], distritoRec.fiscalia_familia_codigo);
    if (fiscaliaFam) {
      return {
        status: 'OK',
        fiscalia: fiscaliaFam,
        mensaje: formatearRespuestaFiscalia({
          fiscalia: fiscaliaFam,
          materia: 'familia',
          distrito: distritoFinal
        })
      };
    }
  }

  // ---------------------------
  // Decisión de vínculo usando Competencias
  // ---------------------------
  const comp = findCompetenciaByEspecifico(competencias || [], delitoEspecifico);
  const requiere = normalizarRequiereVinculo(
    comp?.['Requiere vinculo familiar'] ?? comp?.requiere_vinculo_familiar ?? comp?.requiereVinculoFamiliar
  );
  const categoriaSiFamiliar =
    comp?.['Categoria_si_familiar'] ?? comp?.categoria_si_familiar ?? comp?.categoriaSiFamiliar ?? null;

  // Si la competencia indica que requiere vínculo o depende, pedirlo SOLO si el distrito cuenta con fiscalía de violencia.
  // Si NO existe fiscalía de violencia en ese distrito, no vale la pena preguntar: se deriva como Penal/Mixta.
  if ((requiere === 'SI' || requiere === 'DEPENDE') && !vinculoRespuesta && tieneFiscaliaViolencia(distritoRec)) {
    return {
      status: 'ASK_VINCULO',
      mensaje:
        'Para orientarle mejor: ¿la persona denunciada es su pareja, expareja o un familiar cercano? Responda solo “sí” o “no”.'
    };
  }

  // Si requería vínculo (SI/DEPENDE) pero el distrito NO tiene fiscalía de violencia, no preguntamos vínculo.
  // En ese escenario se atiende como Penal/Mixta (evita loops y preguntas innecesarias).
  if ((requiere === 'SI' || requiere === 'DEPENDE') && !vinculoRespuesta && !tieneFiscaliaViolencia(distritoRec)) {
    if (normalize(materia) === 'violencia') {
      materia = 'Penal';
    }
  }

  // Si depende, ajustar materia según respuesta
  if (requiere === 'DEPENDE' && vinculoRespuesta) {
    if (vinculoRespuesta === 'SI') {
      // si hay categoría alternativa cuando es familiar, usarla (ej. "violencia")
      if (!isBlank(categoriaSiFamiliar)) {
        materia = categoriaSiFamiliar;
      }
    } else if (vinculoRespuesta === 'NO') {
      // si se marcó como violencia pero NO es familiar, debe ir por Penal
      if (normalize(materia) === 'violencia') {
        materia = 'Penal';
      }
    }
  }

  // Caso defensivo: si la materia es "violencia" pero NO se tiene vínculo y no hay competencia,
  // pedimos vínculo en lugar de asumir (para evitar derivación incorrecta).
  if (normalize(materia) === 'violencia' && !vinculoRespuesta && !comp) {
    return {
      status: 'ASK_VINCULO',
      mensaje:
        'Para orientarle mejor: ¿la persona denunciada es su pareja, expareja o un familiar cercano? Responda solo “sí” o “no”.'
    };
  }

  // ---------------------------
  // Reglas de competencia (materia + distrito / distrito_fiscal)
  // ---------------------------
  let regla = findReglaDistrito(reglasCompetencia || [], materia, distritoFinal);
  if (!regla) regla = findReglaDistritoFiscal(reglasCompetencia || [], materia);
  if (!regla) return { status: 'NO_MATCH' };

  const fiscalia = findFiscaliaByCodigo(fiscalias || [], regla.fiscalia_destino_codigo);
  if (!fiscalia) return { status: 'NO_MATCH' };

  return {
    status: 'OK',
    fiscalia,
    mensaje: formatearRespuestaFiscalia({
      fiscalia,
      materia,
      distrito: distritoFinal,
      nota: regla.observacion_opcional || null
    })
  };
}

module.exports = { resolverFiscalia };
