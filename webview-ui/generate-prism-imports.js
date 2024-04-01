const fs = require("fs");
const path = require("path");

const componentsDir = path.join(__dirname, "node_modules", "prismjs", "components");
const outputPath = path.join(__dirname, "src", "app", "prism", "prism-additional-languages.js");

// List of foundational languages to exclude
const excludeLanguages = [
	"prism-c.min.js",
	"prism-cpp.min.js",
	"prism-clike.min.js",
	"prism-markup.min.js",
	"prism-markdown.min.js",
	"prism-csharp.min.js",
	"prism-haskell.min.js",
	"prism-javascript.min.js",
	"prism-javadoclike.min.js",
	"prism-typescript.min.js",
	"prism-php.min.js",
	"prism-css.min.js",
	"prism-ruby.min.js",
	"prism-rust.min.js",
	"prism-sql.min.js",
	"prism-scheme.min.js",
	"prism-turtle.min.js",
	"prism-t4-templating.min.js",
	"prism-markup-templating.min.js",
];

// Filter function to identify language files
const isLanguageFile = (file) =>
	file.startsWith("prism-") &&
	file.endsWith(".min.js") &&
	!file.includes("core") &&
	!excludeLanguages.includes(file);

fs.readdir(componentsDir, (err, files) => {
	if (err) {
		console.error("Error reading PrismJS components directory:", err);
		return;
	}

	const imports = files
		.filter(isLanguageFile)
		.map((file) => `import 'prismjs/components/${file}';`)
		.join("\n");

	const outputContent = `// Auto-generated file. Do not edit directly.\n${imports}\n`;

	fs.writeFile(outputPath, outputContent, (err) => {
		if (err) {
			console.error("Error writing Prism languages import file:", err);
		} else {
			console.log(`Prism languages import file generated successfully at ${outputPath}`);
		}
	});
});
