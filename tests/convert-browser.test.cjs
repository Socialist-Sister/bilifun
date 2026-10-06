// Runs the complete fast-MP4 regression suite plus the WASM-specific cases.
process.env.TEST_CONVERT = "1";
require("./browser-remux.test.cjs");
