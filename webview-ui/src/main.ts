import { enableProdMode } from "@angular/core";

import { bootstrapApp } from "./bootstrap";
import { environment } from "./environments/environment";

if (environment.production) {
  enableProdMode();
}

bootstrapApp();
