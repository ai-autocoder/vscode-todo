// Karma configuration file, see link for more information
// https://karma-runner.github.io/1.0/config/configuration-file.html
//
// The Angular builder (@angular/build:karma) injects its own framework and the
// build plugin, so this file only carries user-level config: reporters, the
// coverage output, and browser launchers (including a headless CI launcher).

module.exports = function (config) {
	config.set({
		basePath: "",
		frameworks: ["jasmine"],
		plugins: [
			require("karma-jasmine"),
			require("karma-chrome-launcher"),
			require("karma-jasmine-html-reporter"),
			require("karma-coverage"),
		],
		client: {
			jasmine: {
				// you can add configuration options for Jasmine here
				// the possible options are listed at https://jasmine.github.io/api/edge/Configuration.html
			},
			clearContext: false, // leave Jasmine Spec Runner output visible in browser
		},
		jasmineHtmlReporter: {
			suppressAll: true, // removes the duplicated traces
		},
		coverageReporter: {
			dir: require("path").join(__dirname, "./coverage/my-app"),
			subdir: ".",
			reporters: [{ type: "html" }, { type: "text-summary" }],
		},
		reporters: ["progress", "kjhtml"],
		port: 9876,
		colors: true,
		logLevel: config.LOG_INFO,
		autoWatch: true,
		browsers: ["Chrome"],
		// Headless, no-sandbox launcher for CI / sandboxed runs (npm run test:ci).
		customLaunchers: {
			ChromeHeadlessCI: {
				base: "ChromeHeadless",
				flags: ["--no-sandbox", "--disable-gpu"],
			},
		},
		singleRun: false,
		restartOnFileChange: true,
	});
};
