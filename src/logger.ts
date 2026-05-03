import pino from "pino";
import { getConfig } from "./config.js";

const cfg = getConfig();

export const logger = pino({
  level: cfg.LOG_LEVEL,
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
});
