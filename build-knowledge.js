// build-knowledge.js
// Convierte el Excel institucional a knowledge.json para el chatbot

const fs = require('fs');
const XLSX = require('xlsx');

// 🔁 Cambia esto por la ruta real de tu Excel
const EXCEL_FILE = './mp_cajamarca_chatbot.xlsx';
const OUTPUT_FILE = './knowledge.json';

// Utilidad: normalizar strings (trim + manejar undefined)
const s = (value) => (value === undefined || value === null ? '' : String(value).trim());

// Utilidad: crear un id único para el distrito (provincia + distrito, en minúsculas y sin tildes)
const slug = (str) => {
  return s(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // espacios y raros → _
    .replace(/^_+|_+$/g, '');
};

console.log('Leyendo Excel:', EXCEL_FILE);
const workbook = XLSX.readFile(EXCEL_FILE);

// Helper genérico: hoja → array de objetos
const sheetToJson = (sheetName) => {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.warn(`⚠️  Hoja "${sheetName}" no encontrada en el Excel.`);
    return [];
  }
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
};

// 1) Distritos
const distritosRaw = sheetToJson('Distritos');
const distritos = distritosRaw.map((row) => {
  const provincia = s(row['Provincia']);
  const distrito = s(row['Distrito']);

  return {
    provincia,
    distrito,
    distrito_id: slug(provincia + '_' + distrito), // lo usaremos luego en el motor
    tiene_fiscalia_violencia: s(row['Tiene fiscalia violencia']),
    fiscalia_violencia_codigo: s(row['fiscalia_violencia_codigo']),
    fiscalia_penal_mixta_codigo: s(row['fiscalia_penal_mixta_codigo']),
    // si añadiste estos campos:
    fiscalia_prevencion_codigo: s(row['fiscalia_prevencion_codigo']),
    fiscalia_familia_codigo: s(row['fiscalia_familia_codigo'])
  };
});

// 2) Fiscalias
const fiscaliasRaw = sheetToJson('Fiscalias');
const fiscalias = fiscaliasRaw.map((row) => {
  // competencias puede venir como "Penal, Violencia, Prevención"
  const competenciasText = s(row['competencias']);
  const competenciasArray = competenciasText
    ? competenciasText.split(',').map((x) => x.trim()).filter(Boolean)
    : [];

  return {
    codigo_fiscalia: s(row['codigo_fiscalia']),
    nombre_fiscalia: s(row['nombre_fiscalia']),
    tipo: s(row['tipo']),
    distrito_fiscal: s(row['distrito_fiscal']),
    direccion: s(row['direccion']),
    telefono: s(row['telefono']),
    horario: s(row['horario']),
    competencias: competenciasArray
  };
});

// 3) Competencias (delitos)
const competenciasRaw = sheetToJson('Competencias');
const competencias = competenciasRaw.map((row) => ({
  categoria: s(row['CATEGORIA']),
  generico: s(row['GENERICO']),
  subgenerico: s(row['SUBGENERICO']),
  especifico: s(row['ESPECIFICO']),
  descripcion: s(row['DESCRIPCION']),
  requiere_vinculo_familiar: s(row['Requiere vinculo familiar']),
  categoria_si_familiar: s(row['Categoria_si_familiar'])
}));

// 4) Reglas de competencia
const reglasRaw = sheetToJson('ReglasCompetencia');
const reglasCompetencia = reglasRaw.map((row) => ({
  materia: s(row['materia']),
  alcance: s(row['alcance']), // 'distrito' o 'distrito_fiscal'
  distrito: s(row['distrito']), // vacío si alcance = distrito_fiscal
  observacion_opcional: s(row['observacion_opcional']),
  fiscalia_destino_codigo: s(row['fiscalia_destino_codigo'])
}));

// 5) Procedimientos
const procedimientosRaw = sheetToJson('Procedimientos');
const procedimientos = procedimientosRaw.map((row) => ({
  tramite: s(row['tramite']),
  pasos: s(row['pasos']),
  requisitos: s(row['requisitos']),
  observaciones: s(row['observaciones'])
}));

// 6) FAQ
const faqRaw = sheetToJson('FAQ');
const faq = faqRaw.map((row) => ({
  pregunta: s(row['pregunta']),
  respuesta: s(row['respuesta'])
}));

// 7) Contactos
const contactosRaw = sheetToJson('Contacto');
const contactos = contactosRaw.map((row) => ({
  entidad: s(row['entidad']),
  direccion: s(row['direccion']),
  telefono: s(row['telefono']),
  correo: s(row['correo'])
}));

// Construir objeto final
const knowledge = {
  distritos,
  fiscalias,
  competencias,
  reglasCompetencia,
  procedimientos,
  faq,
  contactos
};

// Guardar JSON con formato bonito
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(knowledge, null, 2), 'utf8');
console.log('✅ knowledge.json generado en:', OUTPUT_FILE);