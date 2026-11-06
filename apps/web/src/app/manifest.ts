import type { MetadataRoute } from "next";
import { BRAND } from "@/brand";

/** Lets people add Scout OS to a phone's home screen. Nothing to install from a store. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.promise,
    start_url: "/orgs",
    scope: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#17616a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
