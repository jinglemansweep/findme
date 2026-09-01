import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";
import { fetchAppConfig } from "./config";

// maplibre v6 loads its worker from WORKER_URL as a same-origin module
// worker; scripts/copy-maplibre-vendor.mjs puts the matching files in
// web/public/vendor at build time.
setWorkerUrl("/vendor/maplibre-gl-worker.mjs");

const config = await fetchAppConfig();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App config={config} />
  </StrictMode>,
);
