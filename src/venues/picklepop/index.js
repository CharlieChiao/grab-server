/**
 * PICKLE POP 球场(银豹 Pospal 后端) — 薄封装, 逻辑复用 _pospal/adapter.js 工厂。
 * 多店铺接入参考 funsport/index.js: 只需 venue.yml + 同样的三行封装。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { createPospalAdapter } from "../_pospal/adapter.js";

const venueFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "venue.yml");
const adapter = createPospalAdapter(yaml.load(fs.readFileSync(venueFile, "utf8")), { venueFile });

export default adapter;
export const { meta, riskProfile, ready, grab, preheat, buildGrabRequest, fireGrab, listSlots, interpretGrabResponse, classifyGrabResult, discoverCapture, riskProbe, saveRetryCalibration } = adapter;
