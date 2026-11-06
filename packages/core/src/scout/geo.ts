/** Great-circle distance in miles (haversine, mean Earth radius 3958.8 mi). */
export function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Case- and suffix-insensitive county name ("Tarrant County" = "TARRANT"). */
export function normCounty(c: string | null | undefined): string {
  return (c ?? "").toUpperCase().replace(/\s+(COUNTY|PARISH|BOROUGH)$/, "").replace(/[^A-Z]/g, "");
}
