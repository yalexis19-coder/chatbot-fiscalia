// derivacion.js
// Motor de derivación del chatbot institucional
// Usa knowledge.json (generado desde el Excel) para determinar la fiscalía competente.

const path = require('path');
const knowledge = require('./knowledge.json');

// ---------------------------
// Helpers de texto
// ---------------------------

const s = (value) =>
  value === undefined || value === null ? '' : String(value).trim();

const normalize = (str) =>
  s(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------
// Búsqueda de distrito
// ---------------------------

/**
 * Busca distritos que matcheen el texto del usuario.
 * Devuelve:
 *  - { tipo: 'NO_ENCONTRADO' }
 *  - { tipo: 'UNICO', distrito }
 *  - { tipo: 'AMBIGUO', opciones: [distrito, ...] }
 */
function buscarDistritoPorNombre(distritoTexto) {
  const query = normalize(distritoTexto);

  if (!query) {
    return { tipo: 'NO_ENCONTRADO' };
  }

  // Match por nombre de distrito (puede estar "Bambamarca" o "Bambamarca (Hualgayoc)")
  const matches = knowledge.distritos.filter((d) => {
    const nDist = normalize(d.distrito);
    return nDist.includes(query) || query.includes(nDist);
  });

  if (matches.length === 0) {
    return { tipo: 'NO_ENCONTRADO' };
  }

  if (matches.length === 1) {
    return { tipo: 'UNICO', distrito: matches[0] };
  }

  // Más de uno: Bambamarca (Bolívar) / Bambamarca (Hualgayoc), etc.
  return { tipo: 'AMBIGUO', opciones: matches };
}

// ---------------------------
// Búsqueda de fiscalía por código
// ---------------------------

function buscarFiscaliaPorCodigo(codigo) {
  if (!codigo) return null;
  return (
    knowledge.fiscalias.find(
      (f) => normalize(f.codigo_fiscalia) === normalize(codigo)
    ) || null
  );
}

// ---------------------------
// Búsqueda de delito (competencia) por nombre ESPECIFICO
// ---------------------------

/**
 * Busca un delito en la hoja Competencias, por el campo ESPECIFICO.
 * El match es case-insensitive y sin tildes.
 */
function buscarDelitoPorNombre(especificoTexto) {
  const query = normalize(especificoTexto);
  if (!query) return null;

  // 1) Intentar match exacto
  let exactMatches = knowledge.competencias.filter((c) => {
    const nEsp = normalize(c.especifico);
    return nEsp === query;
  });

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  if (exactMatches.length > 1) {
    // Demasiada ambigüedad, no elegimos
    return null;
  }

  // 2) Intentar que el ESPECIFICO contenga al query o viceversa
  let partialMatches = knowledge.competencias.filter((c) => {
    const nEsp = normalize(c.especifico);
    return nEsp.includes(query) || query.includes(nEsp);
  });

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  // Si hay muchas coincidencias (ej. varios tipos de robo), preferimos no inventar
  return null;
}

// ---------------------------
// Determinar materia final
// ---------------------------

/**
 * Determina la materia final del caso.
 *
 * @param {Object} params
 * @param {Object|null} params.delito  - fila de Competencias o null
 * @param {string|null} params.materiaDetectada - materia general detectada por IA ('Penal', 'Prevención', etc.)
 * @param {('SI'|'NO'|'DEPENDE'|null)} params.vinculoRespuesta - respuesta del ciudadano
 *
 * Devuelve:
 *  - { necesitaPreguntaVinculo: true }  (cuando hay que preguntar)
 *  - { materiaFinal: 'Penal' | 'Violencia Familiar' | 'Familia' | ... }
 */
function determinarMateriaFinal({ delito, materiaDetectada, vinculoRespuesta }) {
  // Normalizamos algunos valores
  const materiaIA = s(materiaDetectada);
  const base = delito ? s(delito.categoria) : materiaIA;
  const requiere = delito ? s(delito.requiere_vinculo_familiar).toUpperCase() : '';
  const catSiFamiliar = delito ? s(delito.categoria_si_familiar) : '';

  // Si no tenemos delito ni materia detectada, no podemos seguir
  if (!base) {
    return { materiaFinal: null };
  }

  // Materias que no usan vínculo en absoluto
  const materiasSinVinculo = [
    'MATERIA AMBIENTAL',
    'AMBIENTAL',
    'CORRUPCION',
    'CORRUPCIÓN',
    'CRIMEN ORGANIZADO',
    'EXTINCION DE DOMINIO',
    'EXTINCIÓN DE DOMINIO',
    'DERECHOS HUMANOS',
    'PREVENCION',
    'PREVENCIÓN',
    'FAMILIA'
  ];

  if (materiasSinVinculo.includes(base.toUpperCase())) {
    return { materiaFinal: normalizarNombreMateria(base) };
  }

  // Si ya es violencia familiar, no hay nada que preguntar
  if (base.toUpperCase() === 'VIOLENCIA FAMILIAR') {
    return { materiaFinal: 'Violencia Familiar' };
  }

  // Casos SIN dependencia de vínculo (Penal siempre)
  if (requiere === 'NO' || requiere === '') {
    return { materiaFinal: normalizarNombreMateria(base) };
  }

  // Casos que siempre requieren vínculo, pero ya son VF u otra materia
  if (requiere === 'SI') {
    if (catSiFamiliar) {
      return { materiaFinal: normalizarNombreMateria(catSiFamiliar) };
    }
    return { materiaFinal: normalizarNombreMateria(base) };
  }

  // Casos DEPENDE → hay que preguntar si no tenemos respuesta
  if (requiere === 'DEPENDE') {
    if (!vinculoRespuesta) {
      return { necesitaPreguntaVinculo: true };
    }

    const resp = s(vinculoRespuesta).toUpperCase();
    if (resp === 'SI') {
      // Pasamos a la categoría si familiar, ej. Violencia Familiar
      return {
        materiaFinal: normalizarNombreMateria(catSiFamiliar || base)
      };
    } else {
      // NO → se queda como base (normalmente Penal)
      return { materiaFinal: normalizarNombreMateria(base) };
    }
  }

  // Default
  return { materiaFinal: normalizarNombreMateria(base) };
}

function normalizarNombreMateria(m) {
  const t = s(m).toLowerCase();
  if (t.includes('penal')) return 'Penal';
  if (t.includes('violencia')) return 'Violencia Familiar';
  if (t.includes('familia')) return 'Familia';
  if (t.includes('ambient')) return 'Materia Ambiental';
  if (t.includes('corrup')) return 'Corrupción';
  if (t.includes('crimen')) return 'Crimen Organizado';
  if (t.includes('extinc')) return 'Extinción de Dominio';
  if (t.includes('derechos')) return 'Derechos Humanos';
  if (t.includes('prevenc')) return 'Prevención';
  return s(m);
}

// ---------------------------
// Búsqueda de regla de competencia
// ---------------------------

/**
 * Busca una regla de competencia según materia y distrito.
 *
 * 1. Primero intenta match específico materia + distrito (alcance = 'distrito')
 * 2. Luego prueba regla general por distrito fiscal (alcance = 'distrito_fiscal')
 */
function buscarReglaCompetencia(materiaFinal, nombreDistrito) {
  const mat = normalizarNombreMateria(materiaFinal);
  const distNorm = normalize(nombreDistrito);

  // 1) Reglas por distrito
  const reglasDistrito = knowledge.reglasCompetencia.filter((r) => {
    return (
      normalizarNombreMateria(r.materia) === mat &&
      s(r.alcance).toLowerCase() === 'distrito' &&
      normalize(r.distrito) === distNorm
    );
  });

  if (reglasDistrito.length > 0) {
    return reglasDistrito[0];
  }

  // 2) Reglas por distrito_fiscal
  const reglasDF = knowledge.reglasCompetencia.filter((r) => {
    return (
      normalizarNombreMateria(r.materia) === mat &&
      s(r.alcance).toLowerCase() === 'distrito_fiscal'
    );
  });

  if (reglasDF.length > 0) {
    return reglasDF[0];
  }

  return null;
}

// ---------------------------
// Respuesta orientadora
// ---------------------------

function armarRespuestaOrientadora({ materiaFinal, delito, distrito, fiscalia, observacion }) {
  const nombreDelito = delito ? s(delito.especifico) : '';
  const descDelito = delito ? s(delito.descripcion) : '';

  let textoDelito = '';
  if (nombreDelito) {
    textoDelito =
      `Por lo que usted relata, podría tratarse de un hecho vinculado al delito de ${nombreDelito}. `;

    if (descDelito) {
      textoDelito += descDelito + ' ';
    }
  }

  let textoFiscalia = '';
  if (fiscalia) {
    textoFiscalia =
      `Puede presentar su denuncia en la ${fiscalia.nombre_fiscalia}, ` +
      `ubicada en ${fiscalia.direccion}. `;

    if (fiscalia.telefono) {
      textoFiscalia += `Teléfono: ${fiscalia.telefono}. `;
    }
    if (fiscalia.horario) {
      textoFiscalia += `Horario de atención: ${fiscalia.horario}. `;
    }
  }

  const textoObs = observacion ? observacion + ' ' : '';

  const textoDistrito = distrito
    ? `Esta orientación se brinda para hechos ocurridos en el distrito de ${distrito.distrito}, provincia de ${distrito.provincia}. `
    : '';

  const mensaje =
    textoDelito + textoDistrito + textoFiscalia + textoObs;

  return mensaje.trim();
}

// ---------------------------
// Función principal: resolverFiscalia
// ---------------------------

/**
 * Función principal que usará ia.js
 *
 * @param {Object} params
 * @param {string} params.distritoTexto          - texto del usuario sobre el distrito ("Cajamarca", "Bambamarca", etc.)
 * @param {string|null} params.delitoEspecifico  - nombre del delito específico (ESPECIFICO en Competencias)
 * @param {string|null} params.materiaDetectada  - materia general detectada por la IA (opcional)
 * @param {('SI'|'NO'|null)} params.vinculoRespuesta - respuesta del usuario sobre vínculo familiar
 *
 * Devuelve un objeto:
 *  - { status: 'OK', mensaje, materiaFinal, fiscalia, distrito, delito }
 *  - { status: 'ASK_DISTRITO', mensaje }
 *  - { status: 'ASK_DISTRITO_AMBIGUO', mensaje, opciones: [...] }
 *  - { status: 'ASK_VINCULO', mensaje }
 *  - { status: 'ERROR', mensaje }
 */
function resolverFiscalia({ distritoTexto, delitoEspecifico, materiaDetectada, vinculoRespuesta }) {
  // 1) Buscar distrito
  const resDistrito = buscarDistritoPorNombre(distritoTexto || '');

  if (resDistrito.tipo === 'NO_ENCONTRADO') {
    return {
      status: 'ASK_DISTRITO',
      mensaje: 'Por favor, indíqueme en qué distrito ocurrieron los hechos (por ejemplo: Cajamarca, Baños del Inca, La Encañada).'
    };
  }

  if (resDistrito.tipo === 'AMBIGUO') {
    const opciones = resDistrito.opciones.map((d) => ({
      etiqueta: `${d.distrito} (Provincia ${d.provincia})`,
      distrito: d.distrito,
      provincia: d.provincia
    }));

    const listado = opciones
      .map((o, idx) => `${idx + 1}. ${o.etiqueta}`)
      .join('\n');

    return {
      status: 'ASK_DISTRITO_AMBIGUO',
      mensaje:
        'En el Distrito Fiscal de Cajamarca existen varios distritos con un nombre similar. ' +
        'Por favor, indíqueme a cuál se refiere:\n' +
        listado,
      opciones
    };
  }

  const distrito = resDistrito.distrito;

  // 2) Buscar delito (fila de Competencias), si se proporcionó
  let delito = null;
  if (delitoEspecifico) {
    delito = buscarDelitoPorNombre(delitoEspecifico);
  }

  // 3) Determinar materia final
  const resMateria = determinarMateriaFinal({
    delito,
    materiaDetectada,
    vinculoRespuesta
  });

  if (resMateria.necesitaPreguntaVinculo) {
    return {
      status: 'ASK_VINCULO',
      mensaje:
        'Para orientarle mejor, ¿la persona agresora es parte de su grupo familiar ' +
        '(pareja, ex pareja, conviviente, padre, madre, hijo/a u otro integrante del hogar)? ' +
        'Responda "sí" o "no", por favor.'
    };
  }

  const materiaFinal = resMateria.materiaFinal;

  if (!materiaFinal) {
    return {
      status: 'ERROR',
      mensaje:
        'No pude determinar la materia del caso con la información disponible. ' +
        'Por favor, describa nuevamente los hechos con el mayor detalle posible.'
    };
  }

  // 4) Buscar regla de competencia
  const regla = buscarReglaCompetencia(materiaFinal, distrito.distrito);

  let codigoFiscalia = null;
  let observacion = null;

  if (regla) {
    codigoFiscalia = regla.fiscalia_destino_codigo;
    observacion = s(regla.observacion_opcional);
  } else {
    // Fallback seguro: usamos datos de la hoja Distritos
    const mat = materiaFinal;

    if (mat === 'Penal') {
      codigoFiscalia = distrito.fiscalia_penal_mixta_codigo;
    } else if (mat === 'Familia') {
      codigoFiscalia = distrito.fiscalia_familia_codigo || distrito.fiscalia_penal_mixta_codigo;
    } else if (mat === 'Prevención') {
      codigoFiscalia =
        distrito.fiscalia_prevencion_codigo || distrito.fiscalia_penal_mixta_codigo;
    } else if (mat === 'Violencia Familiar') {
      if (distrito.fiscalia_violencia_codigo) {
        codigoFiscalia = distrito.fiscalia_violencia_codigo;
      } else {
        codigoFiscalia = distrito.fiscalia_penal_mixta_codigo;
      }
    } else {
      // materias especializadas sin regla → derivar a penal/mixta y que se derive internamente
      codigoFiscalia = distrito.fiscalia_penal_mixta_codigo;
      observacion =
        observacion ||
        'Si el hecho corresponde a una materia especializada, la Fiscalía de su distrito derivará la denuncia a la Fiscalía competente.';
    }
  }

  const fiscalia = buscarFiscaliaPorCodigo(codigoFiscalia);

  // 5) Armar mensaje orientador
  const mensaje = armarRespuestaOrientadora({
    materiaFinal,
    delito,
    distrito,
    fiscalia,
    observacion
  });

  return {
    status: 'OK',
    mensaje,
    materiaFinal,
    fiscalia,
    distrito,
    delito
  };
}

// ---------------------------
// Exportar funciones
// ---------------------------

module.exports = {
  resolverFiscalia,
  buscarDistritoPorNombre,
  determinarMateriaFinal,
  buscarReglaCompetencia
};
