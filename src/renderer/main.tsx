import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
import "@fontsource-variable/vazirmatn";

import { App } from "./App";
import { installDevelopmentDesktopBridge } from "./devDesktop";
import "./styles.css";
import { selectWindowRoute } from "./windowRoute";

installDevelopmentDesktopBridge();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <App route={selectWindowRoute(window.location.search)} />
  </StrictMode>,
);
