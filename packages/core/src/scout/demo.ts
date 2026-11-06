import { withTenant } from "@wos/db";
import { markEngaged, recordPermission } from "./lifecycle";
import { importProspects, listOpportunities, reviewBusinessProfile, runScoutScan, saveBusinessProfile, uploadStormReports } from "./service";

/**
 * SEEDS AND DEMOS ONLY. Not exposed through the API. Loads clearly labelled
 * sample data (every row flagged demo, every source named "(DEMO)") so the
 * Scout screens can be tried. People and addresses are invented
 * (example.test domains); storm reports are synthetic, dated a few days ago.
 */
export async function loadScoutDemo(input: { actorUserId: string; orgId: string }) {
  const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  const spc = [
    "Time,F_Scale,Location,County,State,Lat,Lon,Comments",
    "2340,UNK,4 NE Wylie,Collin,TX,33.05,-96.49,Brief touchdown reported by spotter. (DEMO)",
    "Time,Speed,Location,County,State,Lat,Lon,Comments",
    "2215,70,Mesquite,Dallas,TX,32.77,-96.60,Measured gust at school. (DEMO)",
    "0040,UNK,Rowlett,Dallas,TX,32.90,-96.56,Large limbs down. (DEMO)",
    "Time,Size,Location,County,State,Lat,Lon,Comments",
    "2105,175,2 W Richardson,Dallas,TX,32.95,-96.76,Golf ball size hail. (DEMO)",
    "2120,125,Garland,Dallas,TX,32.91,-96.64,Half dollar size hail. (DEMO)",
    "2150,075,Plano,Collin,TX,33.02,-96.70,Penny size hail. (DEMO)",
  ].join("\n");
  const prospects = [
    "name,email,phone,address,city,county,state,zip,lat,lon",
    "Maria Alvarez,maria.alvarez@example.test,214-555-0101,12 Cedar Ln,Richardson,Dallas,TX,75080,32.957,-96.745",
    "James Okafor,james.okafor@example.test,214-555-0102,48 Birch Ct,Garland,Dallas,TX,75040,32.915,-96.632",
    "Priya Shah,priya.shah@example.test,,7 Willow Way,Rowlett,Dallas,TX,75088,32.903,-96.551",
    "Tom Becker,,972-555-0104,301 Elm St,Mesquite,Dallas,TX,75149,,",
    "Linda Nguyen,linda.nguyen@example.test,,90 Oak Hollow,Plano,Collin,TX,75023,33.031,-96.712",
    "Carlos Ruiz,carlos.ruiz@example.test,,5 Pecan Dr,Wylie,Collin,TX,75098,33.041,-96.505",
    "Grace Kim,grace.kim@example.test,,22 Lakeview,Austin,Travis,TX,78701,30.27,-97.74",
  ].join("\n");
  await saveBusinessProfile({ ...input, profile: {
    vertical: "roofing", website: "", services: ["Roof inspection", "Roof repair", "Roof replacement"], idealCustomer: "Homeowners in Dallas and Collin counties (DEMO)",
    serviceArea: { states: [], counties: [{ state: "TX", county: "Dallas" }, { state: "TX", county: "Collin" }], center: null },
    settings: { radiusMiles: 10, lookbackDays: 30, minScore: 30, monthlyDataCostCents: 15000, averageJobValueCents: 950000 },
  } });
  await reviewBusinessProfile(input);
  await uploadStormReports({ ...input, csv: spc, reportDay: day, demo: true });
  await importProspects({ ...input, csv: prospects, label: "Sample homeowners", usageRights: "Invented sample records for trying Scout. Not real people.", attest: true, demo: true });
  await recordPermission({ ...input, email: "james.okafor@example.test", basis: "existing_customer", evidence: "DEMO: gutter repair customer in 2024" });
  const scan = await withTenant(input.orgId, (tx) => runScoutScan(tx, input.orgId, { type: "system", id: "demo" }));
  const james = (await listOpportunities(input)).find((o) => o.prospect.name === "James Okafor");
  if (james) await markEngaged({ ...input, opportunityId: james.id, evidence: "DEMO: called the office asking about an inspection after the storm." });
  return scan;
}
