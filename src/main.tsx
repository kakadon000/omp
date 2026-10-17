import { createRoot } from "react-dom/client";
import App from "./App";

// web demo flag — CSS + components use it to hide window controls etc.
if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
  document.documentElement.classList.add("web");
}

createRoot(document.getElementById("root")!).render(<App />);
