import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "./index.css";
import App from "./App";

// Suppress browser default right-click menu ("名前を付けて保存", "印刷", etc.)
window.addEventListener(
  "contextmenu",
  (e) => {
    const target = e.target as HTMLElement | null;
    const isTextInput =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (!isTextInput) {
      e.preventDefault();
    }
  },
  { capture: true },
);

// Prevent browser image dragging
window.addEventListener(
  "dragstart",
  (e) => {
    e.preventDefault();
  },
  { capture: true },
);

// Suppress browser-specific Save / Print / Reload shortcuts
window.addEventListener(
  "keydown",
  (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === "s" || key === "p" || key === "u")) {
      e.preventDefault();
    }
    if (e.key === "F5") {
      e.preventDefault();
    }
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
