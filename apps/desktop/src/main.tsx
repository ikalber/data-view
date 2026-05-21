import React from "react";
import ReactDOM from "react-dom/client";
import "@data-view/ui/styles.css";
import { App } from "./App";

// En WebKitGTK/WKWebView el menú nativo de la WebView se abre tapando los
// menús contextuales propios (Sidebar, EditableDataGrid, WorkspaceTabBar)
// aun cuando el handler de React llama a preventDefault sobre el target.
// Bloquearlo a nivel window asegura que solo se vea el menú custom.
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
