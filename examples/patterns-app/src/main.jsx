import { createRoot } from "react-dom/client";
import { AutoScale } from "react-autolocale";
import App from "./App.jsx";
createRoot(document.getElementById("root")).render(<AutoScale><App /></AutoScale>);
