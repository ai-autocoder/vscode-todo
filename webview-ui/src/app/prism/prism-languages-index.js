/** These foundational PrismJS language components are imported first due to dependencies required by other language components.
 * Importing them upfront prevents "undefined" errors related to trying to extend or use these languages before they are initialized.
 * This manual import list complements the auto-generated prism-languages.ts, ensuring all languages are available without import order issues.
 */
import "prismjs/components/prism-c.min.js";
import "prismjs/components/prism-cpp.min.js";
import "prismjs/components/prism-clike.min.js";
import "prismjs/components/prism-markup.min.js";
import "prismjs/components/prism-markdown.min.js";
import "prismjs/components/prism-csharp.min.js";
import "prismjs/components/prism-haskell.min.js";
import "prismjs/components/prism-javascript.min.js";
import "prismjs/components/prism-javadoclike.min.js";
import "prismjs/components/prism-typescript.min.js";
import "prismjs/components/prism-php.min.js";
import "prismjs/components/prism-css.min.js";
import "prismjs/components/prism-ruby.min.js";
import "prismjs/components/prism-rust.min.js";
import "prismjs/components/prism-sql.min.js";
import "prismjs/components/prism-scheme.min.js";
import "prismjs/components/prism-turtle.min.js";
import "prismjs/components/prism-t4-templating.min.js";
import "prismjs/components/prism-markup-templating.min.js";

// Additional languages to import
import "./prism-additional-languages.js";
