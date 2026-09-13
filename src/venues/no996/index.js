import { createAipaikeAdapter } from "../_aipaike/adapter.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = yaml.load(fs.readFileSync(path.join(__dirname, "venue.yml"), "utf8"));

export default createAipaikeAdapter(cfg);
