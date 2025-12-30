
// derivacion.js
// Motor de derivación con:
// - AliasDistritos
// - Soporte alcance distrito / distrito_fiscal
// - Prioridad absoluta para FAMILIA

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
  return v === 'distrito fiscal';
}

function findDistritoRecord(distritos, distritoTexto) {
  const d = normalize(distritoTexto);
  if (!d) return null;
  return distritos.find(x => normalize(x.distrito) === d) || null;
}

function resolverAliasDistrito(aliasDistritos, texto) {
  const t = normalize(texto);
  if (!t) return null;
  const hit = aliasDistritos.find(a => normalize(a.alias) === t);
  return hit ? hit.distrito_destino : null;
}

function findFiscaliaByCodigo(fiscalias, codigo) {
  const c = normalize(codigo);
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

function formatearRespuestaFiscalia({ fiscalia, materia, distrito }) {
  return (
    `Según la información brindada, su caso correspondería a la materia *${materia}*.
` +
    `Distrito indicado: *${distrito}*.

` +
    `📌 *Fiscalía sugerida:* ${fiscalia.nombre_fiscalia}
` +
    `📍 Dirección: ${fiscalia.direccion}
` +
    `☎️ Teléfono: ${fiscalia.telefono}
` +
    `🕒 Horario: ${fiscalia.horario}`
  );
}

// ---------------------------
// Motor principal
// ---------------------------
function resolverFiscalia(contexto) {
  const { competencias, reglasCompetencia, distritos, fiscalias, aliasDistritos } = knowledge;

  let materia = contexto.materiaDetectada;

  // Resolver alias de distrito
  let distritoTexto = contexto.distritoTexto;
  const alias = resolverAliasDistrito(aliasDistritos || [], distritoTexto);
  if (alias) distritoTexto = alias;

  const distritoRec = findDistritoRecord(distritos, distritoTexto);
  const distritoFinal = distritoRec ? distritoRec.distrito : distritoTexto;

  // PRIORIDAD ABSOLUTA PARA FAMILIA
  if (materia === 'familia' && distritoRec?.fiscalia_familia_codigo) {
    const fiscaliaFam = findFiscaliaByCodigo(
      fiscalias,
      distritoRec.fiscalia_familia_codigo
    );
    if (fiscaliaFam) {
      return {
        status: 'OK',
        fiscalia: fiscaliaFam,
        mensaje: formatearRespuestaFiscalia({
          fiscalia: fiscaliaFam,
          materia,
          distrito: distritoFinal
        })
      };
    }
  }

  // Reglas de competencia
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
      distrito: distritoFinal
    })
  };
}

module.exports = { resolverFiscalia };
