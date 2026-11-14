// Datos inventados para la página de demostración del lienzo (demo.html) y para las pruebas del simulador.
// La pantalla real nunca usa este archivo: recibe el catálogo, los materiales y las listas de la marca desde la API.
// Los nombres, precios y fechas son de ejemplo y no corresponden a ningún curso real.

export const DEMO_CATALOGUE = Object.freeze({
  brand: { name: 'Academia de ejemplo' },
  // Persona con la que se prueba el recorrido.
  contact: { name: 'María López', attributes: { ciudad: 'Puebla' }, tags: [] },
  courses: [
    {
      id: 'curso-aves',
      title: 'Medicina de aves de compañía',
      syllabus: 'Anatomía y fisiología\nManejo y contención\nEnfermedades frecuentes\nCasos clínicos',
      highlights: 'Constancia digital\nGrabaciones por 30 días',
      duration: '5 horas',
      edition: {
        id: 'ed-aves-enero',
        name: 'Enero 2027',
        starts: 'martes, 12 de enero de 2027, 7:00 p.m.',
        instructor: 'MVZ Ana Rivera',
        modality: 'En línea',
        price: '$1,200.00 MXN',
        regularPrice: '$1,500.00 MXN',
        promotion: 'Inscripción anticipada',
        validUntil: '20 de diciembre',
        validShort: '20 dic',
        saving: '$300.00 MXN',
        seats: 12,
        sessions: ['Martes 12 de enero, 7:00 p.m.', 'Jueves 14 de enero, 7:00 p.m.'],
        link: 'https://ejemplo.mx/cursos/aves',
        available: true,
        saleEnabled: true,
      },
    },
    {
      // Con la venta en línea apagada: la inscripción sale por «Pago manual».
      id: 'curso-reptiles',
      title: 'Clínica de reptiles',
      syllabus: 'Especies frecuentes en consulta\nAlojamiento y temperatura\nNutrición\nUrgencias',
      highlights: 'Constancia digital',
      duration: '4 horas',
      edition: {
        id: 'ed-reptiles-febrero',
        name: 'Febrero 2027',
        starts: 'sábado, 6 de febrero de 2027, 10:00 a.m.',
        instructor: 'MVZ Luis Ortega',
        modality: 'Presencial',
        location: 'Puebla',
        price: '$1,800.00 MXN',
        regularPrice: '$1,800.00 MXN',
        seats: 4,
        sessions: ['Sábado 6 de febrero, 10:00 a.m.'],
        link: 'https://ejemplo.mx/cursos/reptiles',
        available: true,
        saleEnabled: false,
      },
    },
    {
      // Sin edición disponible: los pasos de catálogo salen por «No disponible».
      id: 'curso-nutricion',
      title: 'Nutrición de pequeñas especies',
      syllabus: 'Requerimientos por etapa\nDietas comerciales y caseras',
      highlights: '',
      duration: '3 horas',
      edition: { id: 'ed-nutricion', name: 'Por confirmar', available: false },
    },
  ],
  materials: [
    {
      id: 'mat-presentacion',
      name: 'Presentación de la marca',
      status: 'approved',
      slot: 'presentacion',
      text: 'Soy tu asesora académica de {{marca}}. Te comparto la información de {{curso}}.',
    },
    {
      id: 'mat-temario-aves',
      name: 'Imagen del temario · Aves',
      status: 'approved',
      slot: 'temario_imagen',
      courseId: 'curso-aves',
      media: 'temario-aves.png',
      text: '',
    },
    {
      id: 'mat-precio',
      name: 'Precio promocional vigente',
      status: 'approved',
      text: 'Precio promocional de {{curso}}: {{precio}} (precio regular: {{precio_regular}}). Vigente hasta el {{vigencia}}.',
    },
    {
      id: 'mat-pago',
      name: 'Instrucciones de pago',
      status: 'approved',
      slot: 'instrucciones_pago',
      text: 'Puedes pagar por transferencia o depósito. Te comparto los datos de la cuenta; al terminar, envíame tu comprobante por este chat.',
    },
    { id: 'mat-borrador', name: 'Aviso en borrador', status: 'draft', text: 'Texto pendiente de aprobar.' },
  ],
  files: [{ id: 'archivo-cuentas', name: 'cuentas.png' }],
  tags: [
    { id: 'etiqueta-interesado', name: 'Interesado' },
    { id: 'etiqueta-pago', name: 'Pagó' },
  ],
  waTemplates: [
    {
      id: 'plantilla-oferta',
      name: 'oferta_curso',
      status: 'approved',
      text: 'Hola, {{nombre}}. Tenemos una promoción en {{curso}}.',
      buttons: ['Sí, deseo inscribirme', 'Ahora no'],
    },
  ],
  flows: [
    { id: 'recorrido-inscripcion', name: 'Inscripción', published: true },
    { id: 'recorrido-bienvenida', name: 'Bienvenida con menú', published: false },
  ],
  users: [{ id: 'usuario-ana', name: 'Ana (asesora)', active: true }],
  attributes: [
    { key: 'ciudad', label: 'Ciudad', type: 'text', status: 'active' },
    { key: 'nombre_constancia', label: 'Nombre para la constancia', type: 'text', status: 'active' },
  ],
});

// Cifras de ejemplo para la capa «Rendimiento», con la forma que devuelve la analítica del servidor por paso:
// {nodes: {<id>: {entered, completed, dropped, left?, ports?: {<salida>: n}}}}. Corresponden a la plantilla «Venta de curso».
export const DEMO_STATS = Object.freeze({
  nodes: {
    s: { entered: 26, completed: 26, dropped: 0 },
    c: { entered: 26, completed: 24, dropped: 1, ports: { next: 24, none: 1 } },
    m1: { entered: 24, completed: 24, dropped: 0 },
    d1: { entered: 24, completed: 24, dropped: 0 },
    f: { entered: 24, completed: 24, dropped: 0 },
    m2: { entered: 24, completed: 24, dropped: 0 },
    d2: { entered: 24, completed: 24, dropped: 0 },
    b: { entered: 24, completed: 6, dropped: 14, left: 4, ports: { 'opt:si': 6, timeout: 14 } },
    g: { entered: 6, completed: 6, dropped: 0 },
    h: { entered: 1, completed: 1, dropped: 0 },
    e: { entered: 14, completed: 14, dropped: 0 },
  },
});
