// derivacion.js
// Motor de derivación basado en knowledge.json
// Lógica simple:
// 1) Identificar delito y materia (idealmente desde hoja Competencias vía ia.js).
// 2) Si es violencia, confirmar vínculo si no está definido.
// 3) Si es Penal y Competencias dice DEPENDE, preguntar vínculo; si SI -> Categoria_si_familiar; si NO -> Penal.
// 4) Con materia final + distrito, aplicar ReglasCompetencia.

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

function resolverAliasDistrito(aliasDistritos, texto) {
  const t = normalize(texto);
  if (!t) return null;
  const hit = (aliasDistritos || []).find(a => normalize(a.alias) === t);
  return hit ? hit.distrito_destino : null;
}

function findDistritoRecord(distritos, distritoTexto) {
  const d = normalize(distritoTexto);
  if (!d) return null;
  return (distritos || []).find(x => normalize(x.distrito) === d) || null;
}

function findFiscaliaByCodigo(fiscalias, codigo) {
  const c = normalize(codigo);
  if (!c) return null;
  return (fiscalias || []).find(f => normalize(f.codigo_fiscalia) === c) || null;
}

function findReglaDistrito(reglas, materia, distrito) {
  const m = normalize(materia);
  const d = normalize(distrito);
  return (reglas || []).find(r =>
    normalize(r.materia) === m &&
    esAlcanceDistrito(r.alcance) &&
    normalize(r.distrito) === d
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

function findCompetenciaByEspecifico(competencias, delitoEspecifico) {
  const e = normalize(delitoEspecifico);
  if (!e) return null;
  return (competencias || []).find(c => normalize(c.especifico) === e) || null;
}

function resolverFiscalia(contexto) {
  const { competencias, reglasCompetencia, distritos, fiscalias, aliasDistritos } = knowledge;

  let materia = contexto.materiaDetectada || 'Penal';
  const delitoEspecifico = contexto.delitoEspecifico || null;
  const vinculoRespuesta = contexto.vinculoRespuesta || null;

  // Distrito (con alias)
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

  // Prioridad Familia si ya viene como "familia"
  if (normalize(materia) === 'familia' && distritoRec?.fiscalia_familia_codigo) {
    const fiscaliaFam = findFiscaliaByCodigo(fiscalias, distritoRec.fiscalia_familia_codigo);
    if (fiscaliaFam) {
      return {
        status: 'OK',
        fiscalia: fiscaliaFam,
        mensaje: formatearRespuestaFiscalia({ fiscalia: fiscaliaFam, materia: 'familia', distrito: distritoFinal })
      };
    }
  }

  // Competencia por delito específico (si existe)
  const comp = findCompetenciaByEspecifico(competencias, delitoEspecifico);
  const requiere = normalizarRequiereVinculo(
    comp?.['Requiere vinculo familiar'] ?? comp?.requiere_vinculo_familiar ?? comp?.requiereVinculoFamiliar
  );
  const categoriaSiFamiliar =
    comp?.['Categoria_si_familiar'] ?? comp?.categoria_si_familiar ?? comp?.categoriaSiFamiliar ?? null;

  // Si materia es violencia, confirmar vínculo si falta
  if (normalize(materia) === 'violencia' && !vinculoRespuesta) {
    return {
      status: 'ASK_VINCULO',
      mensaje: 'Para orientarle mejor: ¿la persona denunciada es su pareja, expareja o un familiar cercano? Responda solo “sí” o “no”.'
    };
  }

  // Si Penal pero requiere vínculo depende/si, confirmar vínculo si falta
  if ((requiere === 'SI' || requiere === 'DEPENDE') && !vinculoRespuesta) {
    return {
      status: 'ASK_VINCULO',
      mensaje: 'Para orientarle mejor: ¿la persona denunciada es su pareja, expareja o un familiar cercano? Responda solo “sí” o “no”.'
    };
  }

  // Resolver DEPENDE con respuesta
  if (requiere === 'DEPENDE' && vinculoRespuesta) {
    if (vinculoRespuesta === 'SI' && !isBlank(categoriaSiFamiliar)) materia = categoriaSiFamiliar;
    if (vinculoRespuesta === 'NO') materia = 'Penal';
  }

  // Si era violencia y respondió NO, pasa a Penal
  if (normalize(materia) === 'violencia' && vinculoRespuesta === 'NO') {
    materia = 'Penal';
  }

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
      nota: regla.observacion_opcional || null
    })
  };
}

module.exports = { resolverFiscalia };
