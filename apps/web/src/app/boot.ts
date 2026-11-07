/**
 * Inline scripts that run in <head> before first paint. Kept out of the
 * client components so the server layout imports plain strings.
 */
export const THEME_KEY = "scout-theme";
export const TEXT_KEY = "scout-text";
export const RAIL_KEY = "scout-sidebar-rail";

/** Theme: the page never flashes the wrong theme. */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;var s=localStorage.getItem("${TEXT_KEY}");if(s==="large"||s==="larger")document.documentElement.dataset.text=s;}catch(e){}})();`;

/** Desktop icon rail: the sidebar never flashes wide before collapsing. */
export const NAV_BOOT = `(function(){try{if(localStorage.getItem("${RAIL_KEY}")==="1")document.documentElement.dataset.rail="1";}catch(e){}})();`;
