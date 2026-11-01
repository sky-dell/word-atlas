import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/source-serif-4";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AccountController } from "./account/state";
import "./styles/app.css";
import "./styles/parity.css";
import {enableTemporaryGuests} from './store/profileStorage';

enableTemporaryGuests();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountController />
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => null);
  });
}
