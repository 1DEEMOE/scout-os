/**
 * Seeds a local SAMPLE Peachtree Roofing org for the walkthrough.
 * All people, addresses, invoices and bookings are invented. Every customer-
 * facing record is labelled SAMPLE or loaded with demo:true.
 * Does not touch production, Render, or the shared scout_gaps databases.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closePool } from "@wos/db";
import {
  addFrontDeskSlots,
  analyzeIncomingDocument,
  configureEngine,
  createOrg,
  createTask,
  crmTools,
  enableFrontDesk,
  FakeCrmProvider,
  FakeInvoicingProvider,
  financeTools,
  frontDeskTools,
  forgeryTools,
  importProspects,
  inboxTools,
  inviteMember,
  listAvailability,
  listOpportunities,
  markEngaged,
  memoryTools,
  MockLedger,
  mockTools,
  ModelRouter,
  operatorSetPlan,
  provisionRecommendedAgents,
  recordPermission,
  requestBooking,
  reviewBusinessProfile,
  runScoutScan,
  saveBusinessProfile,
  scoutTools,
  stopBoss,
  syncInvoices,
  ToolRegistry,
  UnconfiguredProvider,
  uploadJobPhoto,
} from "@wos/core";
import { seedMorningBriefing } from "./briefing-seed";
import { evidenceDir } from "./evidence-dir";
import { withTenant } from "@wos/db";
import { getAuth } from "../src/server/auth";
import { resetDb } from "../../../packages/db/test/helpers";

const OUT = process.env.DEMO_DIR ? path.resolve(path.resolve(import.meta.dirname, "../../.."), process.env.DEMO_DIR) : evidenceDir("demo");
const PHOTO_DIR = process.env.WOS_JOB_PHOTO_DIR || path.join(OUT, "job-photos");
const EMAIL = process.env.DEMO_EMAIL || "jordan@peachtree.example.test";
const PASSWORD = process.env.DEMO_PASSWORD || "sample-peachtree-2026";
const CREW_EMAIL = "chris@peachtree.example.test";

mkdirSync(PHOTO_DIR, { recursive: true });
await resetDb();

const billing = new FakeInvoicingProvider();
const crm = new FakeCrmProvider();
const mailbox = async () => null;
configureEngine({
  router: new ModelRouter([new UnconfiguredProvider()], "none"),
  tools: new ToolRegistry().register(
    ...inboxTools(mailbox),
    ...crmTools(async () => crm),
    ...financeTools(async () => billing),
    ...memoryTools(),
    ...scoutTools(),
    ...frontDeskTools(),
    ...forgeryTools(),
    ...mockTools(new MockLedger()),
  ),
  mailbox,
  crm: async () => crm,
  invoicing: async () => billing,
});

const auth = getAuth();
const ownerUser = await auth.api.signUpEmail({ body: { name: "Jordan Hale", email: EMAIL, password: PASSWORD } });
const crewUser = await auth.api.signUpEmail({ body: { name: "Chris Walker", email: CREW_EMAIL, password: PASSWORD } });
const owner = ownerUser.user.id;
const crew = crewUser.user.id;

const { orgId } = await createOrg({ actorUserId: owner, name: "Peachtree Roofing" });
await inviteMember({ actorUserId: owner, orgId, email: CREW_EMAIL, role: "member" });
await operatorSetPlan(orgId, "scout_pro", "peachtree SAMPLE seed");
await provisionRecommendedAgents({ actorUserId: owner, orgId });

// Atlanta roofing profile + invented SAMPLE leads / storm reports.
await saveBusinessProfile({
  actorUserId: owner,
  orgId,
  profile: {
    vertical: "roofing",
    website: "",
    services: ["Roof inspection", "Roof repair", "Roof replacement", "Insurance claim photos"],
    idealCustomer: "SAMPLE: Homeowners in Fulton and DeKalb counties around Atlanta",
    serviceArea: {
      states: [],
      counties: [
        { state: "GA", county: "Fulton" },
        { state: "GA", county: "DeKalb" },
      ],
      center: { lat: 33.749, lon: -84.388 },
    },
    settings: { radiusMiles: 15, lookbackDays: 30, minScore: 30, monthlyDataCostCents: 0, averageJobValueCents: 1250000 },
  },
});
await reviewBusinessProfile({ actorUserId: owner, orgId });

const day = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
const storms = [
  "Time,F_Scale,Location,County,State,Lat,Lon,Comments",
  "2310,UNK,2 NE Inman Park,Fulton,GA,33.761,-84.352,Brief touchdown reported by spotter. (SAMPLE)",
  "Time,Speed,Location,County,State,Lat,Lon,Comments",
  "2140,72,Grant Park,Fulton,GA,33.735,-84.373,Measured gust at the park. (SAMPLE)",
  "0035,UNK,Old Fourth Ward,Fulton,GA,33.768,-84.366,Large limbs down on sidewalks. (SAMPLE)",
  "Time,Size,Location,County,State,Lat,Lon,Comments",
  "2045,175,Virginia-Highland,Fulton,GA,33.782,-84.354,Golf ball size hail. (SAMPLE)",
  "2110,125,Inman Park,Fulton,GA,33.757,-84.352,Half dollar size hail. (SAMPLE)",
  "2130,100,Midtown,Fulton,GA,33.784,-84.383,Quarter size hail. (SAMPLE)",
].join("\n");

const { uploadStormReports } = await import("@wos/core");
await uploadStormReports({
  actorUserId: owner,
  orgId,
  csv: storms,
  reportDay: day,
  demo: true,
});

const prospects = [
  "name,email,phone,address,city,county,state,zip,lat,lon",
  "Denise Harper,denise.harper@example.test,404-555-0147,412 Seminole Ave,Atlanta,Fulton,GA,30312,33.7565,-84.3520",
  "Marcus Bell,marcus.bell@example.test,404-555-0188,88 Oakdale Rd NE,Atlanta,Fulton,GA,30307,33.7621,-84.3498",
  "Priya Nair,priya.nair@example.test,404-555-0112,215 North Highland Ave,Atlanta,Fulton,GA,30307,33.7638,-84.3524",
  "James Whitaker,james.whitaker@example.test,404-555-0164,640 Park Dr NE,Atlanta,Fulton,GA,30306,33.7735,-84.3651",
  "Sofia Alvarez,sofia.alvarez@example.test,404-555-0190,1022 Monroe Dr NE,Atlanta,Fulton,GA,30306,33.7820,-84.3538",
  "Tom Chen,tom.chen@example.test,404-555-0133,55 Ralph McGill Blvd,Atlanta,Fulton,GA,30308,33.7689,-84.3752",
].join("\n");
await importProspects({
  actorUserId: owner,
  orgId,
  csv: prospects,
  label: "SAMPLE Peachtree homeowners",
  usageRights: "Invented SAMPLE records for trying Scout OS. Not real people.",
  attest: true,
  demo: true,
});
await recordPermission({
  actorUserId: owner,
  orgId,
  email: "denise.harper@example.test",
  basis: "existing_customer",
  evidence: "SAMPLE: gutter and flashing repair customer in 2025",
});

await withTenant(orgId, (tx) => runScoutScan(tx, orgId, { type: "system", id: "peachtree-sample" }));
const denise = (await listOpportunities({ actorUserId: owner, orgId })).find((o) => o.prospect.name === "Denise Harper");
if (denise) {
  await markEngaged({
    actorUserId: owner,
    orgId,
    opportunityId: denise.id,
    evidence: "SAMPLE: called the office asking about an inspection after the hail storm.",
  });
}

// Invoices: overdue, current, and paid — all labelled SAMPLE.
const addInv = (
  id: string,
  name: string,
  email: string,
  cents: number,
  due: string,
  status: "open" | "paid" = "open",
) =>
  billing.invoices.set(id, {
    externalId: id,
    number: `PR-${id.slice(-3)}-SAMPLE`,
    customerName: `SAMPLE: ${name}`,
    customerEmail: email,
    status,
    amountDueCents: cents,
    currency: "usd",
    dueDate: due,
  });
addInv("in_110", "Brookhaven HOA", "bills@brookhaven-hoa.example.test", 845000, "2026-10-12");
addInv("in_111", "Marcus Bell", "marcus.bell@example.test", 1220000, "2026-10-20");
addInv("in_112", "Priya Nair", "priya.nair@example.test", 480000, "2026-11-20");
addInv("in_113", "James Whitaker", "james.whitaker@example.test", 975000, "2026-10-01", "paid");
await syncInvoices({ actorUserId: owner, orgId });

// Flagged incoming invoice (domain mismatch, unknown bank, altered PDF, amount outlier).
const flagged = await analyzeIncomingDocument({
  actorUserId: owner,
  orgId,
  kind: "invoice",
  vendorName: "SAMPLE: Apex Materials LLC",
  vendorEmail: "billing@apex-materia1s.example",
  expectedDomain: "apexmaterials.example",
  documentNumber: "APX-4401-SAMPLE",
  amountCents: 4_750_000,
  accountLast4: "9911",
  senderDomain: "apex-materia1s.example",
  pdfMetadata: {
    producer: "Photoshop",
    creator: "edited",
    createDate: "2026-10-01T12:00:00Z",
    modDate: "2026-11-04T08:15:00Z",
  },
});

// Front desk: a person booking (one-click approve) + an AI-assistant booking.
const desk = await enableFrontDesk({
  actorUserId: owner,
  orgId,
  displayName: "Peachtree Roofing front desk (SAMPLE)",
  timezone: "America/New_York",
  disclosure: "SAMPLE channel: bookings are reviewed by a person before they are confirmed. AI assistants must identify themselves.",
});
const slotAStart = new Date(Date.now() + 48 * 3600_000);
const slotAEnd = new Date(slotAStart.getTime() + 3600_000);
const slotBStart = new Date(Date.now() + 52 * 3600_000);
const slotBEnd = new Date(slotBStart.getTime() + 3600_000);
await addFrontDeskSlots({
  actorUserId: owner,
  orgId,
  channelId: desk.channelId,
  slots: [
    { startsAt: slotAStart, endsAt: slotAEnd },
    { startsAt: slotBStart, endsAt: slotBEnd },
  ],
});
const avail = await listAvailability(desk.publicToken, new Date(), new Date(Date.now() + 14 * 86_400_000));
if (avail.slots.length < 2) throw new Error(`expected 2 front-desk slots, got ${avail.slots.length}`);
const personBooking = await requestBooking({
  publicToken: desk.publicToken,
  slotId: avail.slots[0]!.id,
  requesterKind: "person",
  disclosureAck: true,
  customerName: "SAMPLE: Wayne Cole",
  customerEmail: "wayne.cole@example.test",
  customerPhone: "404-555-0175",
  notes: "SAMPLE: homeowner asked for a leak inspection this week.",
  sourceIp: "203.0.113.21",
});
const aiBooking = await requestBooking({
  publicToken: desk.publicToken,
  slotId: avail.slots[1]!.id,
  requesterKind: "ai_agent",
  agentName: "Ava",
  agentProvider: "Homeowner Helper (SAMPLE)",
  disclosureAck: true,
  customerName: "SAMPLE: Denise Harper",
  customerEmail: "denise.harper@example.test",
  customerPhone: "404-555-0147",
  notes: "SAMPLE: Ava (an AI assistant) requested a roof inspection after last week's hail.",
  sourceIp: "203.0.113.22",
});

// A job with tamper-evident photos (and one edited re-upload so the flag is visible).
const job = await createTask({
  actorUserId: owner,
  orgId,
  intent: "SAMPLE: Photograph hail damage at 412 Seminole Ave for the insurance claim",
  title: "SAMPLE: Hail claim photos · 412 Seminole Ave",
});

function makePng(color: string, filename: string): Buffer {
  const dest = path.join(PHOTO_DIR, filename);
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x480:d=0.2`, "-frames:v", "1", dest], { stdio: "ignore" });
  return readFileSync(dest);
}
const overview = makePng("0x5c4033", "roof-overview-sample.png");
const hail = makePng("0x8b5a2b", "hail-closeup-sample.png");
const hailEdited = makePng("0xc4a484", "hail-closeup-edited-sample.png");
const capture = new Date(Date.now() - 2 * 86_400_000);
const photo1 = await uploadJobPhoto({
  actorUserId: crew,
  orgId,
  jobId: job.taskId,
  filename: "roof-overview-sample.png",
  contentType: "image/png",
  bytes: overview,
  captureAt: capture,
  gpsLat: 33.7565,
  gpsLng: -84.352,
});
const photo2 = await uploadJobPhoto({
  actorUserId: crew,
  orgId,
  jobId: job.taskId,
  filename: "hail-closeup-sample.png",
  contentType: "image/png",
  bytes: hail,
  captureAt: new Date(capture.getTime() + 10 * 60_000),
  gpsLat: 33.7566,
  gpsLng: -84.3519,
});
const photo3 = await uploadJobPhoto({
  actorUserId: crew,
  orgId,
  jobId: job.taskId,
  filename: "hail-closeup-sample.png",
  contentType: "image/png",
  bytes: hailEdited,
  captureAt: new Date(capture.getTime() + 15 * 60_000),
  gpsLat: 33.7566,
  gpsLng: -84.3519,
});

// Generated from everything seeded above, so the demo's Today opens on a filled-in briefing.
await seedMorningBriefing({ actorUserId: owner, orgId, timezone: "America/New_York" });

await stopBoss();
await closePool();

const info = {
  orgId,
  jobId: job.taskId,
  ownerId: owner,
  crewId: crew,
  email: EMAIL,
  crewEmail: CREW_EMAIL,
  password: PASSWORD,
  flaggedDocumentId: flagged.documentId,
  flaggedRiskFlags: flagged.riskFlags,
  personBookingId: personBooking.bookingId,
  aiBookingId: aiBooking.bookingId,
  photos: [photo1, photo2, photo3],
  note: "All records are invented SAMPLE data for a local walkthrough. Not a live business.",
};
writeFileSync(path.join(OUT, "seed-info.json"), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
