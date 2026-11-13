// Fictional educational material for the messaging laboratory, not commercial offers.
// Asset IDs and filenames are immutable: already-sent messages retain their artwork.
export const demoFlyers = [
  {
    courseId: 'aves',
    brandId: 'globalvet',
    title: 'Plan sanitario para aves',
    price: 379,
    assetId: 'globalvet-aves-v1',
  },
  {
    courseId: 'nutricion',
    brandId: 'globalvet',
    title: 'Nutrición en perros y gatos',
    price: 449,
    assetId: 'globalvet-compania-v1',
    syllabus:
      'Etapas de vida y necesidades generales\nIntroducción a la evaluación nutricional\nBienestar animal y hábitos de alimentación\nCasos de estudio y preguntas',
  },
  {
    courseId: 'odontologia',
    brandId: 'odonteck',
    title: 'Actualización en odontología',
    price: 499,
    assetId: 'odonteck-actualizacion-v1',
  },
  {
    courseId: 'estetica',
    brandId: 'odonteck',
    title: 'Estética dental y fotografía clínica',
    price: 599,
    assetId: 'odonteck-estetica-v1',
    syllabus:
      'Color y composición en fotografía clínica\nPlanificación visual y documentación\nIntroducción a las guías de color\nAnálisis de casos de estudio',
  },
  {
    courseId: 'piel',
    brandId: 'dermalysse',
    title: 'Fundamentos de la piel',
    price: 399,
    assetId: 'dermalysse-piel-v1',
  },
  {
    courseId: 'rutinas',
    brandId: 'dermalysse',
    title: 'Diseño de rutinas de cuidado facial',
    price: 459,
    assetId: 'dermalysse-rituales-v1',
    syllabus:
      'Fundamentos para una rutina consciente\nTexturas y formatos de productos\nOrden de aplicación y hábitos de cuidado\nCasos de estudio y preguntas frecuentes',
  },
];

const assets = new Map(demoFlyers.map(item => [item.assetId, { filename: item.assetId + '.png', mime: 'image/png' }]));
export const artworkAsset = id => assets.get(id) || null;

export function courseArtwork(course) {
  const item = demoFlyers.find(item => item.courseId === course.id);
  // Editing a course invalidates its fixed creative. The current-data flyer takes
  // over automatically, so the catalog never sends an outdated advertised price.
  if (
    !item ||
    course.version !== 1 ||
    course.brand_id !== item.brandId ||
    course.title !== item.title ||
    course.price_cents !== item.price * 100
  )
    return null;
  return item.assetId;
}
