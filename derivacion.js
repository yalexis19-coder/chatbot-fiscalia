// derivacion.js
// Motor de derivación (Función 1): relato/delito + distrito (+ vínculo si aplica) => fiscalía competente + datos

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

function materiaCanonica(m) {
  const t = normalize(m);
  if (!t) return null;

  const exact = {
    'corrupcion': 'Corrupción',
    'penal': 'Penal',
    'violencia': 'violencia',
    'prevencion': 'Prevencion',
    'familia': 'familia',
    'crimen organizado': 'Crimen Organizado',
    'derechos humanos': 'Derechos Humanos',
    'extincion de dominio': 'Extinción de Dominio',
    'materia ambiental': 'Materia Ambiental'
  };
  if (exact[t]) return exact[t];

  // tolerancia
  if (t.includes('ambient')) return 'Materia Ambiental';
  if (t.includes('corrup')) return 'Corrupción';
  if (t.includes('extinc')) return 'Extinción de Dominio';
  if (t.includes('derech')) return 'Derechos Humanos';
  if (t.includes('crimen') || t.includes('organiza')) return 'Crimen Organizado';
  if (t.includes('prevenc')) return 'Prevencion';
  if (t.includes('violenc')) return 'violencia';
  if (t.includes('famil')) return 'familia';
  if (t.includes('penal')) return 'Penal';

  return null;
}

function findDistritoRecord(distritos, distritoTexto) {
  const d = normalize(distritoTexto);
  if (!d) return null;

  // 1) exacto
  let rec = distritos.find((x) => normalize(x.distrito) === d);
  if (rec) return rec;

  // 2) contiene / variante
  rec = distritos.find((x) => normalize(x.distrito).includes(d) || d.includes(normalize(x.distrito)));
  return rec || null;

function resolverAliasDistrito(aliasDistritos, distritoTexto) {
  const t = normalize(distritoTexto);
  if (!t) return null;
  const hit = aliasDistritos.find(a => normalize(a.alias) === t);
  return hit ? hit.distrito_destino : null;
}

}

function findFiscaliaByCodigo(fiscalias, codigo) {
  const c = normalize(codigo);
  return fiscalias.find((f) => normalize(f.codigo_fiscalia) === c) || null;
}

function findReglaDistrito(reglas, materia, distrito) {
  const m = normalize(materia);
  const d = normalize(distrito);
  return (
    reglas.find(
      (r) =>
        normalize(r.materia) === m &&
        normalize(r.alcance) === normalize('Distrito') &&
        normalize(r.distrito) === d
    ) || null
  );
}

function findReglaDistritoFiscal(reglas, materia) {
  const m = normalize(materia);
  return (
    reglas.find(
      (r) =>
        normalize(r.materia) === m &&
        normalize(r.alcance) === normalize('Distrito Fiscal') &&
        isBlank(r.distrito)
    ) || null
  );
}

function findCompetenciaByEspecifico(competencias, delitoEspecifico) {
  const e = normalize(delitoEspecifico);
  if (!e) return null;
  return competencias.find((c) => normalize(c.especifico) === e) || null;
}

function formatearRespuestaFiscalia({ fiscalia, observacion, materia, distrito }) {
  const lineas = [];

  lineas.push(`Según la información brindada, su caso correspondería a la materia **${materia}**.`);
  lineas.push(`Distrito indicado: **${distrito}**.`);

  if (fiscalia) {
    lineas.push(`\n📌 **Fiscalía sugerida:** ${fiscalia.nombre_fiscalia}`);
    if (fiscalia.direccion) lineas.push(`📍 Dirección: ${fiscalia.direccion}`);
    if (fiscalia.telefono) lineas.push(`☎️ Teléfono: ${fiscalia.telefono}`);
    if (fiscalia.horario) lineas.push(`🕒 Horario: ${fiscalia.horario}`);
  }

  if (observacion && normalize(observacion) !== '') {
    lineas.push(`\nℹ️ Nota: ${observacion}`);
  }

  lineas.push(`\nSi desea, puede contarme un poco más de lo ocurrido para afinar la orientación.`);

  return lineas.join('\n');
}

// ---------------------------
// Motor principal
// ---------------------------
function resolverFiscalia(contexto) {
  const competencias = Array.isArray(knowledge.competencias) ? knowledge.competencias : [];
  const reglas = Array.isArray(knowledge.reglasCompetencia) ? knowledge.reglasCompetencia : [];
  const distritos = Array.isArray(knowledge.distritos) ? knowledge.distritos : [];
  const fiscalias = Array.isArray(knowledge.fiscalias) ? knowledge.fiscalias : [];
  const aliasDistritos = Array.isArray(knowledge.aliasDistritos) ? knowledge.aliasDistritos : [];

  // 1) Materia base (desde IA)
  let materia = materiaCanonica(contexto?.materiaDetectada);

  // 2) Si viene delito específico, afinamos materia + vínculo
  const comp = findCompetenciaByEspecifico(competencias, contexto?.delitoEspecifico);

  let requiereVinculo = null; // 'SI' | 'NO' | 'DEPENDE' | ''
  let categoriaSiFamiliar = null;

  if (comp) {
    if (!materia) materia = materiaCanonica(comp.categoria);
    requiereVinculo = (comp.requiere_vinculo_familiar || '').toString().trim().toUpperCase();
    categoriaSiFamiliar = comp.categoria_si_familiar || null;
  }

  if (!materia) {
    return {
      status: 'ASK_CLARIFY',
      mensaje: 'Para orientarle correctamente, por favor cuénteme brevemente qué ocurrió (o indique el tipo de caso: Penal, violencia, familia, etc.).'
    };
  }

  // 3) Vínculo familiar (solo si DEPENDE)
  if (requiereVinculo === 'DEPENDE') {
    const v = (contexto?.vinculoRespuesta || '').toString().trim().toUpperCase();
    if (v !== 'SI' && v !== 'NO') {
      return {
        status: 'ASK_VINCULO',
        mensaje: '¿La persona denunciada es su pareja, expareja o un familiar cercano? Responda solo **sí** o **no**.'
      };
    }

    if (v === 'SI' && categoriaSiFamiliar) {
      const m2 = materiaCanonica(categoriaSiFamiliar);
      if (m2) materia = m2;
    }
  }

  // 4) Distrito
  const distritoTexto = contexto?.distritoTexto;
  if (!distritoTexto || normalize(distritoTexto) === '') {
    return { status: 'ASK_DISTRITO', mensaje: 'Indíqueme por favor **en qué distrito** ocurrieron los hechos.' };
  }

  let distritoBuscado = distritoTexto;
  const alias = resolverAliasDistrito(aliasDistritos, distritoTexto);
  if (alias) distritoBuscado = alias;

  const distritoRec = findDistritoRecord(distritos, distritoBuscado);
  const distritoFinal = distritoRec?.distrito || distritoBuscado;

  // 5) Priorización (ReglasCompetencia)
  //    Prioridad A: Materia + Alcance=District + distrito exacto
  //    Prioridad B: Materia + Alcance=Distrito Fiscal y distrito vacío
  let regla = findReglaDistrito(reglas, materia, distritoFinal);
  if (!regla) regla = findReglaDistritoFiscal(reglas, materia);

  let codigoFiscalia = regla?.fiscalia_destino_codigo || null;
  let observacion = regla?.observacion_opcional || '';

  // ✅ Prioridad especial para FAMILIA: si el distrito tiene fiscalía de familia definida, usarla
  if (normalize(materia) === normalize('familia') && distritoRec && distritoRec.fiscalia_familia_codigo) {
    const famCode = distritoRec.fiscalia_familia_codigo;
    if (normalize(codigoFiscalia) !== normalize(famCode)) {
      codigoFiscalia = famCode;
      // Mantener la observación si ya existe; si no, agregar una nota breve
      if (isBlank(observacion)) {
        observacion = 'Este distrito es atendido por la Fiscalía de Familia correspondiente.';
      }
    }
  }

  // 6) Fallback por hoja Distritos (si no hay regla)
  if (!codigoFiscalia && distritoRec) {
    const m = normalize(materia);

    if (m === normalize('violencia')) {
      const tiene = normalize(distritoRec.tiene_fiscalia_violencia) === 'si';
      if (tiene && distritoRec.fiscalia_violencia_codigo) codigoFiscalia = distritoRec.fiscalia_violencia_codigo;
      else if (distritoRec.fiscalia_penal_mixta_codigo) codigoFiscalia = distritoRec.fiscalia_penal_mixta_codigo;
    } else if (m === normalize('penal')) {
      if (distritoRec.fiscalia_penal_mixta_codigo) codigoFiscalia = distritoRec.fiscalia_penal_mixta_codigo;
    } else if (m === normalize('familia')) {
      if (distritoRec.fiscalia_familia_codigo) codigoFiscalia = distritoRec.fiscalia_familia_codigo;
      else if (distritoRec.fiscalia_penal_mixta_codigo) codigoFiscalia = distritoRec.fiscalia_penal_mixta_codigo;
    } else if (m === normalize('prevencion')) {
      if (distritoRec.fiscalia_prevencion_codigo) codigoFiscalia = distritoRec.fiscalia_prevencion_codigo;
    }
  }

  const fiscalia = codigoFiscalia ? findFiscaliaByCodigo(fiscalias, codigoFiscalia) : null;

  if (!codigoFiscalia || !fiscalia) {
    return {
      status: 'NO_MATCH',
      mensaje:
        'Por ahora no pude ubicar con precisión la fiscalía competente con los datos brindados. ¿Podría indicar nuevamente el distrito y un resumen breve de lo ocurrido?'
    };
  }

  return {
    status: 'OK',
    codigoFiscalia,
    fiscalia,
    mensaje: formatearRespuestaFiscalia({ fiscalia, observacion, materia, distrito: distritoFinal })
  };
}

module.exports = { resolverFiscalia };