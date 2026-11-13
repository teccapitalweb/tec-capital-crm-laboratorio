// La escalera publicada (PRAGMA user_version 3…41). Está CERRADA: aquí no se añade nada.
// Todo cambio de esquema nuevo es una migración con nombre en server/migrations/named/<área>/ (ver named.mjs).
// Las versiones 1 y 2 las crea openDatabase (server/database.mjs).
import { migrateCRM } from '../crm.mjs';
import { migrateFollowup } from '../followup.mjs';
import { migrateCatalogue } from '../catalogue-schema.mjs';
import { migrateOperations, migrateHolidays } from '../operations-schema.mjs';
import { migrateAutomation, migrateRecipes } from '../automation-schema.mjs';
import { migrateContacts, migrateConsent } from '../contacts-schema.mjs';
import { migrateMfa } from '../mfa-schema.mjs';
import { migrateReplies } from '../replies-schema.mjs';
import { migrateSimulator } from '../simulator-schema.mjs';
import { migrateChannel } from '../channel-schema.mjs';
import { migratePayments } from '../payments-schema.mjs';
import { migrateConnectors } from '../connectors-schema.mjs';
import { migrateEvaluation } from '../evaluation-schema.mjs';
import { migrateCoordination } from '../coordination-schema.mjs';
import { migrateFinance } from '../finance-schema.mjs';
import { migratePersons } from '../persons-schema.mjs';
import { migrateCertificates } from '../certificates-schema.mjs';
import { migrateContent } from '../content-schema.mjs';
import { migrateAcademics } from '../academics-schema.mjs';
import { migrateLegacy } from '../legacy-schema.mjs';
import { migrateCampaigns } from '../campaigns-schema.mjs';
import { migratePush } from '../push-schema.mjs';
import { migrateQuickReplies } from '../quickreplies-schema.mjs';
import { migrateAds } from '../ads-schema.mjs';
import { migrateAllies } from '../allies-schema.mjs';
import { migrateSummaries } from '../summaries-schema.mjs';
import { migrateScheduled, migrateScheduledMaterial } from '../scheduled-schema.mjs';
import { migrateAppointments } from '../appointments-schema.mjs';
import { migrateCoupons, migrateCouponEntry } from '../coupons-schema.mjs';
import { migrateIntegrations } from '../integrations-schema.mjs';
import { migrateWhatsApp, migrateWhatsAppTemplates, migrateWhatsAppMulti } from '../whatsapp-schema.mjs';
import { migrateFlows } from '../flows-schema.mjs';

export const LADDER = Object.freeze([
  [3, migrateCRM],
  [4, migrateFollowup],
  [5, migrateCatalogue],
  [6, migrateOperations],
  [7, migrateAutomation],
  [8, migrateRecipes],
  [9, migrateContacts],
  [10, migrateConsent],
  [11, migrateHolidays],
  [12, migrateMfa],
  [13, migrateReplies],
  [14, migrateSimulator],
  [15, migrateChannel],
  [16, migratePayments],
  [17, migrateConnectors],
  [18, migrateEvaluation],
  [19, migrateCoordination],
  [20, migrateFinance],
  [21, migratePersons],
  [22, migrateCertificates],
  [23, migrateContent],
  [24, migrateAcademics],
  [25, migrateLegacy],
  [26, migrateCampaigns],
  [27, migratePush],
  [28, migrateQuickReplies],
  [29, migrateAds],
  [30, migrateAllies],
  [31, migrateSummaries],
  [32, migrateScheduled],
  [33, migrateAppointments],
  [34, migrateCoupons],
  [35, migrateIntegrations],
  [36, migrateCouponEntry],
  [37, migrateScheduledMaterial],
  [38, migrateWhatsApp],
  [39, migrateWhatsAppTemplates],
  [40, migrateFlows],
  [41, migrateWhatsAppMulti],
]);

export const LADDER_VERSION = LADDER.at(-1)[0];

// Cada peldaño se salta solo si la base ya lo tiene, así que se puede llamar sobre una base en cualquier versión.
export function runLadder(db) {
  for (const [, run] of LADDER) run(db);
}
