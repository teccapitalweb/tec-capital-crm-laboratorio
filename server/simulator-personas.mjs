// Guiones del simulador de clientes. Cada perfil es una lista de pasos: `say` (variantes de texto; se elige una al azar),
// `wait` ('reply': cualquier respuesta automática o humana; 'human': sólo una persona), `patience` (en unidades del
// ritmo elegido), `onHuman` (lo que contesta si una persona responde) y `onTimeout:'finish'` para pasos de silencio.
// Los textos están pensados para ejercitar intenciones concretas del motor de respuestas (precio, temario, fecha,
// inscripción, pago, queja, baja, preguntas fuera de guion). No contienen datos reales.
export const PERSONAS = {
  curioso: {
    label: 'Curioso',
    description: 'Pide información, temario y fecha; se despide sin decidir.',
    outcome: 'informado',
    steps: [
      {
        say: [
          'Hola, me interesa {{curso}}. ¿Me pueden dar información?',
          'Buenas tardes, vi el anuncio de {{curso}} y quiero saber más.',
          'Hola, ¿me comparten info de {{curso}}?',
        ],
        wait: 'reply',
      },
      {
        say: ['¿Qué temas incluye el curso?', '¿Me pasan el temario?', '¿Qué voy a aprender exactamente?'],
        wait: 'reply',
      },
      { say: ['¿Y cuándo empieza?', '¿Qué fecha y horario tiene?', '¿Cuándo inicia la próxima fecha?'], wait: 'reply' },
      {
        say: [
          'Gracias, lo voy a pensar y les aviso.',
          'Perfecto, gracias por la información.',
          'Ok, gracias. Lo platico en casa y les escribo.',
        ],
      },
    ],
  },
  precio: {
    label: 'Sensible al precio',
    description: 'Pregunta costo, promociones y pago en partes; queda indeciso.',
    outcome: 'indeciso_precio',
    steps: [
      {
        say: [
          'Hola, ¿cuánto cuesta {{curso}}?',
          'Buen día, ¿qué precio tiene {{curso}}?',
          'Hola, me interesa {{curso}}, ¿cuál es el costo?',
        ],
        wait: 'reply',
      },
      {
        say: ['¿Tienen alguna promoción o descuento?', '¿Hay promoción si pago antes?', '¿Manejan algún descuento?'],
        wait: 'reply',
      },
      {
        say: [
          'Está un poco caro para mí. ¿Aceptan meses sin intereses o pago en partes?',
          '¿Se puede pagar en dos partes con tarjeta?',
          '¿Aceptan pago con tarjeta a meses sin intereses?',
        ],
        wait: 'reply',
      },
      { say: ['Gracias, lo pienso y les escribo.', 'Ok, gracias. Déjame revisar mi presupuesto.'] },
    ],
  },
  listo: {
    label: 'Listo para inscribirse',
    description: 'Quiere inscribirse, pregunta cómo pagar y avisa que ya pagó: una persona debe validar.',
    outcome: 'inscripcion_en_validacion',
    steps: [
      {
        say: [
          'Hola, quiero inscribirme a {{curso}}. ¿Cómo le hago?',
          'Buenas, me quiero registrar en {{curso}}.',
          'Hola, ya decidí: quiero el curso {{curso}}. ¿Cómo me inscribo?',
        ],
        wait: 'reply',
      },
      {
        say: ['Perfecto. ¿Cómo puedo pagar?', '¿Qué formas de pago manejan?', '¿Aceptan pago con tarjeta u OXXO?'],
        wait: 'reply',
      },
      {
        say: [
          'Listo, ya hice la transferencia. ¿A dónde envío el comprobante?',
          'Ya pagué, les mando el comprobante en un momento.',
          'Acabo de depositar, ¿me confirman que llegó mi pago?',
        ],
        wait: 'human',
        onHuman: ['¡Gracias! Quedo al pendiente de la confirmación.', 'Perfecto, muchas gracias por confirmar.'],
      },
    ],
  },
  pagador: {
    label: 'Paga en línea',
    description:
      'Pide inscribirse y, si la marca tiene la venta activa, paga con tarjeta simulada desde el enlace; si no hay pedido, pide el enlace a una persona.',
    outcome: 'escalado_a_persona',
    steps: [
      {
        say: [
          'Hola, quiero inscribirme a {{curso}}. ¿Me pasan el enlace de pago?',
          'Buenas, ya decidí tomar {{curso}}. ¿Cómo me inscribo y pago?',
        ],
        wait: 'reply',
      },
      {
        pay: 'card',
        say: ['¿Me pueden enviar el enlace de pago, por favor?', 'Quedo pendiente del enlace para pagar.'],
        wait: 'human',
        onHuman: ['Gracias, en cuanto llegue el enlace pago.'],
      },
    ],
  },
  molesto: {
    label: 'Molesto',
    description: 'Pagó y nadie le responde; amenaza con pedir reembolso. Siempre lo atiende una persona.',
    outcome: 'queja_atendida',
    steps: [
      {
        say: [
          'Hola. Pagué hace una semana y nadie me ha respondido. ¿Qué pasó con mi lugar?',
          'Llevo días esperando respuesta después de que pagué. Esto no es serio.',
          'Ya pagué y nadie me confirma nada, ¿me pueden atender?',
        ],
        wait: 'reply',
      },
      {
        say: [
          'Esto es pésimo. Si no me responden hoy, quiero un reembolso.',
          'Quiero mi reembolso, no me parece su atención.',
          'Si no hay respuesta pido la devolución de mi dinero.',
        ],
        wait: 'human',
        onHuman: [
          'Está bien, gracias por atenderme. Espero su respuesta hoy mismo.',
          'Ok. Quedo al pendiente, por favor no lo olviden.',
        ],
      },
    ],
  },
  baja: {
    label: 'Pide la baja',
    description: 'Pregunta algo y luego pide no recibir más mensajes: queda registrado el consentimiento.',
    outcome: 'baja',
    steps: [
      { say: ['Hola, ¿todavía tienen el curso {{curso}}?', 'Hola, recibí su mensaje sobre {{curso}}.'], wait: 'reply' },
      {
        say: [
          'Gracias, pero ya no me interesa. Por favor no me envíen más mensajes.',
          'Ya no quiero recibir mensajes, gracias.',
          'Dame de baja por favor.',
        ],
      },
    ],
  },
  dudas: {
    label: 'Con dudas',
    description: 'Certificado, grabaciones y requisitos: se responde con el conocimiento aprobado.',
    outcome: 'informado',
    steps: [
      {
        say: ['Hola, ¿el curso {{curso}} entrega certificado?', '¿{{curso}} tiene constancia o diploma al terminar?'],
        wait: 'reply',
      },
      { say: ['¿Y si no puedo asistir a una clase, queda grabada?', '¿Las sesiones quedan grabadas?'], wait: 'reply' },
      { say: ['¿Necesito conocimientos previos?', '¿Qué requisitos piden para tomarlo?'], wait: 'reply' },
      { say: ['Perfecto, gracias. Lo pienso y les aviso.'] },
    ],
  },
  desconocido: {
    label: 'Pregunta fuera de guion',
    description:
      'Hace preguntas que el motor no reconoce; el asistente le propone una persona y, cuando acepta, pasa a un asesor.',
    outcome: 'escalado_a_persona',
    steps: [
      { say: ['Hola, buenas tardes.', 'Hola, ¿me pueden ayudar?'], wait: 'reply' },
      {
        say: [
          '¿Dan beca o apoyo para estudiantes de provincia?',
          '¿Tienen convenio con universidades para dar créditos?',
        ],
        wait: 'reply',
      },
      {
        say: [
          '¿Y hacen cursos a la medida para equipos de trabajo?',
          '¿Pueden impartirlo dentro de mi empresa para varios compañeros?',
        ],
        wait: 'reply',
      },
      {
        say: ['Sí, con un asesor por favor.', 'Sí, prefiero que me atienda una persona.'],
        wait: 'human',
        onHuman: ['Gracias, me interesa esa opción. ¿Me pueden enviar una propuesta?'],
      },
    ],
  },
  silencio: {
    label: 'Se queda en silencio',
    description: 'Saluda y deja de responder; si una receta de seguimiento lo reactiva, retoma la plática.',
    outcome: 'silencio',
    steps: [
      { say: ['Hola, me interesa {{curso}}.', 'Hola, quiero información de {{curso}}.'], wait: 'reply' },
      { wait: 'reply', patience: 20, onTimeout: 'finish' },
      {
        say: [
          'Perdón, se me pasó responder. ¿Sigue disponible la próxima fecha?',
          'Disculpen la tardanza, ¿todavía puedo entrar a la siguiente fecha?',
        ],
        wait: 'reply',
      },
      { say: ['Gracias, lo reviso y les confirmo.'] },
    ],
    reactivated: 'reactivado',
  },
};
export const OUTCOMES = {
  informado: 'Informado',
  indeciso_precio: 'Indeciso por precio',
  inscripcion_en_validacion: 'Inscripción en validación',
  queja_atendida: 'Queja atendida',
  baja: 'Pidió la baja',
  escalado_a_persona: 'Escalado a una persona',
  silencio: 'Se quedó en silencio',
  reactivado: 'Reactivado por seguimiento',
  pagado: 'Pagó en línea (simulado)',
  cerrada_por_equipo: 'El equipo cerró el chat',
};

// Ritmo: `base` es la pausa típica (ms) entre mensajes de un mismo cliente; las esperas y la paciencia se miden en múltiplos.
export const PACES = {
  rapida: { label: 'Rápida · segundos', base: 1500 },
  normal: { label: 'Normal · unos 10 s', base: 8000 },
  lenta: { label: 'Lenta · como una persona real', base: 40000 },
};

export const FIRST_NAMES = [
  'Ana',
  'Luis',
  'María',
  'Carlos',
  'Fernanda',
  'Jorge',
  'Lucía',
  'Miguel',
  'Sofía',
  'Andrés',
  'Valeria',
  'Diego',
  'Paola',
  'Ricardo',
  'Daniela',
  'Héctor',
  'Mariana',
  'Rodrigo',
  'Gabriela',
  'Emilio',
  'Renata',
  'Alejandro',
  'Ximena',
  'Iván',
];
export const LAST_NAMES = [
  'Robles',
  'Hernández',
  'García',
  'Martínez',
  'López',
  'Ramírez',
  'Torres',
  'Flores',
  'Castillo',
  'Morales',
  'Jiménez',
  'Vargas',
  'Mendoza',
  'Ortiz',
  'Reyes',
  'Cruz',
  'Navarro',
  'Salazar',
  'Delgado',
  'Aguilar',
];
export const INSTRUCTORS = [
  'Dra. Laura Méndez',
  'Dr. Tomás Villanueva',
  'Mtra. Claudia Rangel',
  'Dr. Sergio Padilla',
  'Mtra. Elena Quiroz',
  'Dr. Óscar Benítez',
  'Dra. Patricia Lugo',
  'Mtro. Javier Soto',
];

// Catálogo de demostración: 15 marcas (las tres primeras ya existen en la base inicial) con ocho cursos cada una.
// Nombres ficticios salvo las tres demo; la empresa puede renombrarlos desde el catálogo.
export const DEMO_BRANDS = [
  {
    name: 'GlobalVet',
    description: 'Capacitación veterinaria',
    base: 1890,
    courses: [
      'Plan sanitario para aves',
      'Urgencias en pequeñas especies',
      'Anestesia y analgesia veterinaria',
      'Nutrición clínica canina y felina',
      'Dermatología veterinaria práctica',
      'Reproducción bovina asistida',
      'Ecografía abdominal en perros y gatos',
      'Manejo del dolor crónico en mascotas',
    ],
  },
  {
    name: 'OdonTeck',
    description: 'Formación odontológica',
    base: 2490,
    courses: [
      'Actualización en odontología',
      'Endodoncia rotatoria paso a paso',
      'Ortodoncia interceptiva en niños',
      'Blanqueamiento dental seguro',
      'Fotografía clínica dental',
      'Periodoncia para el consultorio general',
      'Resinas estéticas en sector anterior',
      'Manejo de urgencias en el consultorio dental',
    ],
  },
  {
    name: 'Dermalysse',
    description: 'Formación en cuidado de la piel',
    base: 1690,
    courses: [
      'Fundamentos de la piel',
      'Protocolos faciales por tipo de piel',
      'Acné: abordaje integral',
      'Fotoprotección y manchas',
      'Aparatología básica en cabina',
      'Cuidado de la piel madura',
      'Atención a piel sensible y rosácea',
      'Cosmética profesional: ingredientes activos',
    ],
  },
  {
    name: 'FisioAvanza',
    description: 'Fisioterapia y rehabilitación',
    base: 2190,
    courses: [
      'Rehabilitación de hombro doloroso',
      'Fisioterapia deportiva: lesiones frecuentes',
      'Vendaje neuromuscular aplicado',
      'Suelo pélvico: evaluación y tratamiento',
      'Terapia manual en columna lumbar',
      'Rehabilitación post-quirúrgica de rodilla',
      'Electroterapia con criterio clínico',
      'Fisioterapia respiratoria en adultos',
    ],
  },
  {
    name: 'NutriLab Academy',
    description: 'Nutrición clínica y comunitaria',
    base: 1590,
    courses: [
      'Nutrición en diabetes tipo 2',
      'Planes de alimentación para deportistas',
      'Nutrición infantil: primeros mil días',
      'Manejo nutricional de la obesidad',
      'Suplementación con evidencia',
      'Nutrición en el adulto mayor',
      'Consulta nutricional en línea',
      'Etiquetado frontal y educación alimentaria',
    ],
  },
  {
    name: 'AgroCampo Formación',
    description: 'Producción agropecuaria',
    base: 1390,
    courses: [
      'Bioseguridad en granjas porcinas',
      'Manejo sanitario del ganado lechero',
      'Agricultura protegida: invernaderos',
      'Riego tecnificado para pequeños productores',
      'Sanidad apícola y manejo de colmenas',
      'Control integrado de plagas en hortalizas',
      'Fertilización por análisis de suelo',
      'Trazabilidad y buenas prácticas agrícolas',
    ],
  },
  {
    name: 'PsicoForma',
    description: 'Psicología aplicada',
    base: 1790,
    courses: [
      'Primeros auxilios psicológicos',
      'Intervención en crisis y duelo',
      'Terapia cognitivo conductual: herramientas básicas',
      'Evaluación psicológica infantil',
      'Manejo de la ansiedad en consulta',
      'Psicología del deporte',
      'Atención a víctimas de violencia',
      'Habilidades del terapeuta en línea',
    ],
  },
  {
    name: 'Enfermería Viva',
    description: 'Actualización para personal de enfermería',
    base: 1490,
    courses: [
      'Cuidados del paciente crítico',
      'Administración segura de medicamentos',
      'Manejo de heridas y estomas',
      'Reanimación cardiopulmonar básica y avanzada',
      'Cuidados paliativos en casa',
      'Control de infecciones hospitalarias',
      'Valoración de enfermería por patrones',
      'Atención del recién nacido sano',
    ],
  },
  {
    name: 'EduFinanzas',
    description: 'Finanzas y contabilidad práctica',
    base: 1290,
    courses: [
      'Contabilidad para no contadores',
      'Facturación electrónica y CFDI 4.0',
      'Finanzas personales con propósito',
      'Impuestos para profesionistas independientes',
      'Costos y precios para pequeños negocios',
      'Nómina y obligaciones patronales',
      'Excel financiero intermedio',
      'Crédito e inversión para emprendedores',
    ],
  },
  {
    name: 'Gestión Clínica Pro',
    description: 'Administración de clínicas y consultorios',
    base: 1990,
    courses: [
      'Administración de consultorios médicos',
      'Expediente clínico y normativa vigente',
      'Atención al paciente y experiencia de servicio',
      'Marketing ético para servicios de salud',
      'Agenda, cobranza e indicadores de la clínica',
      'Protección de datos personales en salud',
      'Liderazgo de equipos clínicos',
      'Calidad y seguridad del paciente',
    ],
  },
  {
    name: 'Estética Integral MX',
    description: 'Estética profesional',
    base: 1590,
    courses: [
      'Diseño de cejas y laminado',
      'Extensiones de pestañas: técnica clásica',
      'Micropigmentación: fundamentos',
      'Masaje relajante y drenaje linfático',
      'Manicura y uñas en gel profesional',
      'Depilación con cera y láser: protocolos',
      'Bioseguridad en cabina',
      'Atención y fidelización de clientas',
    ],
  },
  {
    name: 'PetGroom Academia',
    description: 'Estética y bienestar animal',
    base: 1190,
    courses: [
      'Estética canina básica',
      'Corte de raza: schnauzer y poodle',
      'Manejo de perros nerviosos en estética',
      'Baño medicado y cuidado de la piel',
      'Estética felina sin estrés',
      'Primeros auxilios en la estética',
      'Emprende tu estética canina',
      'Higiene dental y oídos en mascotas',
    ],
  },
  {
    name: 'LabClinic Formación',
    description: 'Laboratorio clínico',
    base: 1690,
    courses: [
      'Toma de muestras y fase preanalítica',
      'Hematología básica para laboratoristas',
      'Interpretación de química sanguínea',
      'Control de calidad en el laboratorio',
      'Uroanálisis y coprología',
      'Microbiología: cultivos frecuentes',
      'Bioseguridad en el laboratorio',
      'Banco de sangre: fundamentos',
    ],
  },
  {
    name: 'Mente Docente',
    description: 'Formación para docentes',
    base: 990,
    courses: [
      'Neuroeducación en el aula',
      'Evaluación formativa con rúbricas',
      'Inclusión educativa: estrategias prácticas',
      'Gestión del aula y convivencia',
      'Herramientas digitales para enseñar',
      'Lectoescritura inicial',
      'Pensamiento matemático en preescolar',
      'Planeación didáctica por proyectos',
    ],
  },
  {
    name: 'Bienestar Corporativo',
    description: 'Capacitación para empresas',
    base: 1490,
    courses: [
      'Prevención de riesgos psicosociales (NOM-035)',
      'Liderazgo para mandos medios',
      'Comunicación asertiva en equipos',
      'Atención al cliente con empatía',
      'Gestión del tiempo y prioridades',
      'Primeros auxilios en el centro de trabajo',
      'Igualdad y prevención del acoso laboral',
      'Inducción y cultura organizacional',
    ],
  },
];
